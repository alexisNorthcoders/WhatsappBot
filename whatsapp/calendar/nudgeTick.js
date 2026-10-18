import {
  nudgeKey,
  nudgedLogPath,
  pruneEndedNudges,
  readNudgedLog,
  writeNudgedLog,
} from './nudgedLog.js';

/** @typedef {import('./calendarPort.js').CalendarEvent} CalendarEvent */
/** @typedef {import('./calendarPort.js').CalendarPort} CalendarPort */

const MIN = 60_000;
/** Google's longest notification is 4 weeks before start; look that far ahead. */
export const NUDGE_LOOKAHEAD_MS = 28 * 24 * 60 * MIN + MIN;

/**
 * Alert offsets (minutes before start) for a timed Reminder, deduped.
 * @param {CalendarEvent} event
 * @param {number[]} defaultOffsetsMin
 * @returns {number[]}
 */
export function alertOffsetsFor(event, defaultOffsetsMin) {
  const n = event.notifications;
  const raw =
    n?.mode === 'explicit' ? n.offsetsMin : n?.mode === 'none' ? [] : defaultOffsetsMin;
  return [...new Set(raw.filter((m) => Number.isFinite(m) && m >= 0))];
}

/**
 * @param {number} deltaMs start minus now
 */
export function formatHowFar(deltaMs) {
  const abs = Math.abs(deltaMs);
  const mins = Math.round(abs / MIN);
  if (mins < 1) return 'starting now';
  const days = Math.floor(mins / (24 * 60));
  const hours = Math.floor((mins % (24 * 60)) / 60);
  const rest = mins % 60;
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} h`);
  if (rest && !days) parts.push(`${rest} min`);
  const span = parts.join(' ');
  return deltaMs > 0 ? `in ${span}` : `started ${span} ago`;
}

/**
 * @param {number} ms
 * @param {string} timeZone
 */
function formatStart(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/**
 * One Reminder's lines in a Nudge.
 * @param {CalendarEvent} event
 * @param {{ nowMs: number, timeZone: string }} opts
 */
export function formatNudgeBlock(event, { nowMs, timeZone }) {
  const lines = [
    String(event.title || '').trim() || '(no title)',
    `${formatStart(event.startMs, timeZone)} (${formatHowFar(event.startMs - nowMs)})`,
  ];
  const location = String(event.location || '').trim();
  if (location) lines.push(`📍 ${location}`);
  const firstLine = String(event.description || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (firstLine) lines.push(firstLine);
  return lines.join('\n');
}

/**
 * @param {CalendarEvent[]} events
 * @param {{ nowMs: number, timeZone: string }} opts
 */
export function formatNudgeMessage(events, opts) {
  if (events.length === 1) return `⏰ Reminder: ${formatNudgeBlock(events[0], opts)}`;
  return [
    `⏰ ${events.length} reminders:`,
    ...events.map((e) => formatNudgeBlock(e, opts)),
  ].join('\n\n');
}

/**
 * @param {unknown} e
 */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One nudge tick: Nudge every timed Reminder occurrence whose Alert time has arrived and
 * that hasn't ended, at most once per (event, occurrence start, alert offset).
 *
 * Alert times are recomputed from the calendar each tick, so an event moved or deleted in
 * Google never Nudges at its old time. Alerts that came due while the bot was down are still
 * sent if the occurrence hasn't ended. Everything due in one tick goes out as one message per
 * recipient. Nudged-log entries are written before sending (at-most-once), and entries for
 * ended occurrences are pruned.
 *
 * @param {{
 *   calendar: CalendarPort,
 *   ownerChatId: string,
 *   sendText: (chatId: string, text: string) => Promise<unknown>,
 *   nowMs?: number,
 *   logPath?: string,
 *   logger?: { info?: Function, warn?: Function },
 * }} deps
 * @returns {Promise<{ nudged: number, messages: number, pruned: number }>}
 */
export async function runNudgeTick(deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const logPath = deps.logPath ?? nudgedLogPath();
  const settings = await deps.calendar.getSettings();
  const events = await deps.calendar.listEvents({
    timeMinMs: nowMs,
    timeMaxMs: nowMs + NUDGE_LOOKAHEAD_MS,
  });

  const log = await readNudgedLog(logPath);
  const pruned = pruneEndedNudges(log, nowMs);

  /** @type {CalendarEvent[]} */
  const due = [];
  for (const event of events) {
    if (event.allDay) continue;
    if (event.responseStatus === 'declined') continue;
    if (!(event.endMs > nowMs)) continue;
    let eventDue = false;
    for (const offsetMin of alertOffsetsFor(event, settings.defaultOffsetsMin)) {
      if (event.startMs - offsetMin * MIN > nowMs) continue;
      const key = nudgeKey(event.id, event.startMs, offsetMin);
      if (log.entries[key]) continue;
      log.entries[key] = { endMs: event.endMs };
      eventDue = true;
    }
    if (eventDue) due.push(event);
  }

  if (due.length > 0 || pruned > 0) await writeNudgedLog(logPath, log);
  if (due.length === 0) return { nudged: 0, messages: 0, pruned };

  const text = formatNudgeMessage(due, { nowMs, timeZone: settings.timeZone });
  let messages = 0;
  try {
    await deps.sendText(deps.ownerChatId, text);
    messages += 1;
    deps.logger?.info?.({ nudged: due.length }, 'calendar nudges: sent');
  } catch (e) {
    // Already logged as nudged: at-most-once, no retry.
    deps.logger?.warn?.(
      { err: errMsg(e), nudged: due.length },
      'calendar nudges: send failed (not retried)'
    );
  }
  return { nudged: due.length, messages, pruned };
}
