/**
 * Relative reminder parsing for MVP (minutes / hours).
 * Absolute times ("at 6", "tomorrow …") are out of scope for #64.
 * List / cancel management phrases are covered by #65.
 */

const INTENT_RE = /\b(?:please\s+)?(?:remind|nudge)\s+me\b/i;

/** List upcoming: "list reminders", "show my reminders", "what are my reminders", … */
const LIST_RE =
  /\b(?:list|show)\s+(?:my\s+)?(?:upcoming\s+)?reminders?\b|\b(?:what(?:'s|s)?|whats)\s+(?:are\s+|is\s+)?(?:my\s+)?(?:upcoming\s+)?reminders?\b|\bmy\s+(?:upcoming\s+)?reminders?\b|^(?:please\s+)?(?:upcoming\s+)?reminders?\s*[.!?]?\s*$/i;

/** Cancel by ID: "cancel reminder 3", "cancel #3", "delete reminder #12" */
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

const EXAMPLES =
  'Try: "nudge me in 20 minutes to check the oven" or "remind me in 2 hours to stretch".';

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
 * Create / list / cancel intent for the reminder agent.
 * Create ("remind/nudge me …") wins over list/cancel when both could match.
 * @param {string} text
 * @returns {'create' | 'list' | 'cancel' | null}
 */
export function classifyReminderIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Scheduling phrases take priority over embedded "list/cancel" wording.
  if (looksLikeReminderRequest(trimmed)) return 'create';
  if (looksLikeReminderCancel(trimmed)) return 'cancel';
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
 * Extract task text given a relative phrase match index/range.
 * Supports:
 * - "nudge me in 20 minutes to check the oven"
 * - "remind me to check the oven in 20 minutes"
 * - "in 20 minutes remind me to check the oven"
 * @param {string} text
 * @param {number} matchStart
 * @param {number} matchEnd
 * @returns {string}
 */
function extractTaskText(text, matchStart, matchEnd) {
  const before = text.slice(0, matchStart).trim();
  const after = text.slice(matchEnd).trim();

  // Prefer text after the relative phrase ("… in 20 minutes to X")
  let fromAfter = normalizeTaskText(after);
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
 * @typedef {{ ok: true, dueAt: number, text: string, offsetMs: number }} ReminderParseOk
 * @typedef {{
 *   ok: false,
 *   reason: 'not_reminder' | 'unsupported_time' | 'missing_text' | 'invalid_offset',
 *   message: string,
 * }} ReminderParseErr
 * @typedef {ReminderParseOk | ReminderParseErr} ReminderParseResult
 */

/**
 * Parse a relative reminder request.
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
      message:
        `I only support relative reminders in minutes or hours right now. ${EXAMPLES}`,
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
