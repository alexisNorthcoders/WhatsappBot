import {
  nudgeKey,
  nudgedLogPath,
  pruneEndedNudges,
  readNudgedLog,
  writeNudgedLog,
} from './nudgedLog.ts';
import type { CalendarEvent, CalendarPort } from './calendarPort.ts';
import type { Logger } from '../types.ts';

type FormatOpts = { nowMs: number; timeZone: string };


const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Google's longest notification is 4 weeks before start; look that far ahead. */
export const NUDGE_LOOKAHEAD_MS = 28 * DAY + MIN;
/** All-day Reminders without overrides Nudge at this local time (minutes after midnight). */
export const DEFAULT_ALL_DAY_NUDGE_MIN = 9 * 60;
/** Nudged-log offset for the fixed-time Nudge of an all-day Reminder without overrides. */
const ALL_DAY_NUDGE_OFFSET = 'allday';

/**
 * `HH:MM` (24 h) → minutes after midnight, or null when malformed.
 */
export function parseAllDayNudgeTime(raw: string | undefined) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * How far `timeZone`'s wall clock is ahead of UTC at `ms`.
 */
function zoneOffsetMs(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, Number(p.value)])
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant `timeZone`'s wall clock reads `date` at `minutes` after midnight.
 * @param date `YYYY-MM-DD`
 */
export function zonedTimeMs(date: string, minutes: number, timeZone: string) {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * MIN;
  const guess = wall - zoneOffsetMs(wall, timeZone);
  // Re-check at the guess, in case a DST change lies between it and the wall time.
  return wall - zoneOffsetMs(guess, timeZone);
}

/**
 * `YYYY-MM-DD` in `timeZone` at `ms`.
 */
export function zonedDate(ms: number, timeZone: string) {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

/**
 * A Reminder occurrence's real span: all-day dates are local midnights in the calendar's
 * timezone, not the UTC midnights the port carries in `startMs`/`endMs`.
 */
export function occurrenceSpan(event: CalendarEvent, timeZone: string) {
  if (!event.allDay || !event.startDate) return { startMs: event.startMs, endMs: event.endMs };
  const startMs = zonedTimeMs(event.startDate, 0, timeZone);
  const endMs = event.endDate ? zonedTimeMs(event.endDate, 0, timeZone) : startMs + DAY;
  return { startMs, endMs };
}

/**
 * Alert offsets (minutes before start) for a timed Reminder, deduped.
 */
export function alertOffsetsFor(event: CalendarEvent, defaultOffsetsMin: number[]): number[] {
  const n = event.notifications;
  const raw =
    n?.mode === 'explicit' ? n.offsetsMin : n?.mode === 'none' ? [] : defaultOffsetsMin;
  return [...new Set(raw.filter((m) => Number.isFinite(m) && m >= 0))];
}

/**
 * A Reminder's Alert times: each with its nudged-log offset and the instant it's due.
 * All-day overrides count back from local midnight of the first day (as Google does); an
 * all-day Reminder on default notifications Nudges once at `allDayNudgeMin` that day, since
 * Google doesn't expose the all-day defaults.
 */
export function alertTimesFor(
  event: CalendarEvent,
  { defaultOffsetsMin, timeZone, allDayNudgeMin }: {
    defaultOffsetsMin: number[];
    timeZone: string;
    allDayNudgeMin: number;
  },
): { offset: number | string; atMs: number }[] {
  if (event.allDay && event.startDate && event.notifications?.mode === 'default') {
    return [
      { offset: ALL_DAY_NUDGE_OFFSET, atMs: zonedTimeMs(event.startDate, allDayNudgeMin, timeZone) },
    ];
  }
  const { startMs } = occurrenceSpan(event, timeZone);
  return alertOffsetsFor(event, defaultOffsetsMin).map((offset) => ({
    offset,
    atMs: startMs - offset * MIN,
  }));
}

/**
 * @param deltaMs start minus now
 */
export function formatHowFar(deltaMs: number) {
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

function formatStart(ms: number, timeZone: string) {
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
 * @param date `YYYY-MM-DD`
 */
function formatDate(date: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * "Mon 19 Oct (all day, today)", or a date range for multi-day Reminders.
 */
function formatAllDayWhen(event: CalendarEvent & { startDate: string }, { nowMs, timeZone }: FormatOpts) {
  const startDay = Date.parse(`${event.startDate}T00:00:00Z`);
  const endDay = event.endDate ? Date.parse(`${event.endDate}T00:00:00Z`) : startDay + DAY;
  const lastDate = new Date(endDay - DAY).toISOString().slice(0, 10);
  const daysAway = Math.round((startDay - Date.parse(`${zonedDate(nowMs, timeZone)}T00:00:00Z`)) / DAY);
  const howFar =
    daysAway <= 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`;
  const range =
    lastDate > event.startDate
      ? `${formatDate(event.startDate)} – ${formatDate(lastDate)}`
      : formatDate(event.startDate);
  return `${range} (all day, ${howFar})`;
}

/**
 * One Reminder's lines in a Nudge.
 */
export function formatNudgeBlock(event: CalendarEvent, { nowMs, timeZone }: FormatOpts) {
  const when =
    event.allDay && event.startDate
      ? formatAllDayWhen(event as CalendarEvent & { startDate: string }, { nowMs, timeZone })
      : `${formatStart(event.startMs, timeZone)} (${formatHowFar(event.startMs - nowMs)})`;
  const lines = [String(event.title || '').trim() || '(no title)', when];
  const location = String(event.location || '').trim();
  if (location) lines.push(`📍 ${location}`);
  const firstLine = String(event.description || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (firstLine) lines.push(firstLine);
  return lines.join('\n');
}

export function formatNudgeMessage(events: CalendarEvent[], opts: FormatOpts) {
  if (events.length === 1) return `⏰ Reminder: ${formatNudgeBlock(events[0], opts)}`;
  return [
    `⏰ ${events.length} reminders:`,
    ...events.map((e) => formatNudgeBlock(e, opts)),
  ].join('\n\n');
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

type NudgeTickDeps = {
  calendar: CalendarPort;
  ownerChatId: string;
  creatorChatId?: (creatorActorId: string) => string | null;
  sendText: (chatId: string, text: string) => Promise<unknown>;
  nowMs?: number;
  allDayNudgeMin?: number;
  logPath?: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
};

/**
 * Who gets which due Reminders: the owner gets all of them; a Reminder the bot created for
 * someone else (`creatorChatId` maps its recorded creator to a chat) goes to that chat too.
 */
function nudgesByRecipient(
  due: CalendarEvent[],
  { ownerChatId, creatorChatId }: Pick<NudgeTickDeps, 'ownerChatId' | 'creatorChatId'>,
): Map<string, CalendarEvent[]> {
  const byChat = new Map([[ownerChatId, [...due]]]);
  for (const event of due) {
    if (!event.createdByBot || !event.creatorActorId || !creatorChatId) continue;
    const chatId = creatorChatId(event.creatorActorId);
    if (!chatId || chatId === ownerChatId) continue;
    byChat.set(chatId, [...(byChat.get(chatId) ?? []), event]);
  }
  return byChat;
}

/**
 * One nudge tick: Nudge every Reminder occurrence (timed or all-day, see `alertTimesFor`)
 * whose Alert time has arrived and that hasn't ended, at most once per (event, occurrence
 * start, alert offset).
 *
 * Alert times are recomputed from the calendar each tick, so an event moved or deleted in
 * Google never Nudges at its old time. Alerts that came due while the bot or Google was
 * unreachable are still sent if the occurrence hasn't ended, and dropped (counted in
 * `dropped`) if it has. Everything due in one tick goes out as one message per recipient:
 * the owner, plus the creator of a Reminder the bot made for someone else (SECOND_PHONE, via
 * `creatorChatId`).
 * Nudged-log entries are written before sending (at-most-once), and entries for ended
 * occurrences are pruned.
 */
export async function runNudgeTick(
  deps: NudgeTickDeps,
): Promise<{ nudged: number; messages: number; pruned: number; dropped: number }> {
  const nowMs = deps.nowMs ?? Date.now();
  const logPath = deps.logPath ?? nudgedLogPath();
  const allDayNudgeMin = deps.allDayNudgeMin ?? DEFAULT_ALL_DAY_NUDGE_MIN;
  const settings = await deps.calendar.getSettings();
  const { timeZone } = settings;
  const events = await deps.calendar.listEvents({
    timeMinMs: nowMs,
    timeMaxMs: nowMs + NUDGE_LOOKAHEAD_MS,
  });

  const log = await readNudgedLog(logPath);
  let changed = false;
  let dropped = 0;

  const due: CalendarEvent[] = [];
  for (const event of events) {
    if (event.responseStatus === 'declined') continue;
    const { endMs } = occurrenceSpan(event, timeZone);
    const ended = !(endMs > nowMs);
    let eventDue = false;
    const alertTimes = alertTimesFor(event, {
      defaultOffsetsMin: settings.defaultOffsetsMin,
      timeZone,
      allDayNudgeMin,
    });
    for (const { offset, atMs } of alertTimes) {
      if (atMs > nowMs) continue;
      const key = nudgeKey(event.id, event.startMs, offset);
      const existing = log.entries[key];
      if (ended) {
        // Overdue for a Reminder that's already over: dropped, and recorded as handled until
        // the calendar stops listing it (all-day events can outlive their local end there).
        if (!existing) {
          log.entries[key] = { endMs: Math.max(endMs, event.endMs) };
          dropped += 1;
        }
        continue;
      }
      if (existing) {
        // Track the current end so an extended event isn't pruned (and re-nudged) early.
        if (existing.endMs !== endMs) {
          existing.endMs = endMs;
          changed = true;
        }
        continue;
      }
      log.entries[key] = { endMs };
      eventDue = true;
    }
    if (eventDue) due.push(event);
  }

  const pruned = pruneEndedNudges(log, nowMs);
  if (due.length > 0 || dropped > 0 || pruned > 0 || changed) await writeNudgedLog(logPath, log);
  if (dropped > 0) deps.logger?.info({ dropped }, 'calendar nudges: dropped, Reminder already ended');
  if (due.length === 0) return { nudged: 0, messages: 0, pruned, dropped };

  let messages = 0;
  for (const [chatId, events] of nudgesByRecipient(due, deps)) {
    try {
      await deps.sendText(chatId, formatNudgeMessage(events, { nowMs, timeZone }));
      messages += 1;
      deps.logger?.info({ nudged: events.length }, 'calendar nudges: sent');
    } catch (e) {
      // Already logged as nudged: at-most-once, no retry.
      deps.logger?.warn(
        { err: errMsg(e), nudged: events.length },
        'calendar nudges: send failed (not retried)'
      );
    }
  }
  return { nudged: due.length, messages, pruned, dropped };
}
