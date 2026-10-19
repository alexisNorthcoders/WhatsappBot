import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReminderAgent, shouldTryReminderAgent, CALENDAR_NOT_CONNECTED_REPLY } from '../whatsapp/agents/reminderAgent.ts';
import { classifyReminderIntent, REMINDER_HELP_TEXT } from '../whatsapp/calendar/reminderIntent.ts';
import { createLastLists } from '../whatsapp/calendar/lastLists.ts';
import { CALENDAR_UNREACHABLE_LIST_REPLY, LIST_LIMIT } from '../whatsapp/calendar/manageReminders.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';

const MIN = 60_000;
// Sat 17 Oct 2026, 14:00 in London (BST).
const NOW = Date.parse('2026-10-17T14:00:00+01:00');
const OWNER = '447700900001@s.whatsapp.net';
const CHAT = OWNER;
const at = (local: string) => Date.parse(`${local}+01:00`);

const noExtraction = async () => {
  throw new Error('extraction should not run');
};

function send(text: string, deps: object, over: Partial<{ actorId: string | null; chatId: string; nowMs: number }> = {}) {
  const { nowMs = NOW, ...m } = over;
  return runReminderAgent(
    { text, chatId: CHAT, actorId: OWNER, ...m },
    { nowMs, isAllowedActor: () => true, extractReminder: noExtraction, ...deps }
  );
}

/** A week of Reminders around NOW. */
function seededCalendar() {
  const calendar = createFakeCalendar();
  calendar.seed({ id: 'past', title: 'Coffee', startMs: at('2026-10-17T09:00:00') });
  calendar.seed({ id: 'later', title: 'Haircut', startMs: at('2026-10-17T16:00:00') });
  calendar.seed({ id: 'gym', title: 'Gym', startMs: at('2026-10-18T19:00:00'), endMs: at('2026-10-18T20:00:00') });
  calendar.seed({ id: 'bday', title: "Mum's birthday", startDate: '2026-10-18' });
  calendar.seed({ id: 'standup', title: 'Standup', startMs: at('2026-10-18T09:30:00'), isOrganizer: false });
  calendar.seed({ id: 'nope', title: 'Declined thing', startMs: at('2026-10-18T11:00:00'), responseStatus: 'declined' });
  calendar.seed({ id: 'dentist', title: 'Dentist', startMs: Date.parse('2026-10-23T15:00:00+01:00'), endMs: Date.parse('2026-10-23T16:00:00+01:00') });
  calendar.seed({ id: 'trip', title: 'Trip', startDate: '2026-10-24', endDate: '2026-10-27' });
  return calendar;
}

describe('reminder intents (#128)', () => {
  it('reads list windows', () => {
    const cases = {
      "what's on tomorrow": 'tomorrow',
      'What’s on tomorrow?': 'tomorrow',
      'whats on this week': 'thisWeek',
      'what is on next week': 'nextWeek',
      'what have I got on today': 'today',
      "what's on for this week?": 'thisWeek',
      "what's on my calendar tomorrow": 'tomorrow',
      "what's on the calendar next week": 'nextWeek',
      'list reminders': 'upcoming',
      'show my reminders': 'upcoming',
      reminders: 'upcoming',
    };
    for (const [text, window] of Object.entries(cases)) {
      assert.deepEqual(classifyReminderIntent(text), { kind: 'list', window }, text);
      assert.equal(shouldTryReminderAgent(text), true, text);
    }
  });

  it('reads "cancel N" only as a whole message', () => {
    const cases: [string, number][] = [['cancel 2', 2], ['Cancel #3', 3], ['delete reminder 12', 12], ['remove 1.', 1], ['cancel my reminder #4', 4]];
    for (const [text, n] of cases) {
      assert.deepEqual(classifyReminderIntent(text), { kind: 'cancel', n }, text);
    }
    for (const text of ['remove 2 eggs from the list', 'cancel the 3 meetings please', 'cancel']) {
      assert.equal(classifyReminderIntent(text), null, text);
    }
    assert.deepEqual(classifyReminderIntent('remind me to cancel 2 subscriptions tomorrow at 9'), { kind: 'create' });
  });

  it('leaves look-alikes for other agents', () => {
    for (const text of ["what's on TV tonight", "what's the weather tomorrow", 'what is on my mind']) {
      assert.equal(shouldTryReminderAgent(text), false, text);
    }
  });
});

describe('reminder agent: list Reminders from the Owner\'s calendar (#128)', () => {
  it('"what\'s on tomorrow" lists tomorrow\'s Reminders as a numbered list, all-day by local date', async () => {
    const calendar = seededCalendar();
    const r = await send("what's on tomorrow", { calendar, lastLists: createLastLists() });
    assert.equal(r.handled, true);
    assert.equal(
      r.replyText,
      [
        'Tomorrow (Sun 18 Oct):',
        "1. Sun 18 Oct, all day: Mum's birthday",
        '2. Sun 18 Oct 09:30–10:00: Standup (invite)',
        '3. Sun 18 Oct 19:00–20:00: Gym',
        '',
        'Say "cancel <number>" to remove one.',
      ].join('\n')
    );
  });

  it('"what\'s on this week" runs from now to the end of Sunday, skipping what has finished', async () => {
    const calendar = seededCalendar();
    const r = await send("what's on this week", { calendar, lastLists: createLastLists() });
    const lines = r.replyText.split('\n');
    assert.equal(lines[0], 'This week:');
    assert.deepEqual(
      lines.filter((l) => /^\d+\./.test(l)).map((l) => l.replace(/^\d+\. /, '')),
      [
        'Sat 17 Oct 16:00–16:30: Haircut',
        "Sun 18 Oct, all day: Mum's birthday",
        'Sun 18 Oct 09:30–10:00: Standup (invite)',
        'Sun 18 Oct 19:00–20:00: Gym',
      ]
    );
  });

  it('"what\'s on next week" covers Monday to Sunday, with multi-day all-day Reminders', async () => {
    const calendar = seededCalendar();
    const r = await send("what's on next week", { calendar, lastLists: createLastLists() });
    assert.match(r.replyText, /^Next week \(Mon 19 Oct – Sun 25 Oct\):/);
    assert.match(r.replyText, /1\. Fri 23 Oct 15:00–16:00: Dentist/);
    assert.match(r.replyText, /2\. Sat 24 Oct – Mon 26 Oct, all day: Trip/);
    assert.doesNotMatch(r.replyText, /Gym|birthday/);
  });

  it('"list reminders" lists the next upcoming Reminders, capped, without declined invites', async () => {
    const calendar = seededCalendar();
    const r = await send('list reminders', { calendar, lastLists: createLastLists() });
    assert.match(r.replyText, /^Upcoming reminders:\n1\. Sat 17 Oct 16:00–16:30: Haircut/);
    assert.match(r.replyText, /6\. Sat 24 Oct – Mon 26 Oct, all day: Trip/);
    assert.doesNotMatch(r.replyText, /Coffee|Declined/);

    const busy = createFakeCalendar();
    for (let i = 0; i < LIST_LIMIT + 3; i++) busy.seed({ title: `Thing ${i}`, startMs: NOW + (i + 1) * 60 * MIN });
    const capped = await send('list reminders', { calendar: busy, lastLists: createLastLists() });
    assert.match(capped.replyText, new RegExp(`\\n${LIST_LIMIT}\\. `));
    assert.doesNotMatch(capped.replyText, new RegExp(`\\n${LIST_LIMIT + 1}\\. `));
    assert.match(capped.replyText, /…and 3 more\./);
  });

  it('says so when a window is empty', async () => {
    const r = await send("what's on tomorrow", { calendar: createFakeCalendar(), lastLists: createLastLists() });
    assert.equal(r.replyText, 'Nothing on tomorrow.');
  });

  it('replies clearly when Google Calendar is unreachable', async () => {
    const down = { ...createFakeCalendar(), listEvents: async () => { throw new Error('503') } };
    const lastLists = createLastLists();
    const r = await send('list reminders', { calendar: down, lastLists });
    assert.equal(r.replyText, CALENDAR_UNREACHABLE_LIST_REPLY);
    assert.equal(lastLists.get(CHAT, NOW), null);
  });

  it('uses the calendar\'s timezone for the window', async () => {
    const calendar = createFakeCalendar({ timeZone: 'America/New_York' });
    // 23:30 on Sat 17 Oct in London is 18:30 in New York: still Saturday there.
    calendar.seed({ title: 'Late call', startMs: Date.parse('2026-10-17T23:30:00+01:00') });
    const r = await send("what's on today", { calendar, lastLists: createLastLists() });
    assert.match(r.replyText, /^Today \(Sat 17 Oct\):\n1\. Sat 17 Oct 18:30–19:00: Late call/);
  });
});

describe('reminder agent: cancel N from the last list (#128)', () => {
  it('deletes item N of the last list shown in this chat', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    await send("what's on tomorrow", { calendar, lastLists });
    const r = await send('cancel 3', { calendar, lastLists });
    assert.equal(r.replyText, 'Cancelled #3: Gym');
    assert.equal(calendar.all().some((e) => e.id === 'gym'), false);

    // Numbers stay those of the list shown.
    const r2 = await send('cancel 1', { calendar, lastLists });
    assert.equal(r2.replyText, "Cancelled #1: Mum's birthday");
    assert.equal(calendar.all().some((e) => e.id === 'bday'), false);
  });

  it('resolves against the latest list, and lists are per chat', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    await send("what's on tomorrow", { calendar, lastLists });
    await send("what's on next week", { calendar, lastLists });
    const other = await send('cancel 1', { calendar, lastLists }, { chatId: 'other@s.whatsapp.net' });
    assert.match(other.replyText, /No recent reminder list/);
    const r = await send('cancel 1', { calendar, lastLists });
    assert.equal(r.replyText, 'Cancelled #1: Dentist');
  });

  it('with no recent list, deletes nothing', async () => {
    const calendar = seededCalendar();
    const before = calendar.all().length;
    const r = await send('cancel 1', { calendar, lastLists: createLastLists() });
    assert.equal(r.handled, true);
    assert.match(r.replyText, /No recent reminder list in this chat, so nothing was cancelled/);
    assert.equal(calendar.all().length, before);
  });

  it('after the list has expired, deletes nothing', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists({ ttlMs: 30 * MIN });
    await send("what's on tomorrow", { calendar, lastLists });
    const before = calendar.all().length;
    const r = await send('cancel 1', { calendar, lastLists }, { nowMs: NOW + 31 * MIN });
    assert.match(r.replyText, /No recent reminder list/);
    assert.equal(calendar.all().length, before);
  });

  it('with N out of range (or zero), deletes nothing', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    await send("what's on tomorrow", { calendar, lastLists });
    const before = calendar.all().length;
    for (const text of ['cancel 4', 'cancel 0']) {
      const r = await send(text, { calendar, lastLists });
      assert.match(r.replyText, /There's no #\d in the last list \(it has 3\), so nothing was cancelled/, text);
    }
    assert.equal(calendar.all().length, before);
  });

  it('after an empty list, deletes nothing', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    await send('cancel 1', { calendar, lastLists });
    await send("what's on today", { calendar: createFakeCalendar(), lastLists });
    const r = await send('cancel 1', { calendar, lastLists });
    assert.equal(r.replyText, 'The last list was empty, so nothing was cancelled.');
  });

  it('refuses an invite organised by someone else, with a hint to decline it in Calendar', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    await send("what's on tomorrow", { calendar, lastLists });
    const r = await send('cancel 2', { calendar, lastLists });
    assert.match(r.replyText, /"Standup" is an invite organised by someone else/);
    assert.match(r.replyText, /Decline it in Google Calendar/);
    assert.equal(calendar.all().some((e) => e.id === 'standup'), true);
  });

  it('the number in a creation reply works with "cancel N"', async () => {
    const calendar = createFakeCalendar();
    const lastLists = createLastLists();
    const text = 'Dentist Friday 3–4pm';
    const extractReminder = async () => ({ ok: true, title: 'Dentist', start: '2026-10-23T15:00', end: '2026-10-23T16:00', allDay: false, kind: 'appointment' });
    const created = await send(text, { calendar, lastLists, extractReminder });
    const n = Number(created.replyText.match(/\(#(\d+)\)/)?.[1]);
    assert.equal(n, 1);
    const r = await send(`cancel ${n}`, { calendar, lastLists });
    assert.equal(r.replyText, 'Cancelled #1: Dentist');
    assert.equal(calendar.all().length, 0);
  });

  it('replies clearly when the delete fails', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    await send("what's on tomorrow", { calendar, lastLists });
    const failing = { ...calendar, deleteEvent: async () => { throw new Error('503') } };
    const r = await send('cancel 1', { calendar: failing, lastLists });
    assert.match(r.replyText, /nothing was cancelled/);
    assert.equal(calendar.all().some((e) => e.id === 'bday'), true);
  });
});

describe('reminder agent: access and setup (#128)', () => {
  it('list and cancel need an allowlisted actor; help does not', async () => {
    const calendar = seededCalendar();
    const lastLists = createLastLists();
    for (const text of ["what's on tomorrow", 'list reminders', 'cancel 1']) {
      const r = await send(text, { calendar, lastLists, isAllowedActor: () => false }, { actorId: 'x@s.whatsapp.net' });
      assert.match(r.replyText, /Not allowed to manage reminders/, text);
    }
    assert.equal(lastLists.get(CHAT, NOW), null);
    const help = await send('reminder help', { isAllowedActor: () => false });
    assert.equal(help.replyText, REMINDER_HELP_TEXT);
  });

  it('without Google Calendar, says it is not connected (and lets appointment guesses fall through)', async () => {
    for (const text of ['list reminders', 'cancel 1', 'remind me in 20 minutes to stretch']) {
      const r = await send(text, { calendar: undefined });
      assert.equal(r.replyText, CALENDAR_NOT_CONNECTED_REPLY, text);
    }
    for (const text of ['reminder help', 'help reminders', 'help with reminders', '!reminders', '!reminder']) {
      for (const extractReminder of [undefined, noExtraction]) {
        const r = await send(text, { calendar: undefined, extractReminder, isAllowedActor: undefined });
        assert.equal(r.replyText, REMINDER_HELP_TEXT, text);
      }
    }
    const guess = await send('dentist Friday 3pm', { calendar: undefined });
    assert.equal(guess.handled, false);
  });

  it('help documents the list windows and "cancel N"', () => {
    assert.match(REMINDER_HELP_TEXT, /what's on tomorrow/);
    assert.match(REMINDER_HELP_TEXT, /what's on this week/);
    assert.match(REMINDER_HELP_TEXT, /list reminders/);
    assert.match(REMINDER_HELP_TEXT, /cancel 2/);
    assert.match(REMINDER_HELP_TEXT, /decline them in Google Calendar/);
  });
});
