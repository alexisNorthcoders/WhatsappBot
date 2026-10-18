import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGoogleCalendar,
  normalizeGoogleEvent,
} from '../whatsapp/calendar/googleCalendar.js';

/**
 * Scripted fetch: each route returns a canned JSON response; requests are recorded.
 * @param {Record<string, (req: { url: URL, init: RequestInit }) => { status?: number, body?: unknown }>} routes
 */
function fakeFetch(routes) {
  /** @type {{ url: URL, init: RequestInit }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const f = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const key = `${init.method ?? 'GET'} ${url.origin}${url.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    const { status = 200, body = {} } = route({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  return { fetch: f, calls };
}

const TOKEN = 'POST https://oauth2.googleapis.com/token';
const EVENTS = 'GET https://www.googleapis.com/calendar/v3/calendars/primary/events';
const creds = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt' };

describe('google calendar adapter', () => {
  it('refreshes an access token and reuses it until it expires', async () => {
    let tokens = 0;
    let now = 1_000_000;
    const { fetch, calls } = fakeFetch({
      [TOKEN]: ({ init }) => {
        tokens += 1;
        const form = new URLSearchParams(String(init.body));
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'rt');
        assert.equal(form.get('client_id'), 'cid');
        return { body: { access_token: `at${tokens}`, expires_in: 3600 } };
      },
      [EVENTS]: () => ({ body: { items: [] } }),
    });
    const cal = createGoogleCalendar({ ...creds, fetch, nowMs: () => now });
    await cal.listEvents({ timeMinMs: 0, timeMaxMs: 1 });
    await cal.listEvents({ timeMinMs: 0, timeMaxMs: 1 });
    assert.equal(tokens, 1);
    now += 3600_000;
    await cal.listEvents({ timeMinMs: 0, timeMaxMs: 1 });
    assert.equal(tokens, 2);
    const last = calls.at(-1);
    assert.equal(new Headers(last?.init.headers).get('authorization'), 'Bearer at2');
  });

  it('retries once with a fresh token after a 401', async () => {
    let tokens = 0;
    let eventCalls = 0;
    const { fetch } = fakeFetch({
      [TOKEN]: () => ({ body: { access_token: `at${++tokens}`, expires_in: 3600 } }),
      [EVENTS]: () => (++eventCalls === 1 ? { status: 401 } : { body: { items: [] } }),
    });
    const cal = createGoogleCalendar({ ...creds, fetch });
    assert.deepEqual(await cal.listEvents({ timeMinMs: 0, timeMaxMs: 1 }), []);
    assert.equal(tokens, 2);
  });

  it('lists expanded occurrences in the window across pages', async () => {
    const { fetch, calls } = fakeFetch({
      [TOKEN]: () => ({ body: { access_token: 'at', expires_in: 3600 } }),
      [EVENTS]: ({ url }) =>
        url.searchParams.get('pageToken')
          ? { body: { items: [{ id: 'b', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' } }] } }
          : { body: { nextPageToken: 'p2', items: [{ id: 'a', start: { dateTime: '2026-10-19T09:00:00Z' }, end: { dateTime: '2026-10-19T10:00:00Z' } }] } },
    });
    const cal = createGoogleCalendar({ ...creds, fetch });
    const events = await cal.listEvents({
      timeMinMs: Date.parse('2026-10-19T00:00:00Z'),
      timeMaxMs: Date.parse('2026-10-21T00:00:00Z'),
    });
    assert.deepEqual(events.map((e) => e.id), ['a', 'b']);
    const q = calls.find((c) => c.url.pathname.endsWith('/events'))?.url.searchParams;
    assert.equal(q?.get('singleEvents'), 'true');
    assert.equal(q?.get('orderBy'), 'startTime');
    assert.equal(q?.get('timeMin'), '2026-10-19T00:00:00.000Z');
    assert.equal(q?.get('timeMax'), '2026-10-21T00:00:00.000Z');
  });

  it('throws on a non-OK response', async () => {
    const { fetch } = fakeFetch({
      [TOKEN]: () => ({ body: { access_token: 'at', expires_in: 3600 } }),
      [EVENTS]: () => ({ status: 500, body: { error: { message: 'boom' } } }),
    });
    const cal = createGoogleCalendar({ ...creds, fetch });
    await assert.rejects(cal.listEvents({ timeMinMs: 0, timeMaxMs: 1 }), /500/);
  });

  it('reads timezone and default notifications', async () => {
    const { fetch } = fakeFetch({
      [TOKEN]: () => ({ body: { access_token: 'at', expires_in: 3600 } }),
      'GET https://www.googleapis.com/calendar/v3/users/me/calendarList/primary': () => ({
        body: {
          timeZone: 'Europe/London',
          defaultReminders: [{ method: 'popup', minutes: 30 }, { method: 'email', minutes: 30 }, { method: 'popup', minutes: 1440 }],
        },
      }),
    });
    const cal = createGoogleCalendar({ ...creds, fetch });
    assert.deepEqual(await cal.getSettings(), {
      timeZone: 'Europe/London',
      defaultOffsetsMin: [30, 1440],
    });
  });

  it('creates an event with the creator in private extended properties', async () => {
    /** @type {any} */
    let posted;
    const { fetch } = fakeFetch({
      [TOKEN]: () => ({ body: { access_token: 'at', expires_in: 3600 } }),
      'POST https://www.googleapis.com/calendar/v3/calendars/primary/events': ({ init }) => {
        posted = JSON.parse(String(init.body));
        return { body: { id: 'new1', ...posted, organizer: { self: true } } };
      },
    });
    const cal = createGoogleCalendar({ ...creds, fetch });
    const evt = await cal.createEvent({
      title: 'Bins',
      startMs: Date.parse('2026-10-19T18:00:00Z'),
      endMs: Date.parse('2026-10-19T18:15:00Z'),
      notifications: { mode: 'explicit', offsetsMin: [0] },
      creatorActorId: '447700900002@s.whatsapp.net',
    });
    assert.equal(posted.summary, 'Bins');
    assert.equal(posted.start.dateTime, '2026-10-19T18:00:00.000Z');
    assert.deepEqual(posted.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] });
    assert.equal(posted.extendedProperties.private.creatorActorId, '447700900002@s.whatsapp.net');
    assert.equal(evt.id, 'new1');
    assert.equal(evt.createdByBot, true);
    assert.equal(evt.creatorActorId, '447700900002@s.whatsapp.net');
    assert.deepEqual(evt.notifications, { mode: 'explicit', offsetsMin: [0] });
  });

  it('deletes an event, treating already-gone as done', async () => {
    const { fetch, calls } = fakeFetch({
      [TOKEN]: () => ({ body: { access_token: 'at', expires_in: 3600 } }),
      'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/a%2Fb': () => ({ status: 204 }),
      'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/gone': () => ({ status: 410 }),
    });
    const cal = createGoogleCalendar({ ...creds, fetch });
    await cal.deleteEvent('a/b');
    await cal.deleteEvent('gone');
    assert.equal(calls.filter((c) => c.init.method === 'DELETE').length, 2);
  });
});

describe('normalizeGoogleEvent', () => {
  it('maps notification modes', () => {
    const base = { id: 'x', start: { dateTime: '2026-10-19T09:00:00+01:00' }, end: { dateTime: '2026-10-19T10:00:00+01:00' } };
    assert.deepEqual(normalizeGoogleEvent({ ...base, reminders: { useDefault: true } }).notifications, { mode: 'default' });
    assert.deepEqual(normalizeGoogleEvent({ ...base }).notifications, { mode: 'default' });
    assert.deepEqual(
      normalizeGoogleEvent({ ...base, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 60 }] } }).notifications,
      { mode: 'explicit', offsetsMin: [10, 60] }
    );
    assert.deepEqual(normalizeGoogleEvent({ ...base, reminders: { useDefault: false } }).notifications, { mode: 'none' });
    assert.equal(normalizeGoogleEvent(base).startMs, Date.parse('2026-10-19T08:00:00Z'));
  });

  it('reads organiser, my response status and the bot creator', () => {
    const invite = normalizeGoogleEvent({
      id: 'i',
      summary: 'Sync',
      location: 'Room 1',
      description: 'Agenda',
      start: { dateTime: '2026-10-19T09:00:00Z' },
      end: { dateTime: '2026-10-19T10:00:00Z' },
      organizer: { email: 'boss@example.com' },
      attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }, { email: 'me@example.com', self: true, responseStatus: 'declined' }],
    });
    assert.equal(invite.isOrganizer, false);
    assert.equal(invite.responseStatus, 'declined');
    assert.equal(invite.title, 'Sync');
    assert.equal(invite.location, 'Room 1');
    assert.equal(invite.createdByBot, false);
    assert.equal(invite.creatorActorId, null);

    const own = normalizeGoogleEvent({ id: 'o', start: { dateTime: '2026-10-19T09:00:00Z' }, end: { dateTime: '2026-10-19T10:00:00Z' }, organizer: { self: true } });
    assert.equal(own.isOrganizer, true);
    assert.equal(own.responseStatus, 'accepted');
  });

  it('maps all-day events', () => {
    const e = normalizeGoogleEvent({ id: 'd', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } });
    assert.equal(e.allDay, true);
    assert.equal(e.startDate, '2026-10-25');
    assert.equal(e.endDate, '2026-10-26');
    assert.equal(e.startMs, Date.parse('2026-10-25T00:00:00Z'));
  });
});
