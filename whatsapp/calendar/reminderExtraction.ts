/**
 * Reminder extraction (#124, #127): message text + now + the calendar's timezone → structured
 * fields, or a clarifying question. The production extractor is LLM-backed; tests inject fakes.
 *
 * Times are wall-clock times in the calendar's timezone, without an offset, so the model never
 * does timezone arithmetic: `start`/`end` are `YYYY-MM-DDTHH:MM` for timed Reminders and
 * `YYYY-MM-DD` for all-day ones (an all-day `end` is the last day, inclusive).
 *
 * @typedef {{
 *   ok: true,
 *   title: string,
 *   start: string,
 *   end?: string,
 *   allDay: boolean,
 *   alertOffsetsMin?: number[],
 *   kind: 'remind' | 'appointment',
 * }} ReminderFields
 *
 * @typedef {ReminderFields
 *   | { ok: false, question: string }
 *   | { ok: false, notReminder: true }} ReminderExtraction
 *
 * @typedef {(input: { text: string, nowMs: number, timeZone: string }) => Promise<ReminderExtraction>} ExtractReminder
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * `now` as the calendar's wall clock, e.g. `Sat 2026-10-17 14:05`.
 * @param {number} nowMs
 * @param {string} timeZone
 */
export function localNow(nowMs, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(nowMs))
      .map((x) => [x.type, x.value])
  );
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * @param {{ text: string, nowMs: number, timeZone: string }} input
 */
export function buildExtractionPrompt({ text, nowMs, timeZone }) {
  return `You turn a WhatsApp message into a calendar Reminder. Reply with one JSON object only, no prose.

Now: ${localNow(nowMs, timeZone)} (timezone ${timeZone}). Give every time as wall-clock time in that timezone.

If the message asks for a reminder or calendar event, reply:
{"title": string, "start": string, "end": string | null, "allDay": boolean, "alertOffsetsMin": number[] | null, "kind": "remind" | "appointment"}
- title: what it is, short, without the time words ("Take the bins out", "Dentist").
- start/end: "YYYY-MM-DDTHH:MM" for timed events, "YYYY-MM-DD" for all-day events (end = last day, inclusive).
- end: only when the message gives an end time or a duration ("3-4pm", "for an hour"); otherwise null.
- allDay: true for day-long things with no time (birthdays, holidays, "on the 25th").
- kind: "remind" for "remind me / nudge me ..." requests; "appointment" for events and appointments.
- alertOffsetsMin: only when the message says when to be alerted ("remind me an hour before" → [60]); otherwise null.
- Weekdays and dates mean the next one from now. A bare hour with no am/pm: 1-7 means pm, 8-11 means am.

If it is a reminder or event but no date or time can be worked out, reply:
{"question": string} — one short clarifying question.

If the message is not asking to create a reminder or event at all, reply:
{"notReminder": true}

Message: ${JSON.stringify(text)}`;
}

/**
 * Validate the model's reply. Anything malformed becomes a clarifying question, so a bad reply
 * never creates an event.
 * @param {string} raw
 * @returns {ReminderExtraction}
 */
export function parseExtraction(raw) {
  const fallback = {
    ok: /** @type {const} */ (false),
    question: 'Sorry, I could not work out when that is. What date and time should I use?',
  };
  const match = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  /** @type {any} */
  let j;
  try {
    j = JSON.parse(match[0]);
  } catch {
    return fallback;
  }
  if (j?.notReminder === true) return { ok: false, notReminder: true };
  if (typeof j?.question === 'string' && j.question.trim()) {
    return { ok: false, question: j.question.trim() };
  }
  const allDay = j?.allDay === true;
  const shape = allDay ? DATE_RE : DATE_TIME_RE;
  const title = typeof j?.title === 'string' ? j.title.trim() : '';
  if (!title || typeof j?.start !== 'string' || !shape.test(j.start)) return fallback;
  if (j.end != null && (typeof j.end !== 'string' || !shape.test(j.end))) return fallback;
  /** @type {ReminderFields} */
  const fields = {
    ok: true,
    title,
    start: j.start,
    allDay,
    kind: j.kind === 'remind' ? 'remind' : 'appointment',
  };
  if (j.end) fields.end = j.end;
  if (Array.isArray(j.alertOffsetsMin)) {
    const offsets = j.alertOffsetsMin.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (offsets.length) fields.alertOffsetsMin = offsets;
  }
  return fields;
}

/**
 * LLM-backed {@link ExtractReminder}.
 * @param {{ complete: (prompt: string) => Promise<string> }} deps
 * @returns {ExtractReminder}
 */
export function createLlmReminderExtractor({ complete }) {
  return async (input) => parseExtraction(await complete(buildExtractionPrompt(input)));
}
