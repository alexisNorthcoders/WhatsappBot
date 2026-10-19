import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReminderAgent, shouldTryReminderAgent } from '../whatsapp/agents/reminderAgent.ts';
import { createLastLists } from '../whatsapp/calendar/lastLists.ts';
import { parseExtraction } from '../whatsapp/calendar/reminderExtraction.ts';
import { CALENDAR_UNREACHABLE_REPLY } from '../whatsapp/calendar/createReminder.ts';
import { ROUTE_CRITERIA } from '../whatsapp/orchestration/jevRouter.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';
import type { ReminderExtraction } from '../whatsapp/calendar/reminderExtraction.ts';

const MIN = 60_000;
// Sat 17 Oct 2026, 14:00 in London (BST).
const NOW = Date.parse('2026-10-17T14:00:00+01:00');
const OWNER = '447700900001@s.whatsapp.net';
const CHAT = OWNER;

/**
 * Fake extraction: canned results by message text, recording what it was asked.
 */
function fakeExtractor(byText: Record<string, ReminderExtraction>) {
  const calls: { text: string; nowMs: number; timeZone: string }[] = [];
  const extract = async (input) => {
    calls.push(input);
    const r = byText[input.text];
    if (!r) throw new Error(`no canned extraction for ${input.text}`);
    return r;
  };
  return { extract, calls };
}

function send(text: string, deps: object, over: Partial<{ actorId: string | null; chatId: string }> = {}) {
  return runReminderAgent({ text, chatId: CHAT, actorId: OWNER, ...over }, { nowMs: NOW, isAllowedActor: () => true, ...deps });
}

describe('reminder agent: create on the Owner\'s calendar (#127)', () => {
  it('"remind me in 20 minutes…" → 15-minute Reminder, one alert at its start', async () => {
    const calendar = createFakeCalendar();
    const text = 'Remind me in 20 minutes to take the bins out';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Take the bins out', start: '2026-10-17T14:20', allDay: false, kind: 'remind' },
    });
    const r = await send(text, { calendar, extractReminder: extract, lastLists: createLastLists() });
    assert.equal(r.handled, true);
    const [evt] = calendar.all();
    assert.equal(evt.title, 'Take the bins out');
    assert.equal(evt.startMs, NOW + 20 * MIN);
    assert.equal(evt.endMs - evt.startMs, 15 * MIN);
    assert.deepEqual(evt.notifications, { mode: 'explicit', offsetsMin: [0] });
    assert.match(r.replyText, /#1/);
    assert.match(r.replyText, /Sat 17 Oct, 14:20–14:35 \(15 min\)/);
    assert.match(r.replyText, /Alert: 14:20 \(at the start\)/);
  });

  it('"Dentist Friday 3–4pm" → one hour on the right date, calendar default notifications', async () => {
    const calendar = createFakeCalendar({ defaultOffsetsMin: [30] });
    const text = 'Dentist Friday 3–4pm';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Dentist', start: '2026-10-23T15:00', end: '2026-10-23T16:00', allDay: false, kind: 'appointment' },
    });
    const r = await send(text, { calendar, extractReminder: extract });
    const [evt] = calendar.all();
    assert.equal(evt.startMs, Date.parse('2026-10-23T15:00:00+01:00'));
    assert.equal(evt.endMs - evt.startMs, 60 * MIN);
    assert.deepEqual(evt.notifications, { mode: 'default' });
    assert.match(r.replyText, /Fri 23 Oct, 15:00–16:00 \(1 hr\)/);
    assert.match(r.replyText, /Alert: 14:30 \(30 min before\) \(calendar default\)/);
  });

  it('"Gym tomorrow at 7 for an hour" takes its duration from the message', async () => {
    const calendar = createFakeCalendar();
    const text = 'Gym tomorrow at 7 for an hour';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Gym', start: '2026-10-18T19:00', end: '2026-10-18T20:00', allDay: false, kind: 'appointment' },
    });
    await send(text, { calendar, extractReminder: extract });
    const [evt] = calendar.all();
    assert.equal(evt.endMs - evt.startMs, 60 * MIN);
  });

  it('"Mum\'s birthday on the 25th" → all-day Reminder', async () => {
    const calendar = createFakeCalendar();
    const text = "Mum's birthday on the 25th";
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: "Mum's birthday", start: '2026-10-25', allDay: true, kind: 'appointment' },
    });
    const r = await send(text, { calendar, extractReminder: extract, allDayNudgeMin: 9 * 60 });
    const [evt] = calendar.all();
    assert.equal(evt.allDay, true);
    assert.equal(evt.startDate, '2026-10-25');
    assert.equal(evt.endDate, '2026-10-26');
    assert.match(r.replyText, /Sun 25 Oct, all day/);
    assert.match(r.replyText, /Alert: on the day at 09:00/);
  });

  it('"…and remind me an hour before" overrides the alert time', async () => {
    const calendar = createFakeCalendar();
    const text = 'Dentist Friday at 3pm and remind me an hour before';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Dentist', start: '2026-10-23T15:00', allDay: false, kind: 'appointment', alertOffsetsMin: [60] },
    });
    const r = await send(text, { calendar, extractReminder: extract });
    const [evt] = calendar.all();
    assert.deepEqual(evt.notifications, { mode: 'explicit', offsetsMin: [60] });
    assert.equal(evt.endMs - evt.startMs, 15 * MIN);
    assert.match(r.replyText, /Alert: 14:00 \(1 hr before\)/);
  });

  it('interprets times in the calendar\'s timezone, read through the port', async () => {
    const calendar = createFakeCalendar({ timeZone: 'America/New_York' });
    const text = 'Call Sam tomorrow at 9am';
    const { extract, calls } = fakeExtractor({
      [text]: { ok: true, title: 'Call Sam', start: '2026-10-18T09:00', allDay: false, kind: 'appointment' },
    });
    const r = await send(text, { calendar, extractReminder: extract });
    assert.equal(calls[0].timeZone, 'America/New_York');
    assert.equal(calls[0].nowMs, NOW);
    const [evt] = calendar.all();
    assert.equal(evt.startMs, Date.parse('2026-10-18T09:00:00-04:00'));
    assert.match(r.replyText, /Sun 18 Oct, 09:00–09:15/);
  });

  it('refuses a start in the past and creates nothing', async () => {
    const calendar = createFakeCalendar();
    const text = 'remind me at 9 to stretch';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Stretch', start: '2026-10-17T09:00', allDay: false, kind: 'remind' },
    });
    const r = await send(text, { calendar, extractReminder: extract });
    assert.equal(r.handled, true);
    assert.match(r.replyText, /in the past/);
    assert.equal(calendar.all().length, 0);

    const day = "Mum's birthday on the 3rd";
    const past = fakeExtractor({ [day]: { ok: true, title: "Mum's birthday", start: '2026-10-03', allDay: true, kind: 'appointment' } });
    const r2 = await send(day, { calendar, extractReminder: past.extract });
    assert.match(r2.replyText, /already passed/);
    assert.equal(calendar.all().length, 0);
  });

  it('asks a clarifying question for a genuinely ambiguous request and creates nothing', async () => {
    const calendar = createFakeCalendar();
    const text = 'remind me to call the plumber';
    const { extract } = fakeExtractor({ [text]: { ok: false, question: 'When should I remind you?' } });
    const r = await send(text, { calendar, extractReminder: extract });
    assert.equal(r.handled, true);
    assert.equal(r.replyText, 'When should I remind you?');
    assert.equal(calendar.all().length, 0);
  });

  it('falls through when the extractor says it is not a Reminder', async () => {
    const calendar = createFakeCalendar();
    const text = 'lights off tonight at 11pm';
    const { extract } = fakeExtractor({ [text]: { ok: false, notReminder: true } });
    const r = await send(text, { calendar, extractReminder: extract });
    assert.equal(r.handled, false);
    assert.equal(calendar.all().length, 0);
  });

  it('replies with a clear error when Google Calendar is unreachable, creating nothing', async () => {
    const text = 'Dentist Friday 3–4pm';
    const fields = { ok: true, title: 'Dentist', start: '2026-10-23T15:00', allDay: false, kind: 'appointment' };
    const down = { ...createFakeCalendar(), getSettings: async () => { throw new Error('ECONNREFUSED') } };
    const r = await send(text, { calendar: down, extractReminder: fakeExtractor({ [text]: fields }).extract });
    assert.equal(r.replyText, CALENDAR_UNREACHABLE_REPLY);

    const calendar = createFakeCalendar();
    const failing = { ...calendar, createEvent: async () => { throw new Error('503') } };
    const lastLists = createLastLists();
    const r2 = await send(text, { calendar: failing, extractReminder: fakeExtractor({ [text]: fields }).extract, lastLists });
    assert.equal(r2.replyText, CALENDAR_UNREACHABLE_REPLY);
    assert.equal(calendar.all().length, 0);
    assert.equal(lastLists.get(CHAT, NOW), null);
  });

  it('stores the creator\'s actor id and the bot tag, and remembers the reply as list #1', async () => {
    const calendar = createFakeCalendar();
    const lastLists = createLastLists();
    const text = 'remind me in 20 minutes to take the bins out';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Take the bins out', start: '2026-10-17T14:20', allDay: false, kind: 'remind' },
    });
    const second = '447700900002@s.whatsapp.net';
    await send(text, { calendar, extractReminder: extract, lastLists }, { actorId: second, chatId: second });
    const [evt] = calendar.all();
    assert.equal(evt.createdByBot, true);
    assert.equal(evt.creatorActorId, second);
    assert.deepEqual(lastLists.get(second, NOW)?.map((e) => e.id), [evt.id]);
  });

  it('"cancel 1" after a creation reply deletes that event', async () => {
    const calendar = createFakeCalendar();
    const lastLists = createLastLists();
    const text = 'Dentist Friday 3–4pm';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Dentist', start: '2026-10-23T15:00', allDay: false, kind: 'appointment' },
    });
    const noList = await send('cancel 1', { calendar, extractReminder: extract, lastLists });
    assert.match(noList.replyText, /No recent reminder list/);

    await send(text, { calendar, extractReminder: extract, lastLists });
    const outOfRange = await send('cancel 2', { calendar, extractReminder: extract, lastLists });
    assert.match(outOfRange.replyText, /no #2/);
    assert.equal(calendar.all().length, 1);

    const r = await send('cancel 1', { calendar, extractReminder: extract, lastLists });
    assert.equal(r.replyText, 'Cancelled #1: Dentist');
    assert.equal(calendar.all().length, 0);
  });

  it('omits the number and cancel hint when there is no last list to cancel from', async () => {
    const calendar = createFakeCalendar();
    const text = 'Dentist Friday 3–4pm';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Dentist', start: '2026-10-23T15:00', allDay: false, kind: 'appointment' },
    });
    const r = await send(text, { calendar, extractReminder: extract });
    assert.match(r.replyText, /^Added to your calendar: Dentist/);
    assert.doesNotMatch(r.replyText, /#\d|cancel/);
  });

  it('only allowlisted actors can create; others get the existing refusal', async () => {
    const calendar = createFakeCalendar();
    const text = 'remind me tomorrow at 9 to call the dentist';
    const { extract, calls } = fakeExtractor({});
    const r = await send(text, { calendar, extractReminder: extract, isAllowedActor: () => false }, { actorId: 'x@s.whatsapp.net' });
    assert.equal(r.handled, true);
    assert.match(r.replyText, /Not allowed to manage reminders/);
    assert.equal(calls.length, 0);
    assert.equal(calendar.all().length, 0);

    const guess = await send('meeting tomorrow at 3pm', { calendar, extractReminder: extract, isAllowedActor: () => false });
    assert.equal(guess.handled, false);
  });

  it('reads an overnight range as ending the next day', async () => {
    const calendar = createFakeCalendar();
    const text = 'Party Saturday 10pm-1am';
    const { extract } = fakeExtractor({
      [text]: { ok: true, title: 'Party', start: '2026-10-17T22:00', end: '2026-10-17T01:00', allDay: false, kind: 'appointment' },
    });
    await send(text, { calendar, extractReminder: extract });
    const [evt] = calendar.all();
    assert.equal(evt.endMs - evt.startMs, 3 * 60 * MIN);
  });
});

describe('reminder intent gate and Jev route (#127)', () => {
  it('reaches the reminder agent for appointment phrasing', () => {
    for (const t of [
      'Dentist Friday 3–4pm',
      'dentist Friday 3pm',
      'Gym tomorrow at 7 for an hour',
      "Mum's birthday on the 25th",
      'put the MOT in my calendar',
      'add dentist to my calendar for Friday',
    ]) {
      assert.equal(shouldTryReminderAgent(t), true, t);
    }
  });

  it('leaves questions and plain chat alone', () => {
    for (const t of ['will it rain tomorrow?', 'what is the weather tomorrow at 3pm', 'hello', 'turn off the lights']) {
      assert.equal(shouldTryReminderAgent(t), false, t);
    }
  });

  it('describes appointment phrasing on the Jev reminder route', () => {
    assert.match(ROUTE_CRITERIA.reminder.what, /calendar/);
    assert.ok(ROUTE_CRITERIA.reminder.examples.some((e) => /dentist/i.test(e)));
  });
});

describe('parseExtraction', () => {
  it('accepts a timed result and drops nulls', () => {
    assert.deepEqual(
      parseExtraction('{"title":"Gym","start":"2026-10-18T19:00","end":null,"allDay":false,"alertOffsetsMin":null,"kind":"appointment"}'),
      { ok: true, title: 'Gym', start: '2026-10-18T19:00', allDay: false, kind: 'appointment' }
    );
  });

  it('passes through questions and notReminder', () => {
    assert.deepEqual(parseExtraction('```json\n{"question":"What time?"}\n```'), { ok: false, question: 'What time?' });
    assert.deepEqual(parseExtraction('{"notReminder": true}'), { ok: false, notReminder: true });
  });

  it('turns malformed replies into a clarifying question', () => {
    for (const raw of ['nope', '{"title":"x","start":"Friday","allDay":false}', '{"title":"","start":"2026-10-18T19:00"}']) {
      const r = parseExtraction(raw);
      assert.equal(r.ok, false);
      assert.ok('question' in r);
    }
  });
});
