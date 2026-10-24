import { getWeatherData } from '../../models/models.ts';
import { DEFAULT_CITY as WEATHER_DEFAULT_CITY, summarizeForecast } from '../agents/weatherAgent.ts';
import { googleCalendarFromEnv } from '../calendar/nudgeScheduler.ts';
import { parseAllDayNudgeTime } from '../calendar/nudgeTick.ts';
import { reminderLastLists } from '../orchestration/createProductionPorts.ts';
import { BRIEFING_CUTOFF_MIN, briefingSentLogPath, DEFAULT_BRIEFING_MIN, runBriefingTick } from './briefingTick.ts';
import type { Logger, TextSender } from '../types.ts';

const POLL_MS = 60_000;

let intervalId = null as ReturnType<typeof setInterval> | null;
let inFlight = false;

function truthyEnv(raw: string | undefined) {
  const v = String(raw || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Send the owner the daily Briefing (#158): a tick every minute while the connection is open
 * decides whether it's due. Starts on socket open, stops on close.
 */
export function startDailyBriefing(opts: {
  getSocket: () => TextSender | null | undefined;
  getOwnerJid: () => string | null;
  logger?: Pick<Logger, 'info' | 'warn'>;
}) {
  const { getSocket, getOwnerJid, logger } = opts;
  stopDailyBriefing();
  if (truthyEnv(process.env.BRIEFING_DISABLE)) {
    logger?.info?.('daily briefing: disabled (BRIEFING_DISABLE)');
    return;
  }
  const ownerChatId = getOwnerJid();
  if (!ownerChatId) {
    logger?.info?.('daily briefing: off (MY_PHONE not set)');
    return;
  }
  const rawTime = process.env.BRIEFING_TIME;
  const parsed = parseAllDayNudgeTime(rawTime);
  // From 12:00 on the window is empty, so that's as unusable as a malformed value.
  const parsedTime = parsed !== null && parsed < BRIEFING_CUTOFF_MIN ? parsed : null;
  const sendAtMin = parsedTime ?? DEFAULT_BRIEFING_MIN;
  if (rawTime?.trim() && parsedTime === null) {
    logger?.warn?.(
      { value: rawTime, sendAtMin },
      'daily briefing: bad BRIEFING_TIME (want HH:MM before 12:00), using the default'
    );
  }
  const calendar = googleCalendarFromEnv();
  const city = process.env.BRIEFING_CITY?.trim() || WEATHER_DEFAULT_CITY;
  const logPath = briefingSentLogPath();

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!getSocket()?.sendMessage) return;
      await runBriefingTick({
        calendar,
        getForecast: getWeatherData,
        summarizeWeather: (text) => summarizeForecast(text, 'briefing'),
        lastLists: reminderLastLists,
        city,
        ownerChatId,
        sendText: async (chatId, text) => {
          const live = getSocket();
          if (!live?.sendMessage) throw new Error('socket unavailable before send');
          await live.sendMessage(chatId, { text });
        },
        sendAtMin,
        logPath,
        logger,
      });
    } catch (e) {
      logger?.warn?.(
        { err: e instanceof Error ? e.message : String(e) },
        'daily briefing tick failed'
      );
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => void tick(), POLL_MS);
  void tick();
  logger?.info?.({ sendAtMin, logPath }, 'daily briefing: started');
}

/** Stop ticking (connection close). A tick still running keeps the `inFlight` guard. */
export function stopDailyBriefing() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
