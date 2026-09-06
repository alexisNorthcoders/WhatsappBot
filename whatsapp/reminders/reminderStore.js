import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getCursorCliRepoRoot } from '../agents/cursorCliAgent.js';

const FILE = 'reminders.json';
const SCHEMA_VERSION = 1;

/**
 * @typedef {'pending' | 'fired' | 'cancelled'} ReminderStatus
 * @typedef {{
 *   id: number,
 *   chatId: string,
 *   actorId: string | null,
 *   createdAt: number,
 *   dueAt: number,
 *   text: string,
 *   status: ReminderStatus,
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
    ? o.reminders.filter(isValidReminder)
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
    (status === 'pending' || status === 'fired' || status === 'cancelled') &&
    (o.firedAt == null || (typeof o.firedAt === 'number' && Number.isFinite(o.firedAt)))
  );
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
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
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
  const store = await readReminderStore(filePath);
  const reminder = {
    id: store.nextId,
    chatId: opts.chatId,
    actorId: opts.actorId ?? null,
    createdAt: opts.createdAt ?? Date.now(),
    dueAt: opts.dueAt,
    text: String(opts.text ?? '').trim(),
    status: /** @type {const} */ ('pending'),
    firedAt: null,
  };
  store.nextId += 1;
  store.reminders.push(reminder);
  await writeReminderStore(store, filePath);
  return reminder;
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
 * Atomically claim a pending reminder for delivery (pending → fired).
 * Returns the claimed reminder, or null if it was already claimed/cancelled.
 * @param {number} id
 * @param {number} [firedAtMs]
 * @param {string} [filePath]
 * @returns {Promise<Reminder | null>}
 */
export async function claimReminderFired(id, firedAtMs = Date.now(), filePath = remindersStorePath()) {
  const store = await readReminderStore(filePath);
  const rem = store.reminders.find((r) => r.id === id);
  if (!rem || rem.status !== 'pending') return null;
  rem.status = 'fired';
  rem.firedAt = firedAtMs;
  await writeReminderStore(store, filePath);
  return rem;
}
