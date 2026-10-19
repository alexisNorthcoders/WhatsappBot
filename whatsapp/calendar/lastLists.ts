/**
 * The last numbered list of Reminders shown in each chat, kept in memory with a short TTL so a
 * later "cancel N" can look item N up (#124). A creation reply counts as a one-item list.
 */

import type { CalendarEvent } from './calendarPort.ts';

const DEFAULT_TTL_MS = 30 * 60_000;

export type LastLists = ReturnType<typeof createLastLists>;

export function createLastLists({ ttlMs = DEFAULT_TTL_MS }: { ttlMs?: number } = {}) {
  const lists: Map<string, { events: CalendarEvent[]; at: number }> = new Map();
  return {
    /**
     * @param events item N is `events[N - 1]`
     */
    set(chatId: string, events: CalendarEvent[], nowMs: number) {
      lists.set(chatId, { events: [...events], at: nowMs });
    },
    /**
     * @returns null when none or expired
     */
    get(chatId: string, nowMs: number): CalendarEvent[] | null {
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
