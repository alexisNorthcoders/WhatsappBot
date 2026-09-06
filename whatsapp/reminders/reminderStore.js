import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getCursorCliRepoRoot } from '../agents/cursorCliAgent.js';

const FILE = 'reminders.json';
const SCHEMA_VERSION = 2;
const LOCK_MAX_ATTEMPTS = 80;
const LOCK_RETRY_MS_MIN = 15;
const LOCK_RETRY_MS_MAX = 40;

/** Default cap for list replies (WhatsApp-friendly). */
export const REMINDER_LIST_LIMIT = 20;

/**
 * How long a reminder may stay in `delivering` before restart recovery
 * finalizes it as fired without re-send (at-most-once after a crash mid-send).
 * Only applies when this process is *not* still actively sending that id
 * (see {@link markReminderDeliveryInFlight}).
 */
export const STALE_DELIVERING_MS = 2 * 60_000;

/**
 * Reminder ids this process is currently sending. Prevents
 * {@link settleStaleDeliveries} from finalizing an in-flight send when
 * `deliveryAttemptAt` ages past {@link STALE_DELIVERING_MS} (slow network /
 * backpressure). Cleared on process exit — crash recovery still settles.
 * @type {Set<number>}
 */
const localInFlightDeliveries = new Set();

/**
 * @param {number} id
 */
export function markReminderDeliveryInFlight(id) {
  if (typeof id === 'number' && Number.isInteger(id)) localInFlightDeliveries.add(id);
}

/**
 * @param {number} id
 */
export function clearReminderDeliveryInFlight(id) {
  localInFlightDeliveries.delete(id);
}

/**
 * @param {number} id
 * @returns {boolean}
 */
export function isReminderDeliveryInFlightLocally(id) {
  return localInFlightDeliveries.has(id);
}

/** Test helper: drop process-local in-flight markers. */
export function clearAllReminderDeliveryInFlightForTests() {
  localInFlightDeliveries.clear();
}

/**
 * @typedef {'pending' | 'delivering' | 'fired' | 'cancelled'} ReminderStatus
 * @typedef {{
 *   id: number,
 *   chatId: string,
 *   actorId: string | null,
 *   createdAt: number,
 *   dueAt: number,
 *   text: string,
 *   status: ReminderStatus,
 *   deliveryAttemptAt: number | null,
 *   firedAt: number | null,
 * }} Reminder
 * @typedef {{ version: number, nextId: number, reminders: Reminder[] }} ReminderStoreData
 */

/**
 * @returns {string}
 */
export function remindersStorePath() {
  const fromEnv = process.env.REMINDERS_STORE_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getCursorCliRepoRoot(), 'logs', 'reminders', FILE);
}

/**
 * @returns {ReminderStoreData}
 */
function emptyStore() {
  return { version: SCHEMA_VERSION, nextId: 1, reminders: [] };
}

/**
 * @param {unknown} raw
 * @returns {ReminderStoreData}
 */
function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  const o = /** @type {Record<string, unknown>} */ (raw);
  const nextId =
    typeof o.nextId === 'number' && Number.isInteger(o.nextId) && o.nextId >= 1
      ? o.nextId
      : 1;
  const reminders = Array.isArray(o.reminders)
    ? o.reminders.filter(isValidReminder).map((r) => normalizeReminder(/** @type {Reminder} */ (r)))
    : [];
  return { version: SCHEMA_VERSION, nextId, reminders: /** @type {Reminder[]} */ (reminders) };
}

/**
 * @param {unknown} r
 * @returns {r is Reminder}
 */
function isValidReminder(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = /** @type {Record<string, unknown>} */ (r);
  const status = o.status;
  const attemptOk =
    o.deliveryAttemptAt == null ||
    (typeof o.deliveryAttemptAt === 'number' && Number.isFinite(o.deliveryAttemptAt));
  return (
    typeof o.id === 'number' &&
    Number.isInteger(o.id) &&
    o.id >= 1 &&
    typeof o.chatId === 'string' &&
    o.chatId.length > 0 &&
    (o.actorId == null || typeof o.actorId === 'string') &&
    typeof o.createdAt === 'number' &&
    Number.isFinite(o.createdAt) &&
    typeof o.dueAt === 'number' &&
    Number.isFinite(o.dueAt) &&
    typeof o.text === 'string' &&
    (status === 'pending' ||
      status === 'delivering' ||
      status === 'fired' ||
      status === 'cancelled') &&
    attemptOk &&
    (o.firedAt == null || (typeof o.firedAt === 'number' && Number.isFinite(o.firedAt)))
  );
}

/**
 * Normalize a stored reminder (v1 rows lack deliveryAttemptAt).
 * @param {Reminder} r
 * @returns {Reminder}
 */
function normalizeReminder(r) {
  return {
    ...r,
    deliveryAttemptAt:
      typeof r.deliveryAttemptAt === 'number' && Number.isFinite(r.deliveryAttemptAt)
        ? r.deliveryAttemptAt
        : null,
  };
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exclusive file lock via O_EXCL create (cross-process).
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withStoreLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EEXIST') {
        const jitter =
          LOCK_RETRY_MS_MIN +
          Math.floor(Math.random() * (LOCK_RETRY_MS_MAX - LOCK_RETRY_MS_MIN + 1));
        await sleep(jitter);
        continue;
      }
      throw e;
    }

    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }

  throw new Error(`reminder store lock timeout: ${lockPath}`);
}

/**
 * @param {string} [filePath]
 * @returns {Promise<ReminderStoreData>}
 */
export async function readReminderStore(filePath = remindersStorePath()) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return emptyStore();
  }
  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    return emptyStore();
  }
}

/**
 * Atomic write (temp file + rename). Prefer calling under withStoreLock for RMW.
 * @param {ReminderStoreData} data
 * @param {string} [filePath]
 */
export async function writeReminderStore(data, filePath = remindersStorePath()) {
  const payload = {
    version: SCHEMA_VERSION,
    nextId: data.nextId,
    reminders: data.reminders,
    savedAt: new Date().toISOString(),
  };
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(payload, null, 2);
  await fs.writeFile(tmpPath, body, 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * @param {{
 *   chatId: string,
 *   actorId?: string | null,
 *   dueAt: number,
 *   text: string,
 *   createdAt?: number,
 *   filePath?: string,
 * }} opts
 * @returns {Promise<Reminder>}
 */
export async function addReminder(opts) {
  const filePath = opts.filePath ?? remindersStorePath();
  return withStoreLock(filePath, async () => {
    const store = await readReminderStore(filePath);
    const reminder = {
      id: store.nextId,
      chatId: opts.chatId,
      actorId: opts.actorId ?? null,
      createdAt: opts.createdAt ?? Date.now(),
      dueAt: opts.dueAt,
      text: String(opts.text ?? '').trim(),
      status: /** @type {const} */ ('pending'),
      deliveryAttemptAt: null,
      firedAt: null,
    };
    store.nextId += 1;
    store.reminders.push(reminder);
    await writeReminderStore(store, filePath);
    return reminder;
  });
}

/**
 * Pending reminders that are due (dueAt <= nowMs), oldest first.
 * @param {number} [nowMs]
 * @param {string} [filePath]
 * @returns {Promise<Reminder[]>}
 */
export async function listDuePendingReminders(nowMs = Date.now(), filePath = remindersStorePath()) {
  const store = await readReminderStore(filePath);
  return store.reminders
    .filter((r) => r.status === 'pending' && r.dueAt <= nowMs)
    .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
}

/**
 * Upcoming pending reminders (any dueAt), soonest first.
 * When chatId is set, only that chat’s reminders are returned (no cross-chat leak).
 * Results are capped (default {@link REMINDER_LIST_LIMIT}) so WhatsApp replies stay readable.
 * @param {{
 *   chatId?: string,
 *   filePath?: string,
 *   limit?: number,
 * }} [opts]
 * @returns {Promise<{ reminders: Reminder[], total: number, limit: number }>}
 */
export async function listPendingReminders(opts = {}) {
  const filePath = opts.filePath ?? remindersStorePath();
  const limit =
    typeof opts.limit === 'number' && Number.isInteger(opts.limit) && opts.limit > 0
      ? opts.limit
      : REMINDER_LIST_LIMIT;
  const store = await readReminderStore(filePath);
  const all = store.reminders
    .filter(
      (r) =>
        r.status === 'pending' && (opts.chatId == null || r.chatId === opts.chatId)
    )
    .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
  return {
    reminders: all.slice(0, limit),
    total: all.length,
    limit,
  };
}

/**
 * Atomically cancel a pending reminder (pending → cancelled).
 * When chatId is set, only cancels if the reminder belongs to that chat.
 * Returns the cancelled reminder, or null if missing / wrong chat / not pending.
 *
 * Safe vs delivery: cancel and {@link claimReminderDelivery} both re-read under the same
 * store lock and only transition from `pending`. A due row already loaded by
 * {@link listDuePendingReminders} cannot fire after cancel — claim returns null.
 * In-flight `delivering` rows cannot be cancelled (delivery already claimed).
 * @param {number} id
 * @param {{
 *   chatId?: string,
 *   filePath?: string,
 * }} [opts]
 * @returns {Promise<Reminder | null>}
 */
export async function cancelReminder(id, opts = {}) {
  const filePath = opts.filePath ?? remindersStorePath();
  return withStoreLock(filePath, async () => {
    const store = await readReminderStore(filePath);
    const rem = store.reminders.find((r) => r.id === id);
    if (!rem || rem.status !== 'pending') return null;
    if (opts.chatId != null && rem.chatId !== opts.chatId) return null;
    rem.status = 'cancelled';
    rem.deliveryAttemptAt = null;
    await writeReminderStore(store, filePath);
    return { ...rem };
  });
}

/**
 * Atomically claim a pending reminder for delivery (pending → delivering).
 * Records deliveryAttemptAt so crashes/retries can settle without duplicate sends.
 * Returns the claimed reminder, or null if it was already claimed/cancelled/fired.
 * @param {number} id
 * @param {number} [attemptAtMs]
 * @param {string} [filePath]
 * @returns {Promise<Reminder | null>}
 */
export async function claimReminderDelivery(
  id,
  attemptAtMs = Date.now(),
  filePath = remindersStorePath()
) {
  return withStoreLock(filePath, async () => {
    const store = await readReminderStore(filePath);
    const rem = store.reminders.find((r) => r.id === id);
    if (!rem || rem.status !== 'pending') return null;
    rem.status = 'delivering';
    rem.deliveryAttemptAt = attemptAtMs;
    await writeReminderStore(store, filePath);
    markReminderDeliveryInFlight(id);
    return { ...rem };
  });
}

/**
 * Refresh deliveryAttemptAt while a send is still in progress (heartbeat).
 * Extends the stale window for crash recovery without allowing settle while
 * {@link isReminderDeliveryInFlightLocally} is true.
 * @param {number} id
 * @param {number} [atMs]
 * @param {string} [filePath]
 * @returns {Promise<Reminder | null>}
 */
export async function touchReminderDelivery(
  id,
  atMs = Date.now(),
  filePath = remindersStorePath()
) {
  return withStoreLock(filePath, async () => {
    const store = await readReminderStore(filePath);
    const rem = store.reminders.find((r) => r.id === id);
    if (!rem || rem.status !== 'delivering') return null;
    rem.deliveryAttemptAt = atMs;
    await writeReminderStore(store, filePath);
    markReminderDeliveryInFlight(id);
    return { ...rem };
  });
}

/**
 * Mark a delivering reminder as successfully sent (delivering → fired).
 * @param {number} id
 * @param {number} [firedAtMs]
 * @param {string} [filePath]
 * @returns {Promise<Reminder | null>}
 */
export async function completeReminderDelivery(
  id,
  firedAtMs = Date.now(),
  filePath = remindersStorePath()
) {
  try {
    return await withStoreLock(filePath, async () => {
      const store = await readReminderStore(filePath);
      const rem = store.reminders.find((r) => r.id === id);
      if (!rem || rem.status !== 'delivering') return null;
      rem.status = 'fired';
      rem.firedAt = firedAtMs;
      await writeReminderStore(store, filePath);
      return { ...rem };
    });
  } finally {
    clearReminderDeliveryInFlight(id);
  }
}

/**
 * Release a failed delivery claim so a later tick can retry (delivering → pending).
 * Call **only** for known pre-send failures (scheduler `ReminderPreSendError`).
 * Never release after an uncertain send error — that risks duplicate delivery.
 * @param {number} id
 * @param {string} [filePath]
 * @returns {Promise<Reminder | null>}
 */
export async function releaseReminderDelivery(id, filePath = remindersStorePath()) {
  try {
    return await withStoreLock(filePath, async () => {
      const store = await readReminderStore(filePath);
      const rem = store.reminders.find((r) => r.id === id);
      if (!rem || rem.status !== 'delivering') return null;
      rem.status = 'pending';
      rem.deliveryAttemptAt = null;
      await writeReminderStore(store, filePath);
      return { ...rem };
    });
  } finally {
    clearReminderDeliveryInFlight(id);
  }
}

/**
 * After a crash mid-send, `delivering` rows may be stuck. Finalize stale ones as
 * fired without re-sending (at-most-once). Skips ids this process is still
 * actively sending (local in-flight marker), even if deliveryAttemptAt is old.
 * @param {number} [nowMs]
 * @param {{
 *   staleMs?: number,
 *   filePath?: string,
 * }} [opts]
 * @returns {Promise<number>} count finalized
 */
export async function settleStaleDeliveries(nowMs = Date.now(), opts = {}) {
  const filePath = opts.filePath ?? remindersStorePath();
  const staleMs =
    typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs >= 0
      ? opts.staleMs
      : STALE_DELIVERING_MS;

  return withStoreLock(filePath, async () => {
    const store = await readReminderStore(filePath);
    let settled = 0;
    for (const rem of store.reminders) {
      if (rem.status !== 'delivering') continue;
      // Never finalize a send still running in this process.
      if (isReminderDeliveryInFlightLocally(rem.id)) continue;
      const attemptedAt =
        typeof rem.deliveryAttemptAt === 'number' && Number.isFinite(rem.deliveryAttemptAt)
          ? rem.deliveryAttemptAt
          : 0;
      if (nowMs - attemptedAt < staleMs) continue;
      rem.status = 'fired';
      rem.firedAt = nowMs;
      settled += 1;
    }
    if (settled > 0) await writeReminderStore(store, filePath);
    return settled;
  });
}

/**
 * @deprecated Legacy one-shot claim (pending → fired). **Not** used by the
 * production delivery path — prefer {@link claimReminderDelivery} +
 * {@link completeReminderDelivery}. Kept only for older tests / callers that
 * need a direct fire without a delivering window. Do not use for sends.
 * @param {number} id
 * @param {number} [firedAtMs]
 * @param {string} [filePath]
 * @returns {Promise<Reminder | null>}
 */
export async function claimReminderFired(id, firedAtMs = Date.now(), filePath = remindersStorePath()) {
  return withStoreLock(filePath, async () => {
    const store = await readReminderStore(filePath);
    const rem = store.reminders.find((r) => r.id === id);
    if (!rem || rem.status !== 'pending') return null;
    rem.status = 'fired';
    rem.deliveryAttemptAt = firedAtMs;
    rem.firedAt = firedAtMs;
    await writeReminderStore(store, filePath);
    return { ...rem };
  });
}
