/**
 * The `calendar` port: the one boundary to the Owner's calendar (see #124, ADR 0002).
 * Adapters: `googleCalendar.js` (production), `test/helpers/fakeCalendar.js` (tests).
 *
 * @typedef {{ mode: 'default' }
 *   | { mode: 'explicit', offsetsMin: number[] }
 *   | { mode: 'none' }} CalendarNotifications
 *   How a Reminder's Alert times are set: the calendar's default notifications, explicit
 *   minutes-before-start offsets, or switched off.
 *
 * @typedef {'accepted' | 'declined' | 'tentative' | 'needsAction'} CalendarResponseStatus
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   allDay: boolean,
 *   startMs: number,
 *   endMs: number,
 *   startDate?: string,
 *   endDate?: string,
 *   location: string,
 *   description: string,
 *   notifications: CalendarNotifications,
 *   isOrganizer: boolean,
 *   responseStatus: CalendarResponseStatus,
 *   createdByBot: boolean,
 *   creatorActorId: string | null,
 * }} CalendarEvent
 *   One occurrence (recurring events are expanded). Timed events use `startMs`/`endMs`;
 *   all-day events also carry `startDate`/`endDate` (`YYYY-MM-DD`, end exclusive), and their
 *   `startMs`/`endMs` are UTC midnights of those dates.
 *
 * @typedef {{
 *   title: string,
 *   allDay?: boolean,
 *   startMs?: number,
 *   endMs?: number,
 *   startDate?: string,
 *   endDate?: string,
 *   location?: string,
 *   description?: string,
 *   notifications?: CalendarNotifications,
 *   creatorActorId?: string | null,
 * }} NewCalendarEvent
 *
 * @typedef {{ timeZone: string, defaultOffsetsMin: number[] }} CalendarSettings
 *
 * @typedef {{
 *   listEvents: (window: { timeMinMs: number, timeMaxMs: number }) => Promise<CalendarEvent[]>,
 *   createEvent: (event: NewCalendarEvent) => Promise<CalendarEvent>,
 *   deleteEvent: (id: string) => Promise<void>,
 *   getSettings: () => Promise<CalendarSettings>,
 * }} CalendarPort
 *   `listEvents` returns occurrences that end after `timeMinMs` and start before `timeMaxMs`
 *   (Google's own window semantics), ordered by start.
 */

export {};
