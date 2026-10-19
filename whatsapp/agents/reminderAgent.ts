import { lidExtraJidsHint } from '../whatsAppActorAllowlist.ts';
import type { isAllowedActor } from '../whatsAppActorAllowlist.ts';
import { createCalendarReminder } from '../calendar/createReminder.ts';
import { cancelReminder, listReminders } from '../calendar/manageReminders.ts';
import { classifyReminderIntent, REMINDER_HELP_TEXT } from '../calendar/reminderIntent.ts';
import type { ReminderIntent } from '../calendar/reminderIntent.ts';
import type { CalendarPort } from '../calendar/calendarPort.ts';
import type { ExtractReminder } from '../calendar/reminderExtraction.ts';
import type { createLastLists } from '../calendar/lastLists.ts';
import type { Logger } from '../types.ts';

export const CALENDAR_NOT_CONNECTED_REPLY =
  "Reminders live on Google Calendar, which isn't connected to this bot " +
  '(set GOOGLE_CALENDAR_* — see docs/google-calendar-setup.md).';

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
 */
export function looksLikeAppointment(text: string) {
  const t = String(text || '').trim();
  if (!t || QUESTION_RE.test(t)) return false;
  return CALENDAR_PHRASE_RE.test(t) || (DAY_RE.test(t) && TIME_RE.test(t));
}

function reminderIntent(text: string): ReminderIntent | null {
  return classifyReminderIntent(text) ?? (looksLikeAppointment(text) ? { kind: 'create' } : null);
}

export function shouldTryReminderAgent(text: string): boolean {
  return reminderIntent(text) != null;
}

/** Without `calendar` (no Google credentials) only help works. */
type ReminderAgentDeps = {
  isAllowedActor: typeof isAllowedActor;
  /**
   * Picks the creator id recorded on a new Reminder (default: the actor id); the nudge tick
   * reads it to Nudge SECOND_PHONE for its own Reminders.
   */
  creatorIdFor?: (actorId: string | null, actorAltId?: string | null) => string | null;
  nowMs?: number;
  calendar?: CalendarPort;
  extractReminder?: ExtractReminder;
  defaultDurationMin?: number;
  allDayNudgeMin?: number;
  lastLists?: ReturnType<typeof createLastLists>;
  logger?: Pick<Logger, 'warn'>;
};

/**
 * Handle reminder help / create / list / cancel against the Owner's calendar.
 * Help is available to everyone; create/list/cancel require allowlisted actors.
 */
export async function runReminderAgent(
  m: { text: string; chatId: string; actorId: string | null; actorAltId?: string | null },
  deps: ReminderAgentDeps,
): Promise<{ handled: boolean; replyText: string }> {
  const text = m.text;
  const intent = reminderIntent(text);
  if (!intent) {
    return { handled: false, replyText: '' };
  }

  // Discoverability: help does not require the allowlist.
  if (intent.kind === 'help') {
    return { handled: true, replyText: REMINDER_HELP_TEXT };
  }

  // Appointment phrasing without "remind me" is only a guess: fall through to chat rather than
  // refuse it or complain that the calendar is missing.
  const guessed = intent.kind === 'create' && classifyReminderIntent(text) == null;

  const isAllowed =
    typeof deps?.isAllowedActor === 'function' ? deps.isAllowedActor(m.actorId, m.actorAltId) : false;
  if (!isAllowed) {
    if (guessed) return { handled: false, replyText: '' };
    const hint = lidExtraJidsHint(m.actorId);
    return {
      handled: true,
      replyText:
        `Not allowed to manage reminders from this identity.${hint}\n\n` +
        '(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CLAUDE_AGENT_EXTRA_JIDS.)',
    };
  }

  const { calendar } = deps;
  if (!calendar || typeof deps.extractReminder !== 'function') {
    return guessed ? { handled: false, replyText: '' } : { handled: true, replyText: CALENDAR_NOT_CONNECTED_REPLY };
  }

  const nowMs = deps.nowMs ?? Date.now();
  const manageDeps = { calendar, lastLists: deps.lastLists, nowMs, logger: deps.logger };

  if (intent.kind === 'list') {
    return { handled: true, replyText: await listReminders(m, intent.window, manageDeps) };
  }

  if (intent.kind === 'cancel') {
    return { handled: true, replyText: await cancelReminder(m, intent.n, manageDeps) };
  }

  const creatorActorId = deps.creatorIdFor ? deps.creatorIdFor(m.actorId, m.actorAltId) : m.actorId;
  const replyText = await createCalendarReminder({ ...m, creatorActorId }, {
    calendar,
    extractReminder: deps.extractReminder,
    nowMs,
    defaultDurationMin: deps.defaultDurationMin,
    allDayNudgeMin: deps.allDayNudgeMin,
    lastLists: deps.lastLists,
    logger: deps.logger,
  });
  return replyText === null ? { handled: false, replyText: '' } : { handled: true, replyText };
}
