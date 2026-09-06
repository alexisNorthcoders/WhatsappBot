import {
  claimReminderDelivery,
  completeReminderDelivery,
  listDuePendingReminders,
  releaseReminderDelivery,
  remindersStorePath,
  settleStaleDeliveries,
  touchReminderDelivery,
} from './reminderStore.js';

const DEFAULT_POLL_MS = 30_000;
/** Heartbeat interval while a send is in progress (keeps crash-recovery window fresh). */
const DELIVERY_HEARTBEAT_MS = 30_000;

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;

/**
 * Thrown when the outbound send definitely did not happen (no socket, missing
 * sendMessage, etc.). Safe to {@link releaseReminderDelivery} and retry.
 */
export class ReminderPreSendError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ReminderPreSendError';
    /** @type {'pre_send'} */
    this.phase = 'pre_send';
  }
}

/**
 * @param {unknown} e
 * @returns {e is ReminderPreSendError}
 */
export function isReminderPreSendError(e) {
  return (
    e instanceof ReminderPreSendError ||
    (Boolean(e) &&
      typeof e === 'object' &&
      /** @type {{ phase?: unknown }} */ (e).phase === 'pre_send')
  );
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Format outbound reminder body.
 * @param {{ text: string, dueAt?: number, nowMs?: number }} opts
 */
export function formatDeliveryMessage(opts) {
  const text = String(opts.text ?? '').trim() || '(no text)';
  const nowMs = opts.nowMs ?? Date.now();
  const dueAt = opts.dueAt;
  const late =
    typeof dueAt === 'number' && Number.isFinite(dueAt) && nowMs - dueAt > 2 * 60_000;
  return late ? `Reminder (late): ${text}` : `Reminder: ${text}`;
}

/**
 * Run sendText while refreshing deliveryAttemptAt so a crash mid-send still
 * has a recent timestamp; local in-flight markers already block settle.
 * @param {number} id
 * @param {string} filePath
 * @param {() => Promise<unknown>} sendFn
 */
async function sendWithHeartbeat(id, filePath, sendFn) {
  const heartbeat = setInterval(() => {
    void touchReminderDelivery(id, Date.now(), filePath).catch(() => {});
  }, DELIVERY_HEARTBEAT_MS);
  try {
    return await sendFn();
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Deliver all due pending reminders with restart-safe, at-most-once semantics:
 * 1. Finalize stale `delivering` rows from a prior crash (no re-send), skipping
 *    ids still in-flight in this process.
 * 2. Claim pending → delivering (records deliveryAttemptAt + local in-flight).
 * 3. Send under the ack contract:
 *    - resolve → delivering → fired
 *    - {@link ReminderPreSendError} → release for retry
 *    - any other throw → finalize fired (message may have been accepted)
 *
 * listDue is a snapshot; {@link claimReminderDelivery} re-reads under lock so a
 * concurrent cancel (pending → cancelled) cannot still deliver.
 * @param {{
 *   sendText: (chatId: string, text: string) => Promise<unknown>,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   nowMs?: number,
 *   filePath?: string,
 *   staleMs?: number,
 * }} deps
 * @returns {Promise<{ delivered: number, failed: number, settledStale: number, uncertain: number }>}
 */
export async function runReminderDeliveryTick(deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const filePath = deps.filePath ?? remindersStorePath();
  const settledStale = await settleStaleDeliveries(nowMs, {
    filePath,
    staleMs: deps.staleMs,
  });
  if (settledStale > 0) {
    deps.logger?.info?.({ settledStale }, 'reminders: settled stale delivering rows');
  }

  const due = await listDuePendingReminders(nowMs, filePath);
  let delivered = 0;
  let failed = 0;
  let uncertain = 0;

  for (const rem of due) {
    // Authoritative gate: skip if cancelled/already claimed since listDue.
    const claimed = await claimReminderDelivery(rem.id, nowMs, filePath);
    if (!claimed) continue;
    const body = formatDeliveryMessage({
      text: claimed.text,
      dueAt: claimed.dueAt,
      nowMs,
    });
    try {
      await sendWithHeartbeat(claimed.id, filePath, () =>
        deps.sendText(claimed.chatId, body)
      );
      const completed = await completeReminderDelivery(claimed.id, nowMs, filePath);
      if (!completed) {
        // Claim disappeared (unexpected); do not retry — avoid duplicates.
        deps.logger?.warn?.(
          { id: claimed.id, chatId: claimed.chatId },
          'reminder send ok but complete failed (left non-pending)'
        );
      }
      delivered += 1;
      deps.logger?.info?.({ id: claimed.id, chatId: claimed.chatId }, 'reminder delivered');
    } catch (e) {
      if (isReminderPreSendError(e)) {
        failed += 1;
        await releaseReminderDelivery(claimed.id, filePath);
        deps.logger?.warn?.(
          { err: errMsg(e), id: claimed.id, chatId: claimed.chatId },
          'reminder delivery pre-send failed (released for retry)'
        );
      } else {
        // Send may have been accepted; finalize without retry (at-most-once).
        uncertain += 1;
        await completeReminderDelivery(claimed.id, nowMs, filePath);
        deps.logger?.warn?.(
          { err: errMsg(e), id: claimed.id, chatId: claimed.chatId },
          'reminder delivery uncertain after send error (finalized, no retry)'
        );
      }
    }
  }

  return { delivered, failed, settledStale, uncertain };
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseEnvInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string | undefined} raw
 */
function truthyEnv(raw) {
  const v = String(raw || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Restart-safe poller for due reminders.
 * Runs an immediate tick on start so overdue reminders from downtime are
 * delivered within one short window after reconnect (not only after pollMs).
 * Clears any existing interval first so reconnect / tests do not stack pollers.
 * Concurrent ticks are serialized via `inFlight` (stop does not clear it while
 * a tick is still running — reconnect cannot overlap a live send).
 * @param {{
 *   getSocket: () => import('@whiskeysockets/baileys').WASocket | null | undefined,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   pollMs?: number,
 *   filePath?: string,
 * }} opts
 */
export function startReminderScheduler(opts) {
  const { getSocket, logger } = opts;
  stopReminderScheduler();
  if (truthyEnv(process.env.REMINDERS_DISABLE)) {
    logger?.info?.('reminders: disabled (REMINDERS_DISABLE)');
    return;
  }

  const pollMs = Number.isFinite(opts.pollMs)
    ? opts.pollMs
    : parseEnvInt(process.env.REMINDERS_POLL_MS, DEFAULT_POLL_MS);
  const filePath = opts.filePath ?? remindersStorePath();

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const sock = getSocket?.();
      if (!sock?.sendMessage) return;
      await runReminderDeliveryTick({
        sendText: async (chatId, text) => {
          const live = getSocket?.();
          if (!live?.sendMessage) {
            throw new ReminderPreSendError('socket unavailable before send');
          }
          // Resolve ⇒ accepted by client stack; throw ⇒ uncertain (may be accepted).
          await live.sendMessage(chatId, { text });
        },
        logger,
        filePath,
      });
    } catch (e) {
      logger?.warn?.({ err: errMsg(e) }, 'reminder scheduler tick failed');
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => {
    void tick();
  }, pollMs);
  // Catch up overdue reminders immediately after restart / reconnect.
  void tick();
  logger?.info?.({ pollMs, filePath }, 'reminders: scheduler started');
}

/**
 * Stop the singleton interval (connection close / tests / restart).
 * Does **not** clear `inFlight` — a tick still running keeps the concurrency
 * guard until its `finally`, so reconnect cannot start a second overlapping tick.
 */
export function stopReminderScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/** @returns {boolean} whether a delivery tick is currently running */
export function isReminderSchedulerTickInFlight() {
  return inFlight;
}

/** Test helper: force-clear the tick guard after stop. */
export function resetReminderSchedulerInFlightForTests() {
  inFlight = false;
}
