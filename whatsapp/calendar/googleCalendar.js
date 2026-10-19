/**
 * Google adapter for the `calendar` port (calendarPort.js): plain `fetch` against the
 * Calendar v3 REST API on the primary calendar. Authenticates with an OAuth client ID, secret
 * and refresh token (see scripts/googleCalendarConsent.js) and refreshes access tokens itself.
 */

/** @typedef {import('./calendarPort.js').CalendarEvent} CalendarEvent */
/** @typedef {import('./calendarPort.js').CalendarNotifications} CalendarNotifications */
/** @typedef {import('./calendarPort.js').CalendarPort} CalendarPort */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const PRIMARY = `${API}/calendars/primary`;
/** Marks events the bot created, in their private extended properties. */
export const BOT_CREATOR_TAG = 'whatsappbot';
/** Refresh this long before Google's stated expiry. */
const TOKEN_SKEW_MS = 60_000;
const SETTINGS_TTL_MS = 15 * 60_000;
const RESPONSE_STATUSES = new Set(['accepted', 'declined', 'tentative', 'needsAction']);

/**
 * @param {{ dateTime?: string, date?: string } | undefined} t
 */
function timeMs(t) {
  if (t?.dateTime) return Date.parse(t.dateTime);
  if (t?.date) return Date.parse(`${t.date}T00:00:00Z`);
  return NaN;
}

/**
 * Google `{ minutes }` reminder entries → deduped minute offsets.
 * @param {unknown} list
 * @returns {number[]}
 */
function offsetsFromReminders(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((/** @type {any} */ r) => Number(r?.minutes))
        .filter(Number.isFinite)
    ),
  ];
}

/**
 * @param {string} date `YYYY-MM-DD`
 */
function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60_000).toISOString().slice(0, 10);
}

/**
 * @param {any} reminders Google `event.reminders`
 * @returns {CalendarNotifications}
 */
function normalizeNotifications(reminders) {
  if (!reminders || reminders.useDefault !== false) return { mode: 'default' };
  const offsetsMin = offsetsFromReminders(reminders.overrides);
  return offsetsMin.length ? { mode: 'explicit', offsetsMin } : { mode: 'none' };
}

/**
 * Google Calendar v3 event resource → plain {@link CalendarEvent}.
 * @param {any} g
 * @returns {CalendarEvent}
 */
export function normalizeGoogleEvent(g) {
  const allDay = Boolean(g?.start?.date && !g?.start?.dateTime);
  const self = Array.isArray(g?.attendees)
    ? g.attendees.find((/** @type {any} */ a) => a?.self)
    : undefined;
  const isOrganizer = g?.organizer ? Boolean(g.organizer.self) : true;
  const status = self?.responseStatus;
  const priv = g?.extendedProperties?.private ?? {};
  const createdByBot = priv.createdBy === BOT_CREATOR_TAG;
  /** @type {CalendarEvent} */
  const event = {
    id: String(g?.id ?? ''),
    title: String(g?.summary ?? ''),
    allDay,
    startMs: timeMs(g?.start),
    endMs: timeMs(g?.end),
    location: String(g?.location ?? ''),
    description: String(g?.description ?? ''),
    notifications: normalizeNotifications(g?.reminders),
    isOrganizer,
    responseStatus: RESPONSE_STATUSES.has(status) ? status : 'accepted',
    createdByBot,
    creatorActorId: createdByBot && priv.creatorActorId ? String(priv.creatorActorId) : null,
  };
  if (allDay) {
    event.startDate = g.start.date;
    event.endDate = g.end?.date;
  }
  return event;
}

/**
 * @param {import('./calendarPort.js').NewCalendarEvent} input
 */
function toGoogleEvent(input) {
  const n = input.notifications ?? { mode: 'default' };
  /** @type {Record<string, unknown>} */
  const body = {
    summary: input.title,
    reminders:
      n.mode === 'default'
        ? { useDefault: true }
        : {
            useDefault: false,
            overrides:
              n.mode === 'explicit'
                ? n.offsetsMin.map((minutes) => ({ method: 'popup', minutes }))
                : [],
          },
    extendedProperties: {
      private: {
        createdBy: BOT_CREATOR_TAG,
        ...(input.creatorActorId ? { creatorActorId: input.creatorActorId } : {}),
      },
    },
  };
  if (input.allDay) {
    body.start = { date: input.startDate };
    // Google's end date is exclusive: a one-day event ends the next day.
    body.end = { date: input.endDate ?? nextDay(String(input.startDate)) };
  } else {
    body.start = { dateTime: new Date(Number(input.startMs)).toISOString() };
    body.end = { dateTime: new Date(Number(input.endMs)).toISOString() };
  }
  if (input.location) body.location = input.location;
  if (input.description) body.description = input.description;
  return body;
}

export class GoogleCalendarError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.status = status;
  }
}

/**
 * @param {Pick<Response, 'ok' | 'status' | 'json'>} res
 * @param {string} what
 */
async function failure(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.error_description || body?.error || '';
  } catch {
    /* no JSON body */
  }
  return new GoogleCalendarError(
    `Google Calendar ${what} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
    res.status
  );
}

/**
 * @param {{
 *   clientId: string,
 *   clientSecret: string,
 *   refreshToken: string,
 *   fetch?: import('../types.ts').FetchLike,
 *   nowMs?: () => number,
 * }} opts
 * @returns {CalendarPort}
 */
export function createGoogleCalendar(opts) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.nowMs ?? Date.now;
  /** @type {{ token: string, expiresAt: number } | null} */
  let access = null;
  /** @type {{ value: import('./calendarPort.js').CalendarSettings, at: number } | null} */
  let settingsCache = null;

  async function refreshAccessToken() {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: opts.refreshToken,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw await failure(res, 'token refresh');
    const body = await res.json();
    const ttlMs = (Number(body.expires_in) || 3600) * 1000;
    access = { token: String(body.access_token), expiresAt: now() + ttlMs - TOKEN_SKEW_MS };
    return access.token;
  }

  async function accessToken() {
    if (access && now() < access.expiresAt) return access.token;
    return refreshAccessToken();
  }

  /**
   * @param {string} url
   * @param {RequestInit & { allow?: number[] }} [init]
   * @param {string} [what]
   */
  async function api(url, init = {}, what = 'request') {
    const { allow = [], ...rest } = init;
    /** @param {string} token */
    const send = (token) =>
      doFetch(url, {
        ...rest,
        headers: {
          ...(rest.body ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${token}`,
        },
      });
    let res = await send(await accessToken());
    if (res.status === 401) res = await send(await refreshAccessToken());
    if (allow.includes(res.status)) return null;
    if (!res.ok) throw await failure(res, what);
    return res.status === 204 ? null : res.json();
  }

  return {
    async listEvents({ timeMinMs, timeMaxMs }) {
      /** @type {CalendarEvent[]} */
      const out = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({
          singleEvents: 'true',
          orderBy: 'startTime',
          timeMin: new Date(timeMinMs).toISOString(),
          timeMax: new Date(timeMaxMs).toISOString(),
          maxResults: '250',
        });
        if (pageToken) q.set('pageToken', pageToken);
        const body = await api(`${PRIMARY}/events?${q}`, {}, 'list events');
        for (const item of body?.items ?? []) {
          if (item?.status === 'cancelled') continue;
          out.push(normalizeGoogleEvent(item));
        }
        pageToken = body?.nextPageToken ?? '';
      } while (pageToken);
      return out;
    },
    async createEvent(input) {
      const body = await api(
        `${PRIMARY}/events`,
        { method: 'POST', body: JSON.stringify(toGoogleEvent(input)) },
        'create event'
      );
      return normalizeGoogleEvent(body);
    },
    async deleteEvent(id) {
      await api(
        `${PRIMARY}/events/${encodeURIComponent(id)}`,
        { method: 'DELETE', allow: [404, 410] },
        'delete event'
      );
    },
    async getSettings() {
      if (settingsCache && now() - settingsCache.at < SETTINGS_TTL_MS) {
        return settingsCache.value;
      }
      const body = await api(`${API}/users/me/calendarList/primary`, {}, 'read settings');
      const defaultOffsetsMin = offsetsFromReminders(body?.defaultReminders);
      const value = { timeZone: String(body?.timeZone || 'UTC'), defaultOffsetsMin };
      settingsCache = { value, at: now() };
      return value;
    },
  };
}
