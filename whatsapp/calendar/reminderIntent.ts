/**
 * What a reminder message asks for, and the reminder help text (#128). Times are read by the
 * extraction function (`reminderExtraction.ts`), not here.
 *
 * Intent precedence for {@link classifyReminderIntent} (first match wins):
 * 1. create — "remind/nudge me …" (wins even when task text embeds "list"/"cancel"/"help")
 * 2. help — whole-message only: "reminder help", "help reminders", "!reminders", …
 * 3. cancel — whole-message "cancel 2" / "cancel reminder 2" / "delete #2" / "remove 2"
 * 4. list — "what's on tomorrow" / "what's on this week" / "list reminders", …
 */

const INTENT_RE = /\b(?:please\s+)?(?:remind|nudge)\s+me\b/i;

/**
 * Whole message only so near-misses like "list reminders help" keep their list intent.
 * Aliases (keep {@link REMINDER_COMMAND_HELP_SNIPPET} in sync): "reminder(s) help",
 * "help (with) reminders", "!reminder(s)".
 */
const HELP_RE =
  /^(?:please\s+)?(?:(?:reminder|reminders)\s+help|help\s+(?:with\s+)?(?:a\s+)?(?:reminder|reminders)|!reminders?)\s*[.!?]?\s*$/i;

/**
 * Whole message only, so "remove 2 eggs from the shopping list" is not a cancel.
 * "cancel 2" / "cancel reminder 2" / "cancel my reminder #2" / "delete #2" / "remove 2".
 */
const CANCEL_RE =
  /^(?:please\s+)?(?:cancel|delete|remove)\s+(?:(?:my\s+)?(?:upcoming\s+)?reminder\s+)?(?:(?:number|no\.?)\s*)?#?\s*(\d+)\s*[.!]?\s*$/i;

/**
 * "what's on tomorrow", "what have I got on this week", "what's on my calendar today?",
 * "anything on next week"
 */
const WINDOW_RE =
  /^(?:please\s+)?(?:what(?:['’]?s|\s+is)?\s+(?:on|happening|planned)|what\s+(?:have|do)\s+i\s+(?:got|have)(?:\s+on)?|anything\s+on|(?:show|list)\s+(?:me\s+)?(?:my\s+)?(?:reminders|calendar|events))(?:\s+(?:(?:on|in)\s+)?(?:my|the)\s+(?:calendar|diary))?\s+(?:for\s+)?(today|tonight|tomorrow|this\s+week|next\s+week)\s*[.!?]?\s*$/i;

/** List upcoming: "list reminders", "show my reminders", "what are my reminders", bare "reminders". */
const LIST_RE =
  /\b(?:list|show)\s+(?:my\s+)?(?:upcoming\s+)?reminders?\b|\bwhat(?:['’]?s)?\s+(?:are\s+|is\s+)?(?:my\s+)?(?:upcoming\s+)?reminders?\b|\bmy\s+(?:upcoming\s+)?reminders?\b|^(?:please\s+)?(?:upcoming\s+)?reminders?\s*[.!?]?\s*$/i;

export type ListWindow = 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'upcoming';

export type ReminderIntent = { kind: 'create' } |
{ kind: 'help' } |
{ kind: 'cancel'; n: number } |
{ kind: 'list'; window: ListWindow };

export function classifyReminderIntent(text: string): ReminderIntent | null {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  if (INTENT_RE.test(t)) return { kind: 'create' };
  if (HELP_RE.test(t)) return { kind: 'help' };
  const cancel = t.match(CANCEL_RE);
  if (cancel) return { kind: 'cancel', n: parseInt(cancel[1], 10) };
  const win = t.match(WINDOW_RE);
  if (win) {
    const w = win[1].toLowerCase().replace(/\s+/g, ' ');
    const map: Record<string, ListWindow> = { today: 'today', tonight: 'today', tomorrow: 'tomorrow', 'this week': 'thisWeek', 'next week': 'nextWeek' };
    return { kind: 'list', window: map[w] };
  }
  if (LIST_RE.test(t)) return { kind: 'list', window: 'upcoming' };
  return null;
}

/** Full user-facing help (say "reminder help"). Keep phrasing aligned with the regexes above. */
export const REMINDER_HELP_TEXT = `*Reminders help*
Reminders live on your Google Calendar.

*Add one*
• "remind me in 20 minutes to check the oven"
• "nudge me tomorrow at 9 to call the dentist"
• "dentist Friday 3–4pm" / "gym tomorrow at 7 for an hour"
• "Mum's birthday on the 25th" (all day)
• "…and remind me an hour before" to set the alert

*See what's on*
• "what's on today" / "what's on tomorrow"
• "what's on this week" / "what's on next week"
• "list reminders" (the next ones coming up)

*Cancel one*
• "cancel 2" — item 2 of the last list shown in this chat (or the number in an "Added" reply)
• Lists are remembered for 30 minutes; ask again if it's older
• Invites from someone else can't be cancelled here: decline them in Google Calendar

*Access*
• This help — anyone
• Add / list / cancel — allowlisted actors only

Times use your calendar's timezone.
Say *reminder help* (or *!reminders*) anytime for these examples.`;

/** One-line Smart Agents blurb for !help, kept next to {@link REMINDER_HELP_TEXT}. */
export const REMINDER_COMMAND_HELP_SNIPPET =
  'Say *reminder help* (or *help reminders* / *!reminders*) for examples. ' +
  'Add: "remind me in 20 minutes to …", "dentist Friday 3–4pm". ' +
  'See: "what\'s on tomorrow", "what\'s on this week", "list reminders". ' +
  'Cancel: "cancel 2" (from the last list). ' +
  'Help is public; add/list/cancel require an allowlisted actor.';
