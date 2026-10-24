/**
 * The Briefing (#156): one message with a weather sentence for the owner's city and a numbered
 * list of what's left of today's Reminders. Each section is built on its own, so one failing
 * never drops the other. The Reminders section is the "what's on today" list.
 */

import { formatForecastCompact } from '../agents/weatherAgent.ts';
import { formatDay } from '../calendar/createReminder.ts';
import { CANCEL_HINT, formatListItem, reminderList } from '../calendar/manageReminders.ts';
import type { Forecast } from '../agents/weatherAgent.ts';
import type { CalendarPort } from '../calendar/calendarPort.ts';
import type { LastLists } from '../calendar/lastLists.ts';
import type { Logger } from '../types.ts';

export type BriefingDeps = {
  /** null when calendar credentials aren't configured: the Briefing is then weather only */
  calendar: CalendarPort | null;
  getForecast(city: string): Promise<Forecast>;
  /** one sentence from the compact forecast text; may throw */
  summarizeWeather(forecastText: string): Promise<string>;
  lastLists: LastLists;
  nowMs: number;
  city: string;
  chatId: string;
  logger?: Pick<Logger, 'warn'>;
};

export type Briefing = { text: string; failed: { weather: boolean; reminders: boolean } };

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * "9°C now, 7–12°C, mostly light rain." from the forecast steps the compact format covers.
 * @returns null when the forecast has no steps
 */
export function plainWeatherLine(forecast: Forecast): string | null {
  const steps = forecast.list?.slice(0, 8) ?? [];
  const temps = steps.map((s) => s.main?.temp).filter((t): t is number => typeof t === 'number');
  if (!temps.length) return null;
  const counts = new Map<string, number>();
  for (const s of steps) {
    const d = s.weather?.[0]?.description;
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const [common] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  const r = Math.round;
  return `${r(temps[0])}°C now, ${r(Math.min(...temps))}–${r(Math.max(...temps))}°C${common ? `, mostly ${common}` : ''}.`;
}

async function weatherSection({ getForecast, summarizeWeather, city, logger }: BriefingDeps): Promise<string | null> {
  let forecast;
  try {
    forecast = await getForecast(city);
  } catch (err) {
    logger?.warn({ err: errMessage(err) }, 'briefing: forecast fetch failed');
    return null;
  }
  try {
    return `🌦 ${city}: ${await summarizeWeather(formatForecastCompact(city, forecast))}`;
  } catch (err) {
    logger?.warn({ err: errMessage(err) }, 'briefing: weather summary failed, using the plain line');
    const plain = plainWeatherLine(forecast);
    return plain && `🌦 ${city}: ${plain}`;
  }
}

/**
 * @returns the section and the calendar's timezone, or null when the calendar can't be reached
 */
async function remindersSection(
  calendar: CalendarPort,
  { lastLists, nowMs, chatId, logger }: BriefingDeps,
): Promise<{ text: string; timeZone: string } | null> {
  try {
    const today = await reminderList(calendar, 'today', nowMs);
    // Replaces the chat's last list even when empty, as "what's on today" does.
    lastLists.set(chatId, today.shown, nowMs);
    if (today.shown.length) return { text: [...today.lines, '', CANCEL_HINT].join('\n'), timeZone: today.timeZone };
    const upcoming = await reminderList(calendar, 'upcoming', nowMs);
    const next = upcoming.shown[0];
    const text = next ? `Nothing on today.\nNext: ${formatListItem(next, today.timeZone)}` : 'Nothing on today.';
    return { text, timeZone: today.timeZone };
  } catch (err) {
    logger?.warn({ err: errMessage(err) }, 'briefing: calendar list failed');
    return null;
  }
}

export async function buildBriefing(deps: BriefingDeps): Promise<Briefing> {
  const [weather, reminders] = await Promise.all([
    weatherSection(deps),
    deps.calendar ? remindersSection(deps.calendar, deps) : undefined,
  ]);
  const timeZone = reminders?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sections = [`☀️ Briefing for ${formatDay(deps.nowMs, timeZone)}`];
  sections.push(weather ?? `Couldn't reach the weather service for ${deps.city}.`);
  if (reminders) sections.push(reminders.text);
  else if (reminders === null) sections.push("Couldn't reach Google Calendar.");
  return {
    text: sections.join('\n\n'),
    failed: { weather: weather === null, reminders: reminders === null },
  };
}
