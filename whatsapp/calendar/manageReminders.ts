/**
 * List and cancel Reminders on the Owner's calendar (#128). A list reply is numbered and
 * remembered per chat (`lastLists.ts`); "cancel N" deletes item N of that list. Only Reminders
 * the Owner organises can be cancelled: invites from someone else are declined in Calendar.
 */

import { addDays, formatClock, formatDay, localDate } from './createReminder.ts';
import { occurrenceSpan, zonedTimeMs } from './nudgeTick.ts';

/** @typedef {import('./calendarPort.ts').CalendarPort} CalendarPort */
/** @typedef {import('./calendarPort.ts').CalendarEvent} CalendarEvent */
/** @typedef {import('./reminderIntent.ts').ListWindow} ListWindow */
/** @typedef {ReturnType<typeof import('./lastLists.ts').createLastLists>} LastLists */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** How far ahead "list reminders" looks. */
export const UPCOMING_DAYS = 60;
/** Most items in one list reply. */
export const LIST_LIMIT = 15;

export const CALENDAR_UNREACHABLE_LIST_REPLY = "Couldn't reach Google Calendar. Please try again in a minute.";

/**
 * The window a list covers, in the calendar's timezone. Weeks run Monday to Sunday; "today" and
 * "this week" start now, so finished Reminders are left out.
 * @param {ListWindow} window
 * @param {number} nowMs
 * @param {string} timeZone
 * @returns {{ timeMinMs: number, timeMaxMs: number, label: string, empty: string }}
 */
export function listWindow(window, nowMs, timeZone) {
  const today = localDate(nowMs, timeZone);
  const midnight = (/** @type {number} */ days) => zonedTimeMs(addDays(today, days), 0, timeZone);
  const dayName = (/** @type {number} */ days) => formatDay(Date.parse(`${addDays(today, days)}T12:00:00Z`), 'UTC');
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const toMonday = (8 - dow) % 7 || 7;
  switch (window) {
    case 'today':
      return { timeMinMs: nowMs, timeMaxMs: midnight(1), label: `Today (${dayName(0)})`, empty: 'Nothing else on today.' };
    case 'tomorrow':
      return { timeMinMs: midnight(1), timeMaxMs: midnight(2), label: `Tomorrow (${dayName(1)})`, empty: 'Nothing on tomorrow.' };
    case 'thisWeek':
      return { timeMinMs: nowMs, timeMaxMs: midnight(toMonday), label: 'This week', empty: 'Nothing else on this week.' };
    case 'nextWeek':
      return {
        timeMinMs: midnight(toMonday),
        timeMaxMs: midnight(toMonday + 7),
        label: `Next week (${dayName(toMonday)} – ${dayName(toMonday + 6)})`,
        empty: 'Nothing on next week.',
      };
    default:
      return {
        timeMinMs: nowMs,
        timeMaxMs: nowMs + UPCOMING_DAYS * DAY,
        label: 'Upcoming reminders',
        empty: `No upcoming reminders in the next ${UPCOMING_DAYS} days.`,
      };
  }
}

/**
 * Reminders in the window, by start. All-day Reminders are matched on their local dates (the
 * port carries them as UTC midnights, so the query is widened by a day each side). Declined
 * invites are left out.
 * @param {CalendarPort} calendar
 * @param {{ timeMinMs: number, timeMaxMs: number }} win
 * @param {string} timeZone
 */
async function remindersIn(calendar, { timeMinMs, timeMaxMs }, timeZone) {
  const events = await calendar.listEvents({ timeMinMs: timeMinMs - DAY, timeMaxMs: timeMaxMs + DAY });
  return events
    .filter((e) => e.responseStatus !== 'declined')
    .map((e) => ({ event: e, span: occurrenceSpan(e, timeZone) }))
    .filter(({ span }) => span.endMs > timeMinMs && span.startMs < timeMaxMs)
    .sort((a, b) => a.span.startMs - b.span.startMs)
    .map(({ event }) => event);
}

/**
 * One list line (without its number), e.g. "Mon 19 Oct 15:00–16:00 Dentist".
 * @param {CalendarEvent} event
 * @param {string} timeZone
 */
export function formatListItem(event, timeZone) {
  let when;
  if (event.allDay && event.startDate) {
    const lastDay = event.endDate ? addDays(event.endDate, -1) : event.startDate;
    const day = (/** @type {string} */ d) => formatDay(Date.parse(`${d}T12:00:00Z`), 'UTC');
    when = lastDay > event.startDate ? `${day(event.startDate)} – ${day(lastDay)}, all day` : `${day(event.startDate)}, all day`;
  } else {
    const sameDay = localDate(event.startMs, timeZone) === localDate(event.endMs - 1, timeZone);
    when = `${formatDay(event.startMs, timeZone)} ${formatClock(event.startMs, timeZone)}–${
      sameDay ? '' : `${formatDay(event.endMs, timeZone)} `
    }${formatClock(event.endMs, timeZone)}`;
  }
  return `${when}: ${event.title}${event.isOrganizer ? '' : ' (invite)'}`;
}

/**
 * @param {{ chatId: string }} m
 * @param {ListWindow} window
 * @param {{ calendar: CalendarPort, lastLists?: LastLists, nowMs: number, logger?: { warn?: Function } }} deps
 * @returns {Promise<string>}
 */
export async function listReminders(m, window, deps) {
  const { calendar, lastLists, nowMs, logger } = deps;
  let timeZone;
  let events;
  let win;
  try {
    ({ timeZone } = await calendar.getSettings());
    win = listWindow(window, nowMs, timeZone);
    events = await remindersIn(calendar, win, timeZone);
  } catch (err) {
    logger?.warn?.({ err: err instanceof Error ? err.message : String(err) }, 'calendar: list events failed');
    return CALENDAR_UNREACHABLE_LIST_REPLY;
  }
  const shown = events.slice(0, LIST_LIMIT);
  // The list just shown replaces the chat's last list, even when empty, so "cancel N" never
  // resolves against an older list the user can no longer see.
  lastLists?.set(m.chatId, shown, nowMs);
  if (!shown.length) return win.empty;
  const lines = [`${win.label}:`, ...shown.map((e, i) => `${i + 1}. ${formatListItem(e, timeZone)}`)];
  if (events.length > shown.length) lines.push(`…and ${events.length - shown.length} more.`);
  if (lastLists) lines.push('', 'Say "cancel <number>" to remove one.');
  return lines.join('\n');
}

/**
 * Delete item `n` of the chat's last list.
 * @param {{ chatId: string }} m
 * @param {number} n
 * @param {{ calendar: CalendarPort, lastLists?: LastLists, nowMs: number, logger?: { warn?: Function } }} deps
 * @returns {Promise<string>}
 */
export async function cancelReminder(m, n, deps) {
  const { calendar, lastLists, nowMs, logger } = deps;
  const list = lastLists?.get(m.chatId, nowMs) ?? null;
  if (!list) {
    return 'No recent reminder list in this chat, so nothing was cancelled. Say "list reminders" or "what\'s on this week" first.';
  }
  if (!list.length) return 'The last list was empty, so nothing was cancelled.';
  const evt = list[n - 1];
  if (!evt) {
    return `There's no #${n} in the last list (it has ${list.length}), so nothing was cancelled.`;
  }
  if (!evt.isOrganizer) {
    return `"${evt.title}" is an invite organised by someone else, so I can't cancel it. Decline it in Google Calendar instead.`;
  }
  try {
    await calendar.deleteEvent(evt.id);
  } catch (err) {
    logger?.warn?.({ err: err instanceof Error ? err.message : String(err) }, 'calendar: delete event failed');
    return "Couldn't reach Google Calendar, so nothing was cancelled. Please try again.";
  }
  return `Cancelled #${n}: ${evt.title}`;
}
