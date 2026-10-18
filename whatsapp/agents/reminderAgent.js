import { lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import { createCalendarReminder } from '../calendar/createReminder.js';
import {
  classifyReminderIntent,
  formatReminderDue,
  parseCancelReminder,
  parseReminder,
  REMINDER_HELP_TEXT,
} from '../reminders/reminderParser.js';
import {
  addReminder,
  cancelReminder,
  isReminderLimitError,
  listPendingReminders,
} from '../reminders/reminderStore.js';

const CALENDAR_PHRASE_RE =
  /\b(?:(?:in|to|on|into)\s+(?:my|the)\s+(?:calendar|diary)|(?:add|put|book|schedule)\b.*\b(?:calendar|diary)|appointment)\b/i;
const DAY_RE =
  /\b(?:today|tonight|tomorrow|(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?|(?:next|this)\s+(?:week|month)|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?:st|nd|rd|th))\b/i;
const TIME_RE = /\b(?:at\s+\d{1,2}|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midday|all\s+day|birthday|anniversary)\b/i;
const QUESTION_RE = /\?\s*$|^(?:what|when|will|is|are|how|do|does|did|can|could|should|would|who|where|why)\b/i;

/**
 * Appointment phrasing with no "remind me": "dentist Friday 3–4pm", "gym tomorrow at 7",
 * "Mum's birthday on the 25th", "put … in my calendar". Questions ("will it rain tomorrow?")
 * are left to other agents; the extractor can still answer `notReminder` to fall through.
 * @param {string} text
 */
export function looksLikeAppointment(text) {
  const t = String(text || '').trim();
  if (!t || QUESTION_RE.test(t)) return false;
  return CALENDAR_PHRASE_RE.test(t) || (DAY_RE.test(t) && TIME_RE.test(t));
}

/**
 * @param {string} text
 * @returns {'create' | 'help' | 'cancel' | 'list' | null}
 */
function reminderIntent(text) {
  return classifyReminderIntent(text) ?? (looksLikeAppointment(text) ? 'create' : null);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function shouldTryReminderAgent(text) {
  return reminderIntent(text) != null;
}

/**
 * @param {{ id: number, dueAt: number, text: string }[]} reminders
 * @param {number} nowMs
 * @param {{ total?: number, limit?: number }} [meta]
 * @returns {string}
 */
function formatUpcomingList(reminders, nowMs, meta = {}) {
  if (!reminders.length) return 'No upcoming reminders.';
  const lines = reminders.map(
    (r) => `#${r.id} — ${formatReminderDue(r.dueAt, nowMs)}: ${r.text}`
  );
  const total = meta.total ?? reminders.length;
  const limit = meta.limit ?? reminders.length;
  if (total > reminders.length) {
    const more = total - reminders.length;
    lines.push(`…and ${more} more (showing soonest ${limit}).`);
  }
  return `Upcoming reminders:\n${lines.join('\n')}`;
}

/**
 * Handle reminder help / create / list / cancel.
 * Help is available to everyone; create/list/cancel require allowlisted actors.
 * @param {{
 *   text: string,
 *   chatId: string,
 *   actorId: string | null,
 *   actorAltId?: string | null,
 * }} m
 * @param {{
 *   isAllowedActor: (actorId: string | null, actorAltId?: string | null) => boolean,
 *   nowMs?: number,
 *   filePath?: string,
 *   calendar?: import('../calendar/calendarPort.js').CalendarPort,
 *   extractReminder?: import('../calendar/reminderExtraction.js').ExtractReminder,
 *   defaultDurationMin?: number,
 *   allDayNudgeMin?: number,
 *   lastLists?: ReturnType<typeof import('../calendar/lastLists.js').createLastLists>,
 *   logger?: { warn?: Function },
 * }} deps
 *   With `calendar` + `extractReminder`, Reminders are created on the Owner's calendar (#127);
 *   without them, on the local store.
 * @returns {Promise<{ handled: boolean, replyText: string }>}
 */
export async function runReminderAgent(m, deps) {
  const text = m.text;
  const intent = reminderIntent(text);
  if (!intent) {
    return { handled: false, replyText: '' };
  }

  // Discoverability: help does not require the allowlist.
  if (intent === 'help') {
    return { handled: true, replyText: REMINDER_HELP_TEXT };
  }

  const isAllowed =
    typeof deps?.isAllowedActor === 'function' ? deps.isAllowedActor(m.actorId, m.actorAltId) : false;
  if (!isAllowed) {
    // Appointment phrasing without "remind me" is only a guess; strangers fall through to chat.
    if (intent === 'create' && classifyReminderIntent(text) == null) {
      return { handled: false, replyText: '' };
    }
    const hint = lidExtraJidsHint(m.actorId);
    return {
      handled: true,
      replyText:
        `Not allowed to manage reminders from this identity.${hint}\n\n` +
        '(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CLAUDE_AGENT_EXTRA_JIDS.)',
    };
  }

  const nowMs = deps.nowMs ?? Date.now();
  const filePath = deps.filePath;

  if (intent === 'list') {
    const { reminders, total, limit } = await listPendingReminders({
      chatId: m.chatId,
      filePath,
    });
    return {
      handled: true,
      replyText: formatUpcomingList(reminders, nowMs, { total, limit }),
    };
  }

  if (intent === 'cancel') {
    const parsed = parseCancelReminder(text);
    if (!parsed.ok) {
      return { handled: true, replyText: parsed.message };
    }
    // Calendar mode: the number refers to the last list shown in this chat (a creation reply
    // is a one-item list), never to the local store's ids.
    if (deps.calendar && deps.lastLists) {
      const list = deps.lastLists.get(m.chatId, nowMs);
      const evt = list?.[parsed.id - 1];
      if (!evt) {
        return {
          handled: true,
          replyText: list
            ? `There's no #${parsed.id} in the last list (it has ${list.length}).`
            : 'No recent reminder list in this chat to cancel from.',
        };
      }
      if (!evt.isOrganizer) {
        return {
          handled: true,
          replyText: `"${evt.title}" is an invite organised by someone else. Decline it in Google Calendar instead.`,
        };
      }
      try {
        await deps.calendar.deleteEvent(evt.id);
      } catch (err) {
        deps.logger?.warn?.({ err: err instanceof Error ? err.message : String(err) }, 'calendar: delete event failed');
        return { handled: true, replyText: "Couldn't reach Google Calendar, so nothing was cancelled. Please try again." };
      }
      return { handled: true, replyText: `Cancelled #${parsed.id}: ${evt.title}` };
    }
    const cancelled = await cancelReminder(parsed.id, { chatId: m.chatId, filePath });
    if (!cancelled) {
      return {
        handled: true,
        replyText: `No pending reminder #${parsed.id} in this chat.`,
      };
    }
    return { handled: true, replyText: `Cancelled reminder #${cancelled.id}` };
  }

  if (deps.calendar && typeof deps.extractReminder === 'function') {
    const replyText = await createCalendarReminder(m, {
      calendar: deps.calendar,
      extractReminder: deps.extractReminder,
      nowMs,
      defaultDurationMin: deps.defaultDurationMin,
      allDayNudgeMin: deps.allDayNudgeMin,
      lastLists: deps.lastLists,
      logger: deps.logger,
    });
    return replyText === null ? { handled: false, replyText: '' } : { handled: true, replyText };
  }

  const parsed = parseReminder(text, nowMs);
  if (!parsed.ok) {
    if (parsed.reason === 'not_reminder') {
      return { handled: false, replyText: '' };
    }
    return { handled: true, replyText: parsed.message };
  }

  let reminder;
  try {
    reminder = await addReminder({
      chatId: m.chatId,
      actorId: m.actorId,
      dueAt: parsed.dueAt,
      text: parsed.text,
      createdAt: nowMs,
      filePath,
    });
  } catch (e) {
    if (isReminderLimitError(e)) {
      return { handled: true, replyText: e.message };
    }
    throw e;
  }

  const when = formatReminderDue(reminder.dueAt, nowMs);
  const replyText = `OK — I'll remind you at ${when}: ${reminder.text} (#${reminder.id})`;
  return { handled: true, replyText };
}
