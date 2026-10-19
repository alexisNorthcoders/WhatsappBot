/**
 * The `calendar` port: the one boundary to the Owner's calendar (see #124, ADR 0002).
 * Adapters: `googleCalendar.ts` (production), `test/helpers/fakeCalendar.ts` (tests).
 */

/**
 * How a Reminder's Alert times are set: the calendar's default notifications, explicit
 * minutes-before-start offsets, or switched off.
 */
export type CalendarNotifications =
  | { mode: 'default' }
  | { mode: 'explicit'; offsetsMin: number[] }
  | { mode: 'none' };

export type CalendarResponseStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction';

/**
 * One occurrence (recurring events are expanded). Timed events use `startMs`/`endMs`;
 * all-day events also carry `startDate`/`endDate` (`YYYY-MM-DD`, end exclusive), and their
 * `startMs`/`endMs` are UTC midnights of those dates.
 */
export type CalendarEvent = {
  id: string;
  title: string;
  allDay: boolean;
  startMs: number;
  endMs: number;
  startDate?: string;
  endDate?: string;
  location: string;
  description: string;
  notifications: CalendarNotifications;
  isOrganizer: boolean;
  responseStatus: CalendarResponseStatus;
  createdByBot: boolean;
  creatorActorId: string | null;
};

export type NewCalendarEvent = {
  title: string;
  allDay?: boolean;
  startMs?: number;
  endMs?: number;
  startDate?: string;
  endDate?: string;
  location?: string;
  description?: string;
  notifications?: CalendarNotifications;
  creatorActorId?: string | null;
};

export type CalendarSettings = { timeZone: string; defaultOffsetsMin: number[] };

export type CalendarPort = {
  /**
   * Returns occurrences that end after `timeMinMs` and start before `timeMaxMs` (Google's own
   * window semantics), ordered by start.
   */
  listEvents: (window: { timeMinMs: number; timeMaxMs: number }) => Promise<CalendarEvent[]>;
  createEvent: (event: NewCalendarEvent) => Promise<CalendarEvent>;
  deleteEvent: (id: string) => Promise<void>;
  getSettings: () => Promise<CalendarSettings>;
};
