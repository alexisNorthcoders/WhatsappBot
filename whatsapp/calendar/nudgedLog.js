import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getRepoRoot } from '../repoRoot.js';

/**
 * The nudged log: the only local Reminder state (ADR 0002). One entry per
 * (event id, occurrence start, alert offset) that has been Nudged, kept until the occurrence
 * ends. Entries are written before sending, so a crash mid-send never re-sends.
 *
 * @typedef {{ endMs: number }} NudgedEntry
 * @typedef {{ version: 1, entries: Record<string, NudgedEntry> }} NudgedLogData
 */

/** @returns {string} */
export function nudgedLogPath() {
  const fromEnv = process.env.CALENDAR_NUDGED_LOG_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getRepoRoot(), 'logs', 'reminders', 'nudged.json');
}

/**
 * @param {string} eventId
 * @param {number} startMs occurrence start
 * @param {number} offsetMin alert offset, minutes before start
 */
export function nudgeKey(eventId, startMs, offsetMin) {
  return `${eventId}|${new Date(startMs).toISOString()}|${offsetMin}`;
}

/**
 * @param {string} filePath
 * @returns {Promise<NudgedLogData>}
 */
export async function readNudgedLog(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') {
      return { version: 1, entries: {} };
    }
    throw e;
  }
  const parsed = JSON.parse(raw);
  const entries =
    parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
  return { version: 1, entries };
}

/**
 * Atomic write (tmp + rename) so a crash never leaves a half-written log.
 * @param {string} filePath
 * @param {NudgedLogData} data
 */
export async function writeNudgedLog(filePath, data) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Drop entries whose occurrence has ended.
 * @param {NudgedLogData} data
 * @param {number} nowMs
 * @returns {number} entries removed
 */
export function pruneEndedNudges(data, nowMs) {
  let removed = 0;
  for (const [key, entry] of Object.entries(data.entries)) {
    if (!(entry?.endMs > nowMs)) {
      delete data.entries[key];
      removed += 1;
    }
  }
  return removed;
}
