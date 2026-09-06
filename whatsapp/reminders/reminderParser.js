/**
 * Reminder parsing: relative (minutes / hours) and absolute times
 * ("at 6", "tomorrow at 9:15", …) with next-future ambiguity rules (#66).
 * List / cancel management phrases are covered by #65.
 * Help / examples discoverability is covered by #69.
 *
 * Intent precedence for {@link classifyReminderIntent} (first match wins):
 * 1. create — "remind/nudge me …" (wins even when task text embeds "list"/"cancel"/"help")
 * 2. help — "reminder help", "help reminders", "!reminders", …
 * 3. cancel — cancel / delete / remove + optional "reminder" + id (see CANCEL_RE)
 * 4. list — "list/show reminders", "what are my reminders", bare "reminders", …
 *
 * Create-time precedence for {@link parseReminder} (first time phrase in the
 * string wins):
 * - "remind me in 20 minutes to meet at 6" → relative (delay), task "meet at 6"
 * - "remind me tomorrow at 9 in 20 minutes to call" → absolute (tomorrow 09:00)
 *
 * Absolute time rules (server local timezone via Date local getters):
 * - "at H" / "at H:MM" with no am/pm: hours 1–7 → PM, 8–11 → AM, 12 → noon
 *   (so "at 6" → 18:00). Explicit am/pm or 24h hours (13–23) override.
 * - Bare "at …" (no "tomorrow"): next future occurrence — today if that clock
 *   time is still strictly after now, otherwise tomorrow (same clock time).
 * - "tomorrow at …": always the next calendar tomorrow at that clock time
 *   (never rolls to day-after-tomorrow).
 */

const INTENT_RE = /\b(?:please\s+)?(?:remind|nudge)\s+me\b/i;

/**
 * Help / examples (intentional aliases; keep !help in sync):
 * - "reminder help" / "reminders help"
 * - "help reminders" / "help with reminders"
 * - "how do I set a reminder" / "how to use reminders"
 * - "!reminders" / "!reminder"
 */
const HELP_RE =
  /\b(?:reminder|reminders)\s+help\b|\bhelp\s+(?:with\s+)?(?:a\s+)?(?:reminder|reminders)\b|\bhow\s+(?:do\s+i|to)\s+(?:set\s+|use\s+)?(?:a\s+)?reminders?\b|^(?:please\s+)?!reminders?\s*[.!?]?\s*$/i;

/** List upcoming: "list reminders", "show my reminders", "what are my reminders", … */
const LIST_RE =
  /\b(?:list|show)\s+(?:my\s+)?(?:upcoming\s+)?reminders?\b|\b(?:what(?:'s|s)?|whats)\s+(?:are\s+|is\s+)?(?:my\s+)?(?:upcoming\s+)?reminders?\b|\bmy\s+(?:upcoming\s+)?reminders?\b|^(?:please\s+)?(?:upcoming\s+)?reminders?\s*[.!?]?\s*$/i;

/**
 * Cancel by ID (intentional aliases; keep help in sync):
 * - "cancel reminder 3" / "cancel my reminder 3" / "cancel upcoming reminder 3"
 * - "delete reminder #12" / "remove reminder 2"
 * - "cancel #7" / "delete #7" / "remove #7"
 */
const CANCEL_RE =
  /\b(?:cancel|delete|remove)\s+(?:(?:my\s+)?(?:upcoming\s+)?reminder\s+)?#?\s*(\d+)\b/i;

const UNIT_TO_MS = {
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000,
};

const RELATIVE_AMOUNT_RE =
  /(?:^|\b)(?:in\s+)?(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/i;

const RELATIVE_A_AN_RE =
  /(?:^|\b)(?:in\s+)?(?:an?\s+)(minute|min|hour|hr)\b/i;

/**
 * Absolute: optional "tomorrow", required "at", hour, optional :MM, optional am/pm.
 * Examples: "at 6", "at 6pm", "tomorrow at 9", "tomorrow at 9:15", "at 18:00".
 */
const ABSOLUTE_TIME_RE =
  /(?:^|\b)(tomorrow)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b|(?:^|\b)at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i;

/** User-facing examples for invalid/ambiguous create-reminder input. */
export const REMINDER_TIME_EXAMPLES =
  'Try: "remind me at 6 to take the bins out" (bare 1–7 → PM, 8–12 → AM/noon), ' +
  '"nudge me tomorrow at 9 to call the dentist", or "remind me in 20 minutes to check the oven".';

const EXAMPLES = REMINDER_TIME_EXAMPLES;

/**
 * Full user-facing help for set / list / cancel (say "reminder help").
 * Keep cancel aliases and create phrasing aligned with CANCEL_RE / TIME examples.
 */
export const REMINDER_HELP_TEXT = `*Reminders help*

*Set a reminder*
• "remind me in 20 minutes to check the oven"
• "nudge me in 2 hours to stretch"
• "remind me at 6 to take the bins out" (bare 1–7 → PM, 8–12 → AM/noon)
• "remind me tomorrow at 9 to call the dentist"

*List upcoming*
• "list reminders" / "show my reminders" / "reminders"

*Cancel by ID* (use the # from the list or confirmation)
• "cancel reminder 3" / "delete reminder 3" / "remove reminder 3"
• "cancel #3"

Allowlisted actors only. Times use this bot's local timezone.
Say *reminder help* anytime for these examples.`;

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeReminderRequest(text) {
  if (!text || typeof text !== 'string') return false;
  return INTENT_RE.test(text.trim());
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeReminderHelp(text) {
  if (!text || typeof text !== 'string') return false;
  return HELP_RE.test(text.trim());
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeReminderList(text) {
  if (!text || typeof text !== 'string') return false;
  return LIST_RE.test(text.trim());
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeReminderCancel(text) {
  if (!text || typeof text !== 'string') return false;
  return CANCEL_RE.test(text.trim());
}

/**
 * Create / help / list / cancel intent for the reminder agent.
 * Precedence: create → help → cancel → list (see module doc).
 * @param {string} text
 * @returns {'create' | 'help' | 'list' | 'cancel' | null}
 */
export function classifyReminderIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 1) create wins when scheduling text embeds list/cancel/help wording.
  if (looksLikeReminderRequest(trimmed)) return 'create';
  // 2) help before list (e.g. "reminders help" must not become bare list).
  if (looksLikeReminderHelp(trimmed)) return 'help';
  // 3) cancel before list (e.g. "cancel reminder 3" must not become list).
  if (looksLikeReminderCancel(trimmed)) return 'cancel';
  // 4) list
  if (looksLikeReminderList(trimmed)) return 'list';
  return null;
}

/**
 * Parse cancel-by-ID phrasing.
 * @param {string} text
 * @returns {{ ok: true, id: number } | { ok: false, reason: 'not_cancel' | 'missing_id', message: string }}
 */
export function parseCancelReminder(text) {
  const trimmed = String(text ?? '').trim();
  if (!looksLikeReminderCancel(trimmed)) {
    return { ok: false, reason: 'not_cancel', message: '' };
  }
  const m = trimmed.match(CANCEL_RE);
  const id = m ? parseInt(m[1], 10) : NaN;
  if (!Number.isInteger(id) || id < 1) {
    return {
      ok: false,
      reason: 'missing_id',
      message: 'Which reminder should I cancel? Example: "cancel reminder 3".',
    };
  }
  return { ok: true, id };
}

/**
 * @param {number} dueAtMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatReminderDue(dueAtMs, nowMs = Date.now()) {
  const due = new Date(dueAtMs);
  const now = new Date(nowMs);
  const time = due.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDue = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const dayDiff = Math.round((startOfDue - startOfToday) / 86_400_000);
  if (dayDiff === 0) return `${time} today`;
  if (dayDiff === 1) return `${time} tomorrow`;
  const date = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${time} on ${date}`;
}

/**
 * Strip filler around task text (please/thanks, punctuation, to/that).
 * @param {string} raw
 * @returns {string}
 */
function normalizeTaskText(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(/^[,:;.!\?\-–—]+\s*/, '');
  t = t.replace(/\s*[,:;.!\?\-–—]+$/, '');
  t = t.replace(/^(?:please|pls|plz|thanks|thank\s+you|thx)\s+/i, '');
  t = t.replace(/\s+(?:please|pls|plz|thanks|thank\s+you|thx)$/i, '');
  t = t.replace(/^(?:to|that)\s+/i, '');
  t = t.replace(/^[,:;.!\?\-–—]+\s*/, '');
  t = t.replace(/\s*[,:;.!\?\-–—]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Filler-only leftovers (e.g. "please" after stripping time phrase)
  if (/^(?:please|pls|plz|thanks|thank\s+you|thx)$/i.test(t)) return '';
  return t;
}

/**
 * Strip a leading relative delay phrase left over when absolute time won
 * (e.g. "tomorrow at 9 in 20 minutes to call" → after-match "in 20 minutes to call").
 * @param {string} raw
 * @returns {string}
 */
function stripLeadingRelativeTimePhrase(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(/^(?:in\s+)?\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h)\b\s*/i, '');
  t = t.replace(/^(?:in\s+)?(?:an?\s+)(?:minute|min|hour|hr)\b\s*/i, '');
  return t.trim();
}

/**
 * Extract task text given a time-phrase match index/range.
 * Supports:
 * - "nudge me in 20 minutes to check the oven"
 * - "remind me to check the oven in 20 minutes"
 * - "in 20 minutes remind me to check the oven"
 * - "remind me at 6 to take bins out"
 * - "remind me to take bins out at 6"
 * - "at 6 remind me to take bins out"
 * @param {string} text
 * @param {number} matchStart
 * @param {number} matchEnd
 * @returns {string}
 */
function extractTaskText(text, matchStart, matchEnd) {
  const before = text.slice(0, matchStart).trim();
  const after = text.slice(matchEnd).trim();

  // Prefer text after the time phrase ("… at 6 to X" / "… in 20 minutes to X").
  // Also strip leading intent when time comes first ("at 6 remind me to X").
  let fromAfter = after.replace(INTENT_RE, ' ').trim();
  fromAfter = stripLeadingRelativeTimePhrase(fromAfter);
  fromAfter = normalizeTaskText(fromAfter);
  if (fromAfter) return fromAfter;

  // Else text before, stripping intent ("remind me to X in 20 minutes")
  let fromBefore = before
    .replace(INTENT_RE, ' ')
    .replace(/^(?:please\s+)?/i, '')
    .trim();
  fromBefore = normalizeTaskText(fromBefore);
  return fromBefore;
}

/**
 * @param {string} unitRaw
 * @returns {number | null}
 */
function unitMs(unitRaw) {
  const key = String(unitRaw || '').toLowerCase();
  return UNIT_TO_MS[key] ?? null;
}

/**
 * Local calendar + clock → epoch ms (server timezone).
 * @param {number} nowMs
 * @param {{ dayOffset?: number, hour: number, minute: number }} parts
 * @returns {number}
 */
export function localDueAtMs(nowMs, { dayOffset = 0, hour, minute }) {
  const now = new Date(nowMs);
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    minute,
    0,
    0
  ).getTime();
}

/**
 * Resolve hour/minute + optional meridiem to 24h clock parts.
 * Bare hours 1–7 → PM, 8–11 → AM, 12 → noon (matches PRD "at 6" → 18:00).
 * @param {number} hourRaw
 * @param {number} minute
 * @param {string | undefined} meridiemRaw
 * @returns {{ hour: number, minute: number } | null}
 */
export function resolveClockHour(hourRaw, minute, meridiemRaw) {
  if (!Number.isInteger(hourRaw) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  const mer = meridiemRaw ? String(meridiemRaw).replace(/\./g, '').toLowerCase() : '';

  if (mer === 'am' || mer === 'pm') {
    if (hourRaw < 1 || hourRaw > 12) return null;
    let hour = hourRaw % 12;
    if (mer === 'pm') hour += 12;
    return { hour, minute };
  }

  // Explicit 24h (no meridiem)
  if (hourRaw >= 0 && hourRaw <= 23) {
    if (hourRaw >= 13 || hourRaw === 0) {
      return { hour: hourRaw, minute };
    }
    // Bare 1–12: conversational default (1–7 PM, 8–11 AM, 12 noon)
    if (hourRaw >= 1 && hourRaw <= 7) {
      return { hour: hourRaw + 12, minute };
    }
    // 8–12 inclusive → morning / noon as written
    return { hour: hourRaw, minute };
  }

  return null;
}

/**
 * @typedef {{ ok: true, dueAt: number, text: string, offsetMs: number }} ReminderParseOk
 * @typedef {{
 *   ok: false,
 *   reason: 'not_reminder' | 'unsupported_time' | 'missing_text' | 'invalid_offset' | 'invalid_time',
 *   message: string,
 * }} ReminderParseErr
 * @typedef {ReminderParseOk | ReminderParseErr} ReminderParseResult
 */

/**
 * Parse a relative reminder request (minutes / hours only).
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {ReminderParseResult}
 */
export function parseRelativeReminder(text, nowMs = Date.now()) {
  const trimmed = String(text ?? '').trim();
  if (!looksLikeReminderRequest(trimmed)) {
    return { ok: false, reason: 'not_reminder', message: '' };
  }

  let amount = null;
  let unit = null;
  let matchStart = -1;
  let matchEnd = -1;

  const mNum = trimmed.match(RELATIVE_AMOUNT_RE);
  if (mNum && mNum.index != null) {
    amount = parseInt(mNum[1], 10);
    unit = mNum[2];
    matchStart = mNum.index;
    matchEnd = mNum.index + mNum[0].length;
  } else {
    const mOne = trimmed.match(RELATIVE_A_AN_RE);
    if (mOne && mOne.index != null) {
      amount = 1;
      unit = mOne[1];
      matchStart = mOne.index;
      matchEnd = mOne.index + mOne[0].length;
    }
  }

  if (amount == null || !unit) {
    return {
      ok: false,
      reason: 'unsupported_time',
      message: `I couldn't understand that time. ${EXAMPLES}`,
    };
  }

  const per = unitMs(unit);
  if (!per || !Number.isFinite(amount) || amount < 0) {
    return {
      ok: false,
      reason: 'invalid_offset',
      message: `Could not understand that time. ${EXAMPLES}`,
    };
  }

  if (amount === 0) {
    return {
      ok: false,
      reason: 'invalid_offset',
      message: `Please choose a delay of at least 1 minute. ${EXAMPLES}`,
    };
  }

  const offsetMs = amount * per;
  const task = extractTaskText(trimmed, matchStart, matchEnd);
  if (!task) {
    return {
      ok: false,
      reason: 'missing_text',
      message:
        'What should I remind you about? Example: "remind me in 20 minutes to check the oven".',
    };
  }

  return {
    ok: true,
    dueAt: nowMs + offsetMs,
    text: task,
    offsetMs,
  };
}

/**
 * Parse absolute reminder phrasing ("at 6", "tomorrow at 9:15", …).
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {ReminderParseResult}
 */
export function parseAbsoluteReminder(text, nowMs = Date.now()) {
  const trimmed = String(text ?? '').trim();
  if (!looksLikeReminderRequest(trimmed)) {
    return { ok: false, reason: 'not_reminder', message: '' };
  }

  const m = trimmed.match(ABSOLUTE_TIME_RE);
  if (!m || m.index == null) {
    return {
      ok: false,
      reason: 'unsupported_time',
      message: `I couldn't understand that time. ${EXAMPLES}`,
    };
  }

  // Group layout: (tomorrow)(H)(MM)(mer) | ()(H)(MM)(mer) via alternation
  const isTomorrow = Boolean(m[1]);
  const hourRaw = parseInt(isTomorrow ? m[2] : m[5], 10);
  const minuteRaw = isTomorrow ? m[3] : m[6];
  const meridiem = isTomorrow ? m[4] : m[7];
  const minute = minuteRaw != null && minuteRaw !== '' ? parseInt(minuteRaw, 10) : 0;

  const clock = resolveClockHour(hourRaw, minute, meridiem);
  if (!clock) {
    return {
      ok: false,
      reason: 'invalid_time',
      message: `That doesn't look like a valid time. ${EXAMPLES}`,
    };
  }

  let dayOffset = isTomorrow ? 1 : 0;
  let dueAt = localDueAtMs(nowMs, { dayOffset, hour: clock.hour, minute: clock.minute });

  // Bare "at …": next future occurrence (today, else tomorrow).
  // Explicit "tomorrow at …": calendar tomorrow only — do not roll further.
  if (!isTomorrow && dueAt <= nowMs) {
    dayOffset = 1;
    dueAt = localDueAtMs(nowMs, { dayOffset, hour: clock.hour, minute: clock.minute });
  }

  if (dueAt <= nowMs) {
    return {
      ok: false,
      reason: 'invalid_time',
      message: `That time is not in the future. ${EXAMPLES}`,
    };
  }

  const matchStart = m.index;
  const matchEnd = m.index + m[0].length;
  const task = extractTaskText(trimmed, matchStart, matchEnd);
  if (!task) {
    return {
      ok: false,
      reason: 'missing_text',
      message:
        'What should I remind you about? Example: "remind me at 6 to take the bins out".',
    };
  }

  return {
    ok: true,
    dueAt,
    text: task,
    offsetMs: dueAt - nowMs,
  };
}

/**
 * Index of the first relative time phrase, or null.
 * @param {string} text
 * @returns {number | null}
 */
function relativeTimeIndex(text) {
  const mNum = text.match(RELATIVE_AMOUNT_RE);
  const mOne = text.match(RELATIVE_A_AN_RE);
  const idxs = [];
  if (mNum && mNum.index != null) idxs.push(mNum.index);
  if (mOne && mOne.index != null) idxs.push(mOne.index);
  if (!idxs.length) return null;
  return Math.min(...idxs);
}

/**
 * Index of the first absolute time phrase, or null.
 * @param {string} text
 * @returns {number | null}
 */
function absoluteTimeIndex(text) {
  const m = text.match(ABSOLUTE_TIME_RE);
  return m && m.index != null ? m.index : null;
}

/**
 * Parse create-reminder phrasing.
 * When both relative and absolute time phrases appear, the earlier phrase in
 * the string wins (see module doc).
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {ReminderParseResult}
 */
export function parseReminder(text, nowMs = Date.now()) {
  const trimmed = String(text ?? '').trim();
  if (!looksLikeReminderRequest(trimmed)) {
    return { ok: false, reason: 'not_reminder', message: '' };
  }

  const relIdx = relativeTimeIndex(trimmed);
  const absIdx = absoluteTimeIndex(trimmed);

  if (relIdx != null && (absIdx == null || relIdx <= absIdx)) {
    return parseRelativeReminder(trimmed, nowMs);
  }
  if (absIdx != null) {
    return parseAbsoluteReminder(trimmed, nowMs);
  }

  return {
    ok: false,
    reason: 'unsupported_time',
    message: `I couldn't understand that time. ${EXAMPLES}`,
  };
}
