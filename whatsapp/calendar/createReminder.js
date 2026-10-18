/**
 * Create a Reminder on the Owner's calendar from a WhatsApp message (#127). The extraction
 * function turns text into fields; the rules after extraction live here:
 * - no end → the default duration (15 minutes)
 * - `kind: 'remind'` → one Alert time, at the start
 * - `kind: 'appointment'` → the calendar's default notifications
 * - explicit `alertOffsetsMin` → overrides both
 * - a start in the past → refused, nothing created
 */

import { zonedTimeMs } from './nudgeTick.js';

/** @typedef {import('./calendarPort.js').CalendarPort} CalendarPort */
/** @typedef {import('./calendarPort.js').CalendarEvent} CalendarEvent */
/** @typedef {import('./calendarPort.js').CalendarNotifications} CalendarNotifications */
/** @typedef {import('./reminderExtraction.js').ExtractReminder} ExtractReminder */

export const DEFAULT_DURATION_MIN = 15;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const CALENDAR_UNREACHABLE_REPLY =
  "Couldn't reach Google Calendar, so nothing was created. Please try again in a minute.";

/**
 * @param {string} local `YYYY-MM-DDTHH:MM`
 * @param {string} timeZone
 */
function localDateTimeMs(local, timeZone) {
  const [date, time] = local.split('T');
  const [h, m] = time.split(':').map(Number);
  return zonedTimeMs(date, h * 60 + m, timeZone);
}

/**
 * @param {string} date `YYYY-MM-DD`
 * @param {number} days
 */
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/**
 * @param {number} ms
 * @param {string} timeZone
 */
function localDate(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms)
  );
}

/**
 * @param {number} ms
 * @param {string} timeZone
 */
function formatDay(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(ms)
  );
}

/**
 * @param {number} ms
 * @param {string} timeZone
 */
function formatClock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(ms)
  );
}

/**
 * 15 → "15 min", 60 → "1 hr", 90 → "1 hr 30 min", 1440 → "1 day".
 * @param {number} min
 */
export function formatMinutes(min) {
  if (min > 0 && min % (24 * 60) === 0) {
    const d = min / (24 * 60);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  const h = Math.floor(min / 60);
  const m = min % 60;
  const parts = [];
  if (h) parts.push(`${h} hr`);
  if (m || !h) parts.push(`${m} min`);
  return parts.join(' ');
}

/**
 * One Alert time, e.g. "14:00 (1 hr before)" or "Thu 23 Oct 23:00 (1 hr before)".
 * @param {number} startMs
 * @param {number} offsetMin
 * @param {string} timeZone
 */
function formatAlert(startMs, offsetMin, timeZone) {
  const at = startMs - offsetMin * MIN;
  const day = localDate(at, timeZone) === localDate(startMs, timeZone) ? '' : `${formatDay(at, timeZone)} `;
  const rel = offsetMin === 0 ? 'at the start' : `${formatMinutes(offsetMin)} before`;
  return `${day}${formatClock(at, timeZone)} (${rel})`;
}

/**
 * @param {CalendarEvent} event
 * @param {{ timeZone: string, defaultOffsetsMin: number[], allDayNudgeMin?: number }} settings
 * @param {number | null} listNumber the event's number in the chat's last list, or null when
 *   there is no list to cancel from (the reply then omits the number and the cancel hint)
 */
export function formatCreatedReply(event, settings, listNumber) {
  const { timeZone } = settings;
  const lines = [`Added to your calendar${listNumber == null ? '' : ` (#${listNumber})`}: ${event.title}`];
  /** @type {number} */
  let alertBaseMs;
  if (event.allDay) {
    const startDate = /** @type {string} */ (event.startDate);
    const endDate = event.endDate ?? addDays(startDate, 1);
    const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY);
    const startMs = Date.parse(`${startDate}T12:00:00Z`);
    const dayText = formatDay(startMs, 'UTC');
    lines.push(
      days > 1
        ? `📅 ${dayText} – ${formatDay(Date.parse(`${addDays(endDate, -1)}T12:00:00Z`), 'UTC')}, all day (${days} days)`
        : `📅 ${dayText}, all day`
    );
    alertBaseMs = zonedTimeMs(startDate, 0, timeZone);
  } else {
    const durationMin = Math.round((event.endMs - event.startMs) / MIN);
    lines.push(
      `📅 ${formatDay(event.startMs, timeZone)}, ${formatClock(event.startMs, timeZone)}–${formatClock(
        event.endMs,
        timeZone
      )} (${formatMinutes(durationMin)})`
    );
    alertBaseMs = event.startMs;
  }

  const n = event.notifications;
  if (n.mode === 'explicit') {
    const alerts = [...n.offsetsMin].sort((a, b) => b - a).map((o) => formatAlert(alertBaseMs, o, timeZone));
    lines.push(`🔔 Alert: ${alerts.join(', ')}`);
  } else if (n.mode === 'none') {
    lines.push('🔔 No alert');
  } else if (event.allDay) {
    const at = settings.allDayNudgeMin;
    const clock =
      at === undefined ? 'in the morning' : `at ${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    lines.push(`🔔 Alert: on the day ${clock}`);
  } else if (settings.defaultOffsetsMin.length) {
    const alerts = [...settings.defaultOffsetsMin]
      .sort((a, b) => b - a)
      .map((o) => formatAlert(alertBaseMs, o, timeZone));
    lines.push(`🔔 Alert: ${alerts.join(', ')} (calendar default)`);
  } else {
    lines.push('🔔 No alert (your calendar has no default notifications)');
  }
  if (listNumber != null) lines.push(`Say "cancel ${listNumber}" to undo.`);
  return lines.join('\n');
}

/**
 * @param {{ text: string, chatId: string, actorId: string | null }} m
 * @param {{
 *   calendar: CalendarPort,
 *   extractReminder: ExtractReminder,
 *   nowMs: number,
 *   defaultDurationMin?: number,
 *   allDayNudgeMin?: number,
 *   lastLists?: ReturnType<typeof import('./lastLists.js').createLastLists>,
 *   logger?: { warn?: Function },
 * }} deps
 * @returns {Promise<string | null>} the reply, or null when the message isn't a Reminder request
 */
export async function createCalendarReminder(m, deps) {
  const { calendar, extractReminder, nowMs, lastLists, logger } = deps;
  const defaultDurationMin = deps.defaultDurationMin ?? DEFAULT_DURATION_MIN;

  let settings;
  try {
    settings = await calendar.getSettings();
  } catch (err) {
    logger?.warn?.({ err: err instanceof Error ? err.message : String(err) }, 'calendar: read settings failed');
    return CALENDAR_UNREACHABLE_REPLY;
  }
  const { timeZone } = settings;

  const fields = await extractReminder({ text: m.text, nowMs, timeZone });
  if (!fields.ok) {
    if ('notReminder' in fields) return null;
    return fields.question;
  }

  /** @type {import('./calendarPort.js').NewCalendarEvent} */
  let input;
  if (fields.allDay) {
    const startDate = fields.start.slice(0, 10);
    if (startDate < localDate(nowMs, timeZone)) {
      return `${formatDay(Date.parse(`${startDate}T12:00:00Z`), 'UTC')} has already passed, so I didn't add "${fields.title}". Which date did you mean?`;
    }
    const lastDay = fields.end && fields.end.slice(0, 10) > startDate ? fields.end.slice(0, 10) : startDate;
    input = { title: fields.title, allDay: true, startDate, endDate: addDays(lastDay, 1) };
  } else {
    const startMs = localDateTimeMs(fields.start, timeZone);
    if (startMs <= nowMs) {
      return (
        `${formatDay(startMs, timeZone)} ${formatClock(startMs, timeZone)} is in the past, ` +
        `so I didn't add "${fields.title}". When should it be?`
      );
    }
    let endFromText = fields.end ? localDateTimeMs(fields.end, timeZone) : NaN;
    // "10pm–1am" read with one date: the end is the next day.
    if (endFromText <= startMs && endFromText + DAY > startMs) endFromText += DAY;
    const endMs = endFromText > startMs ? endFromText : startMs + defaultDurationMin * MIN;
    input = { title: fields.title, allDay: false, startMs, endMs };
  }

  /** @type {CalendarNotifications} */
  const notifications = fields.alertOffsetsMin?.length
    ? { mode: 'explicit', offsetsMin: fields.alertOffsetsMin }
    : fields.kind === 'remind'
      ? { mode: 'explicit', offsetsMin: [0] }
      : { mode: 'default' };
  input.notifications = notifications;
  input.creatorActorId = m.actorId;

  let event;
  try {
    event = await calendar.createEvent(input);
  } catch (err) {
    logger?.warn?.({ err: err instanceof Error ? err.message : String(err) }, 'calendar: create event failed');
    return CALENDAR_UNREACHABLE_REPLY;
  }
  // A creation reply is a one-item list: it replaces the chat's last list, so "cancel <n>"
  // resolves against it. The number shown is derived from that stored list.
  let listNumber = null;
  if (lastLists) {
    const list = [event];
    lastLists.set(m.chatId, list, nowMs);
    listNumber = list.indexOf(event) + 1;
  }
  return formatCreatedReply(event, { ...settings, allDayNudgeMin: deps.allDayNudgeMin }, listNumber);
}
