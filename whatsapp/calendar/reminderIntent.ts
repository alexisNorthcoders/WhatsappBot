/**
 * What a reminder message asks for, and the reminder help text (#128). Times are read by the
 * extraction function (`reminderExtraction.ts`), not here.
 *
 * Intent precedence for {@link classifyReminderIntent} (first match wins):
 * 1. create — "remind/nudge me …" (wins even when task text embeds "list"/"cancel"/"help")
 * 2. help — whole-message only: "reminder help", "help reminders", "!reminders", …
 * 3. cancel — whole-message "cancel 2" / "cancel reminder 2" / "delete #2" / "remove 2", with
 *    polite padding ("pls cancel #3", "can u remove reminder 2", "delete item 5 from my list")
 * 4. create — other request phrasing: "set a reminder …", "don't let me forget …", "put … on
 *    the calendar", "add an all-day event …"
 * 5. list — "what's on tomorrow" / "what do I have on thursday" / "any events on wednesday" /
 *    "list reminders" / "anything coming up", …
 */

/** "remind me how to set the oven timer" asks a question, not for a Reminder. */
const INTENT_RE = /\b(?:please\s+)?(?:remind|nudge)\s+me\b(?!\s+(?:how|what|who|why|which|whether|if)\b)/i;

/** Polite padding around a whole-message cancel or list: "pls", "can u", "thx", an emoji. */
const LEAD = String.raw`(?:(?:hey|hi|ok|okay|oh|and|also|right|so|i\s+messed\s+up|oops|actually)[,!]?\s+)?(?:(?:please|pls|plz|kindly|just|can\s+(?:you|u|i)|could\s+(?:you|u)|would\s+you|will\s+you|would\s+you\s+mind|could\s+you\s+possibly|possibly|when\s+you\s+(?:get|have)\s+a\s+(?:sec|second|moment|minute|chance)[,]?|when\s+you['’]?re\s+free[,]?|i\s+was\s+wondering\s+if\s+you\s+could|is\s+it\s+possible\s+to|i\s+(?:need|want)\s+to|i['’]?d\s+like\s+to)\s+)*`;
const TAIL = String.raw`(?:\s*(?:,?\s*(?:please|pls|plz|thanks|thank\s+you|thx|ta|cheers|mate|now|for\s+me|anymore|any\s+more))*)\s*[.!?]*\s*[\p{Extended_Pictographic}\uFE0F\u200D\s]*$`;
const ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/**
 * Create phrasing without "remind me": asking for a reminder, an event or a calendar entry, or
 * not to forget something. Each needs a request word next to the reminder/calendar word, so
 * "my weather app is a reminder that…" or "what's a calendar year" don't match.
 */
const CREATE_RES = [
  // "set/make/add/create/pop/put/schedule a reminder …", "can you send me a reminder …", "i need a reminder …"
  new RegExp(
    String.raw`^${LEAD}(?:(?:i\s+(?:need|want)|i['’]?d\s+like)(?:\s+you\s+to)?(?:\s+(?:set|make|add|create|pop|put|schedule))?|set(?:ting)?(?:\s+up)?|mak(?:e|ing)|add(?:ing)?|creat(?:e|ing)|pop(?:ping)?|put(?:ting)?|stick|schedul(?:e|ing)|send\s+me|give\s+me|get\s+me)` +
      String.raw`(?:\s+(?:in|up|on))?\s*(?:a\s+|an\s+|me\s+a\s+)?(?:quick\s+|calendar\s+|all[-\s]day\s+)?(?:reminders?|alerts?|alarms?)\b(?!\s+(?:help|list)\b)(?!.*\b(?:note|notes|notebook|list)\b)`,
    'iu',
  ),
  // "reminder to buy milk", "reminder in 30m", "remind in 4 hours", "reminder for the 13th"
  /^(?:(?:pls|please|can\s+(?:you|u)|could\s+you)\s+)?(?:a\s+|an\s+)?(?:all[-\s]day\s+)?(?:remind|reminder|nudge|alert)\s+(?:to|in|at|on|for|tomorrow|tmrw|tonight)\b/i,
  // "give me a shout/nudge/buzz in 15 minutes"
  /\bgive\s+me\s+a\s+(?:shout|nudge|buzz|ping|heads[-\s]up|reminder)\s+(?:in|at|on|tomorrow|tmrw|tonight|before)\b/i,
  // "don't let me forget/miss …", "make sure I don't forget …"
  /\b(?:don['’]?t|do\s+not|dont)\s+let\s+me\s+(?:forget|miss)\b|\bmake\s+sure\s+i\s+(?:don['’]?t|do\s+not|dont)\s+(?:forget|miss)\b/i,
  // "put/pop/add/stick/mark/pencil/book … on/in the cal/calendar/diary/schedule"
  /\b(?:put|pop|add|stick|mark|pencil|book|schedule|enter|note)\b.{0,80}?\b(?:in|on|into|to)\s+(?:my\s+|the\s+|our\s+)?(?:cal|calendar|calender|diary|schedule)\b/i,
  // "add an event / an appointment / an all-day event …", "create a calendar event"
  new RegExp(
    String.raw`^${LEAD}(?:add(?:ing)?|creat(?:e|ing)|mak(?:e|ing)|set(?:ting)?(?:\s+up)?|put(?:ting)?|pop(?:ping)?|schedul(?:e|ing)|book(?:ing)?)\b(?:\s+(?:in|up|me))?\s+(?:an?\s+|the\s+)?(?:(?:all[-\s]day|calendar|calender|new)\s+)?(?:event|appointment|entry)\b(?!.*\b(?:note|notes|notebook)\b)`,
    'iu',
  ),
  /\b(?:make\s+it|as|for)\s+(?:an?\s+)?all[-\s]day\s+(?:event|thing|reminder)\b|^all[-\s]day\s+event\b/i,
];

/**
 * Whole message only so near-misses like "list reminders help" keep their list intent.
 * Aliases (keep {@link REMINDER_COMMAND_HELP_SNIPPET} in sync): "reminder(s) help",
 * "help (with) reminders", "!reminder(s)".
 */
const HELP_RE =
  /^(?:please\s+)?(?:(?:reminder|reminders)\s+help|help\s+(?:with\s+)?(?:a\s+)?(?:reminder|reminders)|!reminders?)\s*[.!?]?\s*$/i;


/**
 * Whole message only, so "remove 2 eggs from the shopping list" is not a cancel.
 * "cancel 2" / "cancel reminder 2" / "cancel my reminder #2" / "delete #2" / "remove 2",
 * "delete the 3rd", "delete item 5 from my list", "i don't want reminder 4 anymore".
 */
const CANCEL_RE = new RegExp(
  String.raw`^${LEAD}(?:cancel|delete|remove|scrap|drop|bin|kill|ditch|take\s+off|get\s+rid\s+of|i\s+(?:don['’]?t|dont|do\s+not)\s+(?:want|need))\s+` +
    String.raw`(?:(?:the|my|that)\s+)?(?:(?:upcoming\s+)?(?:reminder|event|item|entry|one)\s+)?(?:(?:number|no\.?|num)\s*)?#?\s*` +
    String.raw`(\d{1,2}|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:st|nd|rd|th)?(?:\s+one)?` +
    String.raw`(?:\s+(?:on|from|off|in)\s+(?:my|the|that)\s+(?:list(?:\s+of\s+reminders)?|reminders|calendar)(?:\s+for\s+(?:today|tomorrow|this\s+week))?)?${TAIL}`,
  'iu',
);

const DAY_WINDOWS: Record<string, ListWindow> = {
  today: 'today', tonight: 'today', tomorrow: 'tomorrow', tmrw: 'tomorrow', tmr: 'tomorrow', tomoz: 'tomorrow',
  'this week': 'thisWeek', 'next week': 'nextWeek',
  mon: 'monday', monday: 'monday', tue: 'tuesday', tues: 'tuesday', tuesday: 'tuesday', wed: 'wednesday', weds: 'wednesday',
  wednesday: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', thursday: 'thursday', fri: 'friday',
  friday: 'friday', sat: 'saturday', saturday: 'saturday', sun: 'sunday', sunday: 'sunday',
  weekend: 'weekend', 'this weekend': 'weekend', 'the weekend': 'weekend',
  'this morning': 'today', 'this afternoon': 'today', 'this evening': 'today',
};
const WHEN = String.raw`(?:(?:on|for|in|this|coming|over|next)\s+)*(today|tonight|tomorrow|tmrw|tmr|tomoz|this\s+week|next\s+week|(?:this|the)\s+weekend|weekend|this\s+(?:morning|afternoon|evening)|mon(?:day)?|tues?(?:day)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:['’]?s)?(?:\s+(?:morning|afternoon|evening|night))?`;
const PLANS = String.raw`(?:plans?|agenda|appointments?|events?|meetings?|reminders?|schedule|calendar|cal|diary|tasks|to-?do\s+list|stuff)`;

/**
 * "what's on tomorrow", "what have I got on this week", "what's on my calendar today?",
 * "anything on next week", "what do i have on thursday", "any events on wednesday",
 * "what's happening this friday", "can u check my cal for tomorrow pls"
 */
const WINDOW_RE = new RegExp(
  String.raw`^${LEAD}(?:(?:what(?:['’]?s|\s+is)?\s+(?:on|happening|planned|booked|in\s+(?:the|my)\s+(?:diary|calendar|cal))|` +
    String.raw`what\s+(?:have|do)\s+(?:i|we)\s+(?:got|have)(?:\s+(?:on|planned|booked|scheduled))?|(?:have|do)\s+(?:i|we)\s+(?:got|have)\s+anything(?:\s+on)?|` +
    String.raw`(?:u|you)\s+got\s+any\s+${PLANS}|any(?:thing)?\s+(?:on|planned|booked|scheduled)|any\s+${PLANS}(?:\s+on)?(?:\s+(?:i['’]?ve|i\s+have)\s+got)?|` +
    String.raw`(?:check|show|list|read|tell)\s+(?:me\s+)?(?:what['’]?s\s+(?:on\s+)?)?(?:my\s+|the\s+)?${PLANS}|what['’]?s\s+(?:on\s+)?(?:my|the)\s+${PLANS}|` +
    String.raw`what\s+does\s+my\s+${PLANS}\s+look\s+like|(?:list|show)\s+(?:me\s+)?everything\s+i['’]?ve\s+got\s+(?:on|scheduled|booked)|${PLANS})` +
    String.raw`(?:\s+(?:(?:on|in)\s+)?(?:my|the)\s+(?:calendar|calender|cal|diary|schedule))?\s+(?:for\s+)?${WHEN}|${WHEN}\s+${PLANS})${TAIL}`,
  'iu',
);

/** List upcoming: "list reminders", "show my reminders", "what are my reminders", bare "reminders". */
const LIST_RE =
  /\b(?:list|show)\s+(?:my\s+)?(?:upcoming\s+)?reminders?\b|\bwhat(?:['’]?s)?\s+(?:are\s+|is\s+)?(?:my\s+)?(?:upcoming\s+)?reminders?\b|\bmy\s+(?:upcoming\s+)?reminders?\b|^(?:please\s+)?(?:upcoming\s+)?reminders?\s*[.!?]?\s*$/i;

/** "anything coming up", "next 7 days", "what's on my calendar" with no day: the upcoming list. */
const UPCOMING_RE = new RegExp(
  String.raw`^${LEAD}(?:(?:what['’]?s|what\s+is|anything|any\s+(?:events|appointments|reminders|plans))\s+(?:i['’]?ve\s+got\s+|i\s+have\s+)?coming\s+up|` +
    String.raw`(?:what['’]?s|what\s+is)\s+(?:on\s+)?(?:in\s+)?(?:my|the)\s+(?:calendar|calender|cal|diary|schedule)|` +
    String.raw`(?:show|check)\s+(?:me\s+)?my\s+(?:calendar|calender|cal|diary|schedule))` +
    String.raw`(?:\s+(?:for|in|over)\s+the\s+next\s+(?:\d+|few|couple\s+of)\s+(?:days|weeks))?${TAIL}`,
  'iu',
);

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
/** A weekday means the next one from today (today itself on that day); the weekend is the coming Saturday and Sunday. */
export type ListWindow = 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'weekend' | 'upcoming' | Weekday;

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
  if (cancel) return { kind: 'cancel', n: ORDINAL[cancel[1].toLowerCase()] ?? parseInt(cancel[1], 10) };
  // after cancel, so "cancel reminder 2" isn't read as "… reminder" create phrasing
  if (CREATE_RES.some((re) => re.test(t))) return { kind: 'create' };
  const win = t.match(WINDOW_RE);
  if (win) {
    const w = (win[1] ?? win[2]).toLowerCase().replace(/\s+/g, ' ');
    return { kind: 'list', window: DAY_WINDOWS[w] ?? DAY_WINDOWS[w.slice(0, 3)] };
  }
  if (LIST_RE.test(t) || UPCOMING_RE.test(t)) return { kind: 'list', window: 'upcoming' };
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
