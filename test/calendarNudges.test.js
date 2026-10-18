import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runNudgeTick } from '../whatsapp/calendar/nudgeTick.js';
import { createFakeCalendar } from './helpers/fakeCalendar.js';

const MIN = 60_000;
const OWNER = '447700900001@s.whatsapp.net';
// Mon 19 Oct 2026, 09:00 London (BST, UTC+1)
const T0 = Date.parse('2026-10-19T08:00:00Z');

describe('calendar nudge tick', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let logPath;
  /** @type {{ chatId: string, text: string }[]} */
  let sent;
  /** @type {ReturnType<typeof createFakeCalendar>} */
  let calendar;
  let now = T0;

  const tick = (overrides = {}) =>
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
  const advance = async (/** @type {number} */ ms) => {
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
});
