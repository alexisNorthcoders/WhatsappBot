import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefing, plainWeatherLine } from '../whatsapp/briefing/buildBriefing.ts';
import { createLastLists } from '../whatsapp/calendar/lastLists.ts';
import { LIST_LIMIT } from '../whatsapp/calendar/manageReminders.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';
import type { Forecast } from '../whatsapp/agents/weatherAgent.ts';

const MIN = 60_000;
// Sat 17 Oct 2026, 14:00 in London (BST).
const NOW = Date.parse('2026-10-17T14:00:00+01:00');
const CHAT = '447700900001@s.whatsapp.net';
const at = (local: string) => Date.parse(`${local}+01:00`);

const FORECAST: Forecast = {
  list: [
    { weather: [{ description: 'light rain' }], main: { temp: 9.4, humidity: 80 }, dt_txt: '2026-10-17 15:00:00' },
    { weather: [{ description: 'light rain' }], main: { temp: 11.6, humidity: 80 }, dt_txt: '2026-10-17 18:00:00' },
    { weather: [{ description: 'clear sky' }], main: { temp: 6.8, humidity: 70 }, dt_txt: '2026-10-17 21:00:00' },
  ],
};

function deps(over: Partial<Parameters<typeof buildBriefing>[0]> = {}) {
  const summarized: string[] = [];
  const cities: string[] = [];
  const lastLists = createLastLists();
  return {
    summarized,
    cities,
    lastLists,
    deps: {
      calendar: createFakeCalendar(),
      getForecast: async (city: string) => {
        cities.push(city);
        return FORECAST;
      },
      summarizeWeather: async (text: string) => {
        summarized.push(text);
        return 'Light rain this afternoon, take a jacket.';
      },
      lastLists,
      nowMs: NOW,
      city: 'Manchester',
      chatId: CHAT,
      ...over,
    },
  };
}

describe('Briefing builder (#157)', () => {
  it("has a weather sentence and what's left of today, numbered and remembered", async () => {
    const calendar = createFakeCalendar();
    calendar.seed({ id: 'past', title: 'Coffee', startMs: at('2026-10-17T09:00:00') });
    calendar.seed({ id: 'later', title: 'Haircut', startMs: at('2026-10-17T16:00:00') });
    calendar.seed({ id: 'invite', title: 'Call', startMs: at('2026-10-17T15:00:00'), isOrganizer: false });
    calendar.seed({ id: 'nope', title: 'Declined thing', startMs: at('2026-10-17T17:00:00'), responseStatus: 'declined' });
    calendar.seed({ id: 'trip', title: 'Trip', startDate: '2026-10-15', endDate: '2026-10-19' });
    calendar.seed({ id: 'tomorrow', title: 'Gym', startMs: at('2026-10-18T09:00:00') });
    const t = deps({ calendar });

    const result = await buildBriefing(t.deps);

    assert.deepEqual(result.failed, { weather: false, reminders: false });
    assert.equal(
      result.text,
      [
        '☀️ Briefing for Sat 17 Oct',
        '',
        '🌦 Manchester: Light rain this afternoon, take a jacket.',
        '',
        'Today (Sat 17 Oct):',
        '1. Thu 15 Oct – Sun 18 Oct, all day: Trip',
        '2. Sat 17 Oct 15:00–15:30: Call (invite)',
        '3. Sat 17 Oct 16:00–16:30: Haircut',
        '',
        'Say "cancel <number>" to remove one.',
      ].join('\n'),
    );
    assert.deepEqual(t.cities, ['Manchester']);
    assert.match(t.summarized[0], /Location query: Manchester\n2026-10-17 15:00:00: light rain, temp 9.4°C/);
    assert.deepEqual(t.lastLists.get(CHAT, NOW)?.map((e) => e.id), ['trip', 'invite', 'later']);
  });

  it('caps a long day like the other lists', async () => {
    const calendar = createFakeCalendar();
    for (let i = 0; i < LIST_LIMIT + 2; i++) {
      calendar.seed({ title: `R${i}`, startMs: at('2026-10-17T15:00:00') + i * MIN });
    }
    const result = await buildBriefing(deps({ calendar }).deps);
    assert.match(result.text, new RegExp(`\n${LIST_LIMIT}\\. .*R${LIST_LIMIT - 1}\n…and 2 more\\.`));
  });

  it('names the next upcoming Reminder on an empty day', async () => {
    const calendar = createFakeCalendar();
    calendar.seed({ title: 'Dentist', startMs: at('2026-10-23T15:00:00'), endMs: at('2026-10-23T16:00:00') });
    calendar.seed({ title: 'Later still', startMs: at('2026-10-30T15:00:00') });
    const t = deps({ calendar });
    const result = await buildBriefing(t.deps);
    assert.match(result.text, /\n\nNothing on today\.\nNext: Fri 23 Oct 15:00–16:00: Dentist$/);
    assert.deepEqual(t.lastLists.get(CHAT, NOW), []);
  });

  it('still says "nothing on today" when only the look-ahead fails', async () => {
    const calendar = createFakeCalendar();
    const list = calendar.listEvents;
    let calls = 0;
    calendar.listEvents = async (q) => {
      if (calls++) throw new Error('503');
      return list(q);
    };
    const result = await buildBriefing(deps({ calendar }).deps);
    assert.deepEqual(result.failed, { weather: false, reminders: false });
    assert.match(result.text, /\n\nNothing on today\.$/);
  });

  it('says just "nothing on today" with nothing in the next 60 days', async () => {
    const calendar = createFakeCalendar();
    calendar.seed({ title: 'Far off', startMs: at('2027-01-30T15:00:00') });
    const result = await buildBriefing(deps({ calendar }).deps);
    assert.match(result.text, /\n\nNothing on today\.$/);
  });

  it('is weather only without a calendar, with no calendar error', async () => {
    const result = await buildBriefing(deps({ calendar: null }).deps);
    assert.deepEqual(result.failed, { weather: false, reminders: false });
    assert.doesNotMatch(result.text, /calendar|today/i);
    assert.match(result.text, /🌦 Manchester: Light rain/);
  });

  it('keeps the weather and says so when Google Calendar fails', async () => {
    const calendar = createFakeCalendar();
    calendar.listEvents = async () => {
      throw new Error('503');
    };
    const result = await buildBriefing(deps({ calendar }).deps);
    assert.deepEqual(result.failed, { weather: false, reminders: true });
    assert.match(result.text, /🌦 Manchester: Light rain[^]*\n\nCouldn't reach Google Calendar\.$/);
  });

  it('keeps the Reminders and says so when the forecast fails', async () => {
    const calendar = createFakeCalendar();
    calendar.seed({ title: 'Haircut', startMs: at('2026-10-17T16:00:00') });
    const t = deps({
      calendar,
      getForecast: async () => {
        throw new Error('down');
      },
    });
    const result = await buildBriefing(t.deps);
    assert.deepEqual(result.failed, { weather: true, reminders: false });
    assert.match(result.text, /Couldn't reach the weather service for Manchester\.\n\nToday[^]*Haircut/);
    assert.deepEqual(t.summarized, []);
  });

  it('falls back to a plain weather line when the summary fails', async () => {
    const result = await buildBriefing(
      deps({
        calendar: null,
        summarizeWeather: async () => {
          throw new Error('model down');
        },
      }).deps,
    );
    assert.deepEqual(result.failed, { weather: false, reminders: false });
    assert.match(result.text, /🌦 Manchester: 9°C now, 7–12°C, mostly light rain\.$/);
  });

  it('builds the plain line from the forecast steps', () => {
    assert.equal(plainWeatherLine(FORECAST), '9°C now, 7–12°C, mostly light rain.');
    assert.equal(plainWeatherLine({ list: [] }), null);
  });
});
