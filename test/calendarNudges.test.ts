import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runNudgeTick } from '../whatsapp/calendar/nudgeTick.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';

const MIN = 60_000;
const OWNER = '447700900001@s.whatsapp.net';
// Mon 19 Oct 2026, 09:00 London (BST, UTC+1)
const T0 = Date.parse('2026-10-19T08:00:00Z');

describe('calendar nudge tick', () => {
  let dir: string;
  let logPath: string;
  let sent: { chatId: string; text: string }[];
  let calendar: ReturnType<typeof createFakeCalendar>;
  let now = T0;

  const tick = (overrides: Partial<Parameters<typeof runNudgeTick>[0]> = {}) =>
    runNudgeTick({
      calendar,
      ownerChatId: OWNER,
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      logPath,
      ...overrides,
    });
  /** Advance the clock, running a tick every minute (like the poller would). */
  const advance = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + MIN);
      await tick();
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nudges-'));
    logPath = join(dir, 'nudged.json');
    sent = [];
    now = T0;
    calendar = createFakeCalendar({ defaultOffsetsMin: [10] });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('nudges once at the calendar default notification time', async () => {
    calendar.seed({ title: 'Standup', startMs: T0 + 60 * MIN });
    await tick();
    await advance(49 * MIN);
    assert.equal(sent.length, 0);
    await advance(1 * MIN);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, OWNER);
    assert.match(sent[0].text, /Standup/);
    await advance(30 * MIN);
    assert.equal(sent.length, 1);
  });
  it('nudges at each explicit override, not the defaults', async () => {
    calendar.seed({
      title: 'Dentist',
      startMs: T0 + 2 * 60 * MIN,
      notifications: { mode: 'explicit', offsetsMin: [60, 5] },
    });
    await advance(60 * MIN); // T0+60 = 60 min before
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /in 1 h/);
    await advance(54 * MIN);
    assert.equal(sent.length, 1);
    await advance(1 * MIN); // 5 min before
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /in 5 min/);
    await advance(120 * MIN);
    assert.equal(sent.length, 2);
  });

  it('never nudges when notifications are switched off', async () => {
    calendar.seed({ startMs: T0 + 20 * MIN, notifications: { mode: 'none' } });
    await advance(60 * MIN);
    assert.equal(sent.length, 0);
  });

  it('skips declined invites but nudges unanswered and tentative ones', async () => {
    calendar.seed({ title: 'Declined one', startMs: T0 + 5 * MIN, responseStatus: 'declined', isOrganizer: false });
    calendar.seed({ title: 'Tentative one', startMs: T0 + 5 * MIN, responseStatus: 'tentative', isOrganizer: false });
    calendar.seed({ title: 'Unanswered one', startMs: T0 + 5 * MIN, responseStatus: 'needsAction', isOrganizer: false });
    await tick();
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /Declined one/);
    assert.match(sent[0].text, /Tentative one/);
    assert.match(sent[0].text, /Unanswered one/);
  });

  it('nudges every occurrence of a recurring event', async () => {
    const DAY = 24 * 60 * MIN;
    for (let i = 0; i < 3; i++) {
      calendar.seed({ id: `standup_${i}`, title: 'Standup', startMs: T0 + 30 * MIN + i * DAY });
    }
    await advance(3 * DAY);
    assert.equal(sent.length, 3);
  });

  it('shows title, start time, how far away, location and first description line', async () => {
    calendar.seed({
      title: 'Dentist',
      startMs: T0 + 10 * MIN,
      location: '12 High St',
      description: '\nBring the form\nsecond line',
    });
    await tick();
    assert.equal(sent.length, 1);
    const text = sent[0].text;
    assert.match(text, /Dentist/);
    assert.match(text, /Mon 19 Oct,? 09:10/);
    assert.match(text, /in 10 min/);
    assert.match(text, /12 High St/);
    assert.match(text, /Bring the form/);
    assert.doesNotMatch(text, /second line/);
  });

  it('omits location and description lines when absent', async () => {
    calendar.seed({ title: 'Call', startMs: T0 + 10 * MIN });
    await tick();
    assert.equal(sent[0].text.split('\n').length, 2);
  });

  it('nudges at most once across restarts (fresh tick, same log)', async () => {
    calendar.seed({ title: 'Once', startMs: T0 + 10 * MIN });
    await tick();
    await tick();
    now += 2 * MIN;
    await tick();
    assert.equal(sent.length, 1);
  });

  it('writes the nudged log before sending, so a failed send is not retried', async () => {
    calendar.seed({ title: 'Fragile', startMs: T0 + 10 * MIN });
    let seenLogAtSend = '';
    await tick({
      sendText: async () => {
        seenLogAtSend = await readFile(logPath, 'utf8');
        throw new Error('socket closed');
      },
    });
    assert.match(seenLogAtSend, /evt\d+\|/);
    await tick();
    assert.equal(sent.length, 0);
  });

  it('prunes the log once the occurrence has ended', async () => {
    calendar.seed({ startMs: T0 + 10 * MIN, endMs: T0 + 20 * MIN });
    await tick();
    assert.equal(Object.keys(JSON.parse(await readFile(logPath, 'utf8')).entries).length, 1);
    await advance(21 * MIN);
    assert.equal(Object.keys(JSON.parse(await readFile(logPath, 'utf8')).entries).length, 0);
  });

  it('does not nudge at the old time when an event is moved', async () => {
    const evt = calendar.seed({ title: 'Moved', startMs: T0 + 60 * MIN });
    await advance(30 * MIN);
    calendar.move(evt.id, T0 + 3 * 60 * MIN);
    await advance(60 * MIN); // past the old alert time
    assert.equal(sent.length, 0);
    await advance(100 * MIN); // new alert at T0+170
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Mon 19 Oct,? 12:00/);
  });

  it('does not nudge when an event is deleted before its alert time', async () => {
    const evt = calendar.seed({ title: 'Gone', startMs: T0 + 60 * MIN });
    await advance(30 * MIN);
    calendar.remove(evt.id);
    await advance(60 * MIN);
    assert.equal(sent.length, 0);
  });

  it('after an outage, sends only not-yet-ended Reminders, merged into one message', async () => {
    calendar.seed({ title: 'Already over', startMs: T0 + 10 * MIN, endMs: T0 + 40 * MIN });
    calendar.seed({ title: 'In progress', startMs: T0 + 50 * MIN, endMs: T0 + 120 * MIN });
    calendar.seed({
      title: 'Coming up',
      startMs: T0 + 100 * MIN,
      notifications: { mode: 'explicit', offsetsMin: [60, 30] },
    });
    calendar.seed({ title: 'Later', startMs: T0 + 5 * 60 * MIN });
    now = T0 + 80 * MIN; // bot comes back
    await tick();
    assert.equal(sent.length, 1);
    const text = sent[0].text;
    assert.doesNotMatch(text, /Already over/);
    assert.doesNotMatch(text, /Later/);
    assert.match(text, /In progress/);
    assert.match(text, /started 30 min ago/);
    assert.equal(text.match(/Coming up/g)?.length, 1);
    await advance(30 * MIN);
    assert.equal(sent.length, 1);
  });

  it('does not nudge again when an event is extended after its nudge', async () => {
    const evt = calendar.seed({ title: 'Long', startMs: T0 + 5 * MIN, endMs: T0 + 30 * MIN });
    await tick();
    calendar.move(evt.id, T0 + 5 * MIN, T0 + 120 * MIN);
    await advance(60 * MIN);
    assert.equal(sent.length, 1);
  });

  describe('Reminders created by SECOND_PHONE (#129)', () => {
    const SECOND = '447700900002@s.whatsapp.net';
    const SECOND_LID = '222222222222222@lid';
    /** Stand-in for the allowlist: SECOND_PHONE's chat for its own ids, else null. */
    const creatorChatId = (id: string) => (id === SECOND || id === SECOND_LID ? SECOND : null);
    const tickWithCreators = () => tick({ creatorChatId });

    it('Nudges both the owner and SECOND_PHONE at each Alert time', async () => {
      calendar.seed({
        title: 'Vet',
        startMs: T0 + 30 * MIN,
        notifications: { mode: 'explicit', offsetsMin: [30, 0] },
        createdByBot: true,
        creatorActorId: SECOND,
      });
      await tickWithCreators();
      assert.deepEqual(sent.map((s) => s.chatId).sort(), [OWNER, SECOND]);
      assert.match(sent[0].text, /Vet/);
      assert.equal(sent[0].text, sent[1].text);
      now += 30 * MIN;
      await tickWithCreators();
      assert.equal(sent.length, 4);
      assert.deepEqual(sent.slice(2).map((s) => s.chatId).sort(), [OWNER, SECOND]);
    });

    it('Nudges only the owner for Reminders the owner created, or not created by the bot', async () => {
      calendar.seed({ title: 'Mine', startMs: T0, createdByBot: true, creatorActorId: OWNER });
      calendar.seed({ title: 'From Google', startMs: T0, creatorActorId: null });
      await tickWithCreators();
      assert.deepEqual(sent.map((s) => s.chatId), [OWNER]);
    });

    it('ignores a recorded creator on an event the bot did not create', async () => {
      calendar.seed({ title: 'Odd', startMs: T0, createdByBot: false, creatorActorId: SECOND });
      await tickWithCreators();
      assert.deepEqual(sent.map((s) => s.chatId), [OWNER]);
    });

    it('without a creator lookup, Nudges only the owner', async () => {
      calendar.seed({ title: 'Vet', startMs: T0, createdByBot: true, creatorActorId: SECOND });
      await tick();
      assert.deepEqual(sent.map((s) => s.chatId), [OWNER]);
    });

    it('catch-up merges per recipient: one message each, SECOND_PHONE sees only its own', async () => {
      calendar.seed({ title: 'Owner thing', startMs: T0 + 50 * MIN, endMs: T0 + 120 * MIN });
      calendar.seed({ title: 'Vet', startMs: T0 + 60 * MIN, createdByBot: true, creatorActorId: SECOND });
      calendar.seed({ title: 'School run', startMs: T0 + 70 * MIN, createdByBot: true, creatorActorId: SECOND_LID });
      now = T0 + 80 * MIN;
      await tickWithCreators();
      assert.equal(sent.length, 2);
      const owner = sent.find((s) => s.chatId === OWNER);
      const second = sent.find((s) => s.chatId === SECOND);
      assert.match(owner?.text ?? '', /3 reminders/);
      assert.match(second?.text ?? '', /2 reminders/);
      assert.doesNotMatch(second?.text ?? '', /Owner thing/);
    });

    it("a failed send to one recipient doesn't stop the other", async () => {
      calendar.seed({ title: 'Vet', startMs: T0, createdByBot: true, creatorActorId: SECOND });
      const r = await tick({
        creatorChatId,
        sendText: async (chatId, text) => {
          if (chatId === OWNER) throw new Error('boom');
          sent.push({ chatId, text });
        },
      });
      assert.deepEqual(sent.map((s) => s.chatId), [SECOND]);
      assert.equal(r.messages, 1);
    });
  });

  describe('all-day Reminders', () => {
    const DAY = 24 * 60 * MIN;
    // Mon 19 Oct 2026, 00:00 London (BST)
    const MIDNIGHT = Date.parse('2026-10-18T23:00:00Z');

    it('without overrides, nudges once that day at the all-day nudge time (local)', async () => {
      now = MIDNIGHT - 60 * MIN;
      calendar.seed({ title: "Mum's birthday", startDate: '2026-10-19' });
      await advance(60 * MIN + 9 * 60 * MIN - MIN); // 08:59 local
      assert.equal(sent.length, 0);
      await advance(MIN); // 09:00 local
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Mum's birthday/);
      assert.match(sent[0].text, /Mon 19 Oct/);
      assert.match(sent[0].text, /all day/);
      assert.doesNotMatch(sent[0].text, /09:00/);
      await advance(DAY);
      assert.equal(sent.length, 1);
    });

    it('uses the configured all-day nudge time', async () => {
      now = MIDNIGHT;
      calendar.seed({ title: 'Holiday', startDate: '2026-10-19' });
      await advance(7 * 60 * MIN + 29 * MIN);
      await tick({ allDayNudgeMin: 7 * 60 + 30 });
      assert.equal(sent.length, 0);
      now += MIN;
      await tick({ allDayNudgeMin: 7 * 60 + 30 });
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /all day, today/);
    });

    it('with overrides, nudges at each one (counted back from local midnight), not the fixed time', async () => {
      now = MIDNIGHT - DAY;
      calendar.seed({
        title: 'Trip',
        startDate: '2026-10-19',
        endDate: '2026-10-22',
        notifications: { mode: 'explicit', offsetsMin: [15 * 60] }, // 09:00 the day before
      });
      await advance(9 * 60 * MIN - MIN);
      assert.equal(sent.length, 0);
      await advance(MIN); // Sun 18 Oct, 09:00 local
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Trip/);
      assert.match(sent[0].text, /Mon 19 Oct – Wed 21 Oct \(all day, tomorrow\)/);
      await advance(2 * DAY); // through the default all-day nudge time
      assert.equal(sent.length, 1);
    });

    it('never nudges when notifications are switched off', async () => {
      now = MIDNIGHT;
      calendar.seed({ startDate: '2026-10-19', notifications: { mode: 'none' } });
      await advance(DAY);
      assert.equal(sent.length, 0);
    });

    it('after an outage, drops ended all-day Reminders and still nudges ongoing ones', async () => {
      calendar.seed({ title: 'Yesterday thing', startDate: '2026-10-18' });
      calendar.seed({ title: 'Conference', startDate: '2026-10-18', endDate: '2026-10-21' });
      calendar.seed({ title: 'Today thing', startDate: '2026-10-19' });
      now = MIDNIGHT + 30 * MIN; // back at 00:30 local Monday; 09:00 Sunday was missed
      await tick();
      assert.equal(sent.length, 1);
      assert.doesNotMatch(sent[0].text, /Yesterday thing/);
      assert.doesNotMatch(sent[0].text, /Today thing/);
      assert.match(sent[0].text, /Conference/);
      assert.match(sent[0].text, /all day, today/);
      await advance(9 * 60 * MIN);
      assert.equal(sent.length, 2);
      assert.match(sent[1].text, /Today thing/);
      assert.doesNotMatch(sent[1].text, /Conference|Yesterday thing/);
    });
  });

  describe('outage catch-up', () => {
    it('while Google is unreachable nothing is sent; on recovery overdue Nudges go out as one message', async () => {
      calendar.seed({ title: 'Over during outage', startMs: T0 + 10 * MIN, endMs: T0 + 30 * MIN });
      calendar.seed({ title: 'Ongoing', startMs: T0 + 20 * MIN, endMs: T0 + 90 * MIN });
      calendar.seed({ title: 'Soon', startMs: T0 + 70 * MIN });
      calendar.seed({ title: "Mum's birthday", startDate: '2026-10-19' });
      const listEvents = calendar.listEvents;
      const down = { ...calendar, listEvents: async () => { throw new Error('Google 503') } };
      for (; now < T0 + 65 * MIN; now += MIN) {
        await assert.rejects(tick({ calendar: down }));
      }
      assert.equal(sent.length, 0);
      calendar.listEvents = listEvents;
      await tick();
      assert.equal(sent.length, 1);
      const text = sent[0].text;
      assert.match(text, /^⏰ 3 reminders:/);
      assert.match(text, /Ongoing/);
      assert.match(text, /Soon/);
      assert.match(text, /Mum's birthday/);
      assert.doesNotMatch(text, /Over during outage/);
      await advance(60 * MIN);
      assert.equal(sent.length, 1);
    });

    it('records overdue Nudges of ended Reminders as handled, so they are never sent', async () => {
      // Tokyo is UTC+9: an all-day Reminder's local day ends at 15:00 UTC, but the calendar
      // (UTC-midnight endMs) keeps listing it until 00:00 UTC.
      calendar = createFakeCalendar({ timeZone: 'Asia/Tokyo' });
      calendar.seed({ title: 'Ended', startDate: '2026-10-18' });
      now = Date.parse('2026-10-18T16:00:00Z'); // back after the 09:00 local Alert time and the day's end
      const first = await tick();
      assert.equal(first.nudged, 0);
      assert.equal(first.dropped, 1);
      await advance(7 * 60 * MIN);
      assert.equal(sent.length, 0);
      const later = await tick();
      assert.equal(later.dropped, 0);
    });
  });
});
