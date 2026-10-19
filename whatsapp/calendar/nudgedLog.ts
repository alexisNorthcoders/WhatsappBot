import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getRepoRoot } from '../repoRoot.ts';

/**
 * The nudged log: the only local Reminder state (ADR 0002). One entry per
 * (event id, occurrence start, alert offset) that has been Nudged, kept until the occurrence
 * ends. Entries are written before sending, so a crash mid-send never re-sends.
 */
export type NudgedEntry = { endMs: number };

export type NudgedLogData = { version: 1; entries: Record<string, NudgedEntry> };

export function nudgedLogPath(): string {
  const fromEnv = process.env.CALENDAR_NUDGED_LOG_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getRepoRoot(), 'logs', 'reminders', 'nudged.json');
}

/**
 * @param startMs occurrence start
 * @param offset alert offset, minutes before start (or a label for a
 *   fixed-time all-day Nudge)
 */
export function nudgeKey(eventId: string, startMs: number, offset: number | string) {
  return `${eventId}|${new Date(startMs).toISOString()}|${offset}`;
}

export async function readNudgedLog(filePath: string): Promise<NudgedLogData> {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
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
 */
export async function writeNudgedLog(filePath: string, data: NudgedLogData) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Drop entries whose occurrence has ended.
 * @returns entries removed
 */
export function pruneEndedNudges(data: NudgedLogData, nowMs: number): number {
  let removed = 0;
  for (const [key, entry] of Object.entries(data.entries)) {
    if (!(entry?.endMs > nowMs)) {
      delete data.entries[key];
      removed += 1;
    }
  }
  return removed;
}
