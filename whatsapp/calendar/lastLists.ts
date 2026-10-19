/**
 * The last numbered list of Reminders shown in each chat, kept in memory with a short TTL so a
 * later "cancel N" can look item N up (#124). A creation reply counts as a one-item list.
 */

const DEFAULT_TTL_MS = 30 * 60_000;

/**
 * @param {{ ttlMs?: number }} [opts]
 */
export function createLastLists({ ttlMs = DEFAULT_TTL_MS } = {}) {
  /** @type {Map<string, { events: import('./calendarPort.ts').CalendarEvent[], at: number }>} */
  const lists = new Map();
  return {
    /**
     * @param {string} chatId
     * @param {import('./calendarPort.ts').CalendarEvent[]} events item N is `events[N - 1]`
     * @param {number} nowMs
     */
    set(chatId, events, nowMs) {
      lists.set(chatId, { events: [...events], at: nowMs });
    },
    /**
     * @param {string} chatId
     * @param {number} nowMs
     * @returns {import('./calendarPort.ts').CalendarEvent[] | null} null when none or expired
     */
    get(chatId, nowMs) {
      const entry = lists.get(chatId);
      if (!entry) return null;
      if (nowMs - entry.at > ttlMs) {
        lists.delete(chatId);
        return null;
      }
      return [...entry.events];
    },
  };
}
