import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildBriefing } from '../whatsapp/briefing/buildBriefing.ts';
import { runBriefingTick } from '../whatsapp/briefing/briefingTick.ts';
import { createLastLists } from '../whatsapp/calendar/lastLists.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';
import type { Forecast } from '../whatsapp/agents/weatherAgent.ts';

const MIN = 60_000;
const OWNER = '447700900001@s.whatsapp.net';
// Mon 19 Oct 2026, 07:00 London (BST, UTC+1)
const T0 = Date.parse('2026-10-19T06:00:00Z');

const FORECAST: Forecast = {
  list: [{ weather: [{ description: 'light rain' }], main: { temp: 9.4, humidity: 80 }, dt_txt: '2026-10-19 09:00:00' }],
};

describe('daily Briefing tick (#158)', () => {
  let dir: string;
  let logPath: string;
  let sent: { chatId: string; text: string }[];
  let calendar: ReturnType<typeof createFakeCalendar> | null;
  let weatherDown: boolean;
  let now = T0;

  const tick = (overrides: Partial<Parameters<typeof runBriefingTick>[0]> = {}) =>
    runBriefingTick({
      calendar,
      getForecast: async () => {
        if (weatherDown) throw new Error('weather down');
        return FORECAST;
      },
      summarizeWeather: async () => 'Light rain, take a jacket.',
      lastLists: createLastLists(),
      city: 'Manchester',
      ownerChatId: OWNER,
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      logPath,
      ...overrides,
    });
  /** Advance the clock, running a tick every minute (like the scheduler would). */
  const advance = async (ms: number, overrides: Partial<Parameters<typeof runBriefingTick>[0]> = {}) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + MIN);
      await tick(overrides);
    }
  };
  const failCalendar = () => {
    calendar!.listEvents = async () => {
      throw new Error('calendar down');
    };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'briefing-'));
    logPath = join(dir, 'briefing-sent.json');
    sent = [];
    now = T0;
    weatherDown = false;
    calendar = createFakeCalendar();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the Briefing to the owner once, at the send time', async () => {
    calendar!.seed({ title: 'Dentist', startMs: Date.parse('2026-10-19T15:00:00+01:00') });
    await tick();
    await advance(29 * MIN);
    assert.equal(sent.length, 0, 'nothing before 07:30');
    await advance(1 * MIN);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, OWNER);
    assert.match(sent[0].text, /^☀️ Briefing for Mon 19 Oct/);
    assert.match(sent[0].text, /Light rain, take a jacket\./);
    assert.match(sent[0].text, /Dentist/);
    await advance(4 * 60 * MIN);
    assert.equal(sent.length, 1, 'not again later that morning');
  });

  it('is the same text as the on-demand Briefing', async () => {
    now = Date.parse('2026-10-19T08:00:00+01:00');
    await tick();
    const onDemand = await buildBriefing({
      calendar,
      getForecast: async () => FORECAST,
      summarizeWeather: async () => 'Light rain, take a jacket.',
      lastLists: createLastLists(),
      nowMs: now,
      city: 'Manchester',
      chatId: OWNER,
    });
    assert.equal(sent[0].text, onDemand.text);
  });

  it('sends nothing from 12:00 on', async () => {
    now = Date.parse('2026-10-19T12:00:00+01:00');
    await tick();
    await advance(11 * 60 * MIN);
    assert.equal(sent.length, 0);
  });

  it('catches up late in the morning when the bot was down at the send time', async () => {
    now = Date.parse('2026-10-19T11:59:00+01:00');
    await tick();
    assert.equal(sent.length, 1);
  });

  it("doesn't send again after a restart (the sent log is on disk)", async () => {
    now = Date.parse('2026-10-19T07:45:00+01:00');
    await tick();
    // a fresh tick, as after a restart: only the log carries state
    now += 10 * MIN;
    await tick({ lastLists: createLastLists() });
    assert.equal(sent.length, 1);
  });

  it('sends again the next day', async () => {
    now = Date.parse('2026-10-19T07:30:00+01:00');
    await tick();
    await advance(24 * 60 * MIN);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /Briefing for Tue 20 Oct/);
  });

  it('uses BRIEFING_TIME', async () => {
    await advance(59 * MIN, { sendAtMin: 8 * 60 });
    assert.equal(sent.length, 0);
    await advance(1 * MIN, { sendAtMin: 8 * 60 });
    assert.equal(sent.length, 1);
  });

  describe('30-minute grace before a partial Briefing (#159)', () => {
    it('sends nothing for 30 minutes while one section fails, then the partial Briefing', async () => {
      weatherDown = true;
      now = Date.parse('2026-10-19T07:30:00+01:00');
      assert.deepEqual(await tick(), { sent: false, reason: 'grace period' });
      await advance(29 * MIN);
      assert.equal(sent.length, 0, 'still in the grace period');
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Couldn't reach the weather service for Manchester\./);
      assert.match(sent[0].text, /Nothing on today\./);
      weatherDown = false;
      await advance(30 * MIN);
      assert.equal(sent.length, 1, 'the day is marked');
    });

    it('sends the weather with the calendar line once the grace ends when only the calendar fails', async () => {
      failCalendar();
      now = Date.parse('2026-10-19T07:30:00+01:00');
      await tick();
      await advance(29 * MIN);
      assert.equal(sent.length, 0);
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Couldn't reach Google Calendar\./);
      assert.match(sent[0].text, /Light rain/);
    });

    it('sends the full Briefing when the failing section recovers during the grace', async () => {
      const listEvents = calendar!.listEvents;
      failCalendar();
      now = Date.parse('2026-10-19T07:30:00+01:00');
      await tick();
      await advance(10 * MIN);
      assert.equal(sent.length, 0);
      calendar!.listEvents = listEvents;
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
      assert.doesNotMatch(sent[0].text, /Couldn't reach/);
      assert.match(sent[0].text, /Nothing on today\./);
      await advance(60 * MIN);
      assert.equal(sent.length, 1, 'the day is marked');
    });

    it('starts the grace at the first attempt when the bot came up after the send time', async () => {
      weatherDown = true;
      now = Date.parse('2026-10-19T09:00:00+01:00');
      await tick();
      await advance(29 * MIN);
      assert.equal(sent.length, 0);
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Couldn't reach the weather service/);
    });

    it("doesn't restart the grace after a restart (the grace start is in the sent log)", async () => {
      weatherDown = true;
      now = Date.parse('2026-10-19T07:30:00+01:00');
      await tick();
      now = Date.parse('2026-10-19T08:00:00+01:00');
      await tick({ lastLists: createLastLists() });
      assert.equal(sent.length, 1);
    });

    it("doesn't carry the grace over from the previous day", async () => {
      weatherDown = true;
      now = Date.parse('2026-10-19T07:30:00+01:00');
      await tick();
      await advance(30 * MIN);
      assert.equal(sent.length, 1);
      now = Date.parse('2026-10-20T07:30:00+01:00');
      assert.deepEqual(await tick(), { sent: false, reason: 'grace period' });
      await advance(30 * MIN);
      assert.equal(sent.length, 2);
      assert.match(sent[1].text, /Briefing for Tue 20 Oct/);
    });

    it('starts the grace when only one section is failing, not while both are', async () => {
      weatherDown = true;
      failCalendar();
      now = Date.parse('2026-10-19T07:30:00+01:00');
      assert.deepEqual(await tick(), { sent: false, reason: 'all sections failed' });
      await advance(10 * MIN);
      weatherDown = false;
      await advance(1 * MIN);
      await advance(29 * MIN);
      assert.equal(sent.length, 0, 'grace started at 07:41');
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Couldn't reach Google Calendar\./);
    });

    it('ends the grace when the failing section recovers, even if that send fails', async () => {
      const listEvents = calendar!.listEvents;
      failCalendar();
      now = Date.parse('2026-10-19T07:30:00+01:00');
      await tick();
      calendar!.listEvents = listEvents;
      now += 10 * MIN;
      const failed = await tick({
        sendText: async () => {
          throw new Error('socket closed');
        },
      });
      assert.deepEqual(failed, { sent: false, reason: 'send failed' });
      failCalendar();
      // after a restart: only the sent log carries state
      await advance(30 * MIN, { lastLists: createLastLists() });
      assert.equal(sent.length, 0, 'a new grace started at 07:41');
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
    });
  });

  it('sends nothing when both sections fail, and retries until 12:00', async () => {
    weatherDown = true;
    failCalendar();
    now = Date.parse('2026-10-19T07:30:00+01:00');
    await tick();
    await advance(60 * MIN);
    assert.equal(sent.length, 0);
    weatherDown = false;
    calendar = createFakeCalendar();
    await advance(1 * MIN);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /Couldn't reach/);
  });

  it("doesn't mark the day when the send fails, so the next tick retries", async () => {
    now = Date.parse('2026-10-19T07:30:00+01:00');
    const failed = await tick({
      sendText: async () => {
        throw new Error('socket closed');
      },
    });
    assert.deepEqual(failed, { sent: false, reason: 'send failed' });
    await advance(1 * MIN);
    assert.equal(sent.length, 1);
    await advance(10 * MIN);
    assert.equal(sent.length, 1);
  });

  it('gives up at 12:00 when both sections keep failing', async () => {
    weatherDown = true;
    failCalendar();
    now = Date.parse('2026-10-19T07:30:00+01:00');
    await advance(5 * 60 * MIN);
    assert.equal(sent.length, 0);
  });

  it('without a calendar, sends weather only, and nothing when the weather fails', async () => {
    calendar = null;
    weatherDown = true;
    now = Date.parse('2026-10-19T07:30:00+01:00');
    await tick();
    assert.equal(sent.length, 0);
    weatherDown = false;
    await advance(1 * MIN);
    assert.equal(sent.length, 1, 'no grace: a missing calendar is not a failed section');
    assert.match(sent[0].text, /Light rain/);
    assert.doesNotMatch(sent[0].text, /Couldn't reach/);
  });

  describe("day boundaries in the calendar's timezone (Pacific/Auckland, UTC+13)", () => {
    beforeEach(() => {
      calendar = createFakeCalendar({ timeZone: 'Pacific/Auckland' });
    });

    it("sends at 07:30 Auckland, which is the previous UTC day", async () => {
      // Tue 20 Oct 07:29 Auckland = Mon 19 Oct 18:29 UTC
      now = Date.parse('2026-10-19T18:29:00Z');
      await tick();
      assert.equal(sent.length, 0);
      await advance(1 * MIN);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Briefing for Tue 20 Oct/);
    });

    it('counts "once per day" by the Auckland date, not the UTC one', async () => {
      // Tue 20 Oct 11:50 Auckland = Mon 19 Oct 22:50 UTC; the UTC date flips at 13:00 Auckland
      now = Date.parse('2026-10-19T22:50:00Z');
      await tick();
      assert.equal(sent.length, 1);
      await advance(3 * 60 * MIN);
      assert.equal(sent.length, 1, 'past UTC midnight, still the same Auckland day');
      // Wed 21 Oct 07:30 Auckland
      now = Date.parse('2026-10-20T18:30:00Z');
      await tick();
      assert.equal(sent.length, 2);
      assert.match(sent[1].text, /Briefing for Wed 21 Oct/);
    });
  });
});
