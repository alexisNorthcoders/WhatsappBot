/**
 * In-memory `calendar` port (whatsapp/calendar/calendarPort.ts) for tests.
 * Seed with `seed()`, edit with `move()`/`remove()`; recurring events are seeded as their
 * expanded occurrences, like the Google adapter returns them.
 */

/** @typedef {import('../../whatsapp/calendar/calendarPort.ts').CalendarEvent} CalendarEvent */

const MIN = 60_000;

/**
 * @param {{ timeZone?: string, defaultOffsetsMin?: number[] }} [settings]
 */
export function createFakeCalendar(settings = {}) {
  /** @type {Map<string, CalendarEvent>} */
  const events = new Map();
  let nextId = 1;
  const state = {
    timeZone: settings.timeZone ?? 'Europe/London',
    defaultOffsetsMin: settings.defaultOffsetsMin ?? [10],
  };

  /**
   * All-day events may be seeded by `startDate` (and optional exclusive `endDate`, default the
   * next day); `startMs`/`endMs` become those dates' UTC midnights, like the Google adapter.
   * @param {Partial<CalendarEvent> & ({ startMs: number } | { startDate: string })} partial
   * @returns {CalendarEvent}
   */
  function build(partial) {
    if (partial.startMs === undefined && partial.startDate) {
      const startMs = Date.parse(`${partial.startDate}T00:00:00Z`);
      const endDate =
        partial.endDate ?? new Date(startMs + 24 * 60 * MIN).toISOString().slice(0, 10);
      partial = {
        allDay: true,
        ...partial,
        endDate,
        startMs,
        endMs: Date.parse(`${endDate}T00:00:00Z`),
      };
    }
    const startMs = /** @type {number} */ (partial.startMs);
    const id = partial.id ?? `evt${nextId++}`;
    return {
      id,
      title: 'Event',
      allDay: false,
      startMs,
      endMs: startMs + 30 * MIN,
      location: '',
      description: '',
      notifications: { mode: 'default' },
      isOrganizer: true,
      responseStatus: 'accepted',
      createdByBot: false,
      creatorActorId: null,
      ...partial,
    };
  }

  return {
    /** @param {Partial<CalendarEvent> & ({ startMs: number } | { startDate: string })} partial */
    seed(partial) {
      const evt = build(partial);
      events.set(evt.id, evt);
      return evt;
    },
    /** @param {string} id @param {number} startMs @param {number} [endMs] */
    move(id, startMs, endMs) {
      const evt = events.get(id);
      if (!evt) throw new Error(`no event ${id}`);
      const length = evt.endMs - evt.startMs;
      events.set(id, { ...evt, startMs, endMs: endMs ?? startMs + length });
    },
    /** @param {string} id */
    remove(id) {
      events.delete(id);
    },
    all() {
      return [...events.values()];
    },
    /** @param {{ timeMinMs: number, timeMaxMs: number }} window */
    async listEvents({ timeMinMs, timeMaxMs }) {
      return [...events.values()]
        .filter((e) => e.endMs > timeMinMs && e.startMs < timeMaxMs)
        .sort((a, b) => a.startMs - b.startMs)
        .map((e) => ({ ...e }));
    },
    /** @param {import('../../whatsapp/calendar/calendarPort.ts').NewCalendarEvent} input */
    async createEvent(input) {
      const startMs = input.startMs ?? Date.parse(`${input.startDate}T00:00:00Z`);
      const evt = build({
        ...input,
        startMs,
        endMs: input.endMs ?? startMs + 15 * MIN,
        createdByBot: true,
        creatorActorId: input.creatorActorId ?? null,
      });
      events.set(evt.id, evt);
      return { ...evt };
    },
    /** @param {string} id */
    async deleteEvent(id) {
      events.delete(id);
    },
    async getSettings() {
      return { ...state, defaultOffsetsMin: [...state.defaultOffsetsMin] };
    },
  };
}
