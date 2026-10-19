import { secondPhoneJid } from '../whatsAppActorAllowlist.js';
import { createGoogleCalendar } from './googleCalendar.ts';
import { nudgedLogPath } from './nudgedLog.ts';
import { DEFAULT_ALL_DAY_NUDGE_MIN, parseAllDayNudgeTime, runNudgeTick } from './nudgeTick.ts';

const DEFAULT_POLL_MS = 60_000;

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;

/**
 * @param {string | undefined} raw
 */
function truthyEnv(raw) {
  const v = String(raw || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Google adapter from env, or null when the OAuth credentials are missing (feature off).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function googleCalendarFromEnv(env = process.env) {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return createGoogleCalendar({ clientId, clientSecret, refreshToken });
}

/**
 * Poll the Owner's calendar and Nudge at Alert times. Runs alongside the local reminder
 * scheduler. Starts on socket open, stops on close; the immediate first tick catches up
 * Alert times that came due while the bot was down.
 * @param {{
 *   getSocket: () => import('../types.ts').MessageSender | null | undefined,
 *   getOwnerJid: () => string | null,
 *   logger?: { info?: Function, warn?: Function },
 * }} opts
 */
export function startCalendarNudges(opts) {
  const { getSocket, getOwnerJid, logger } = opts;
  stopCalendarNudges();
  if (truthyEnv(process.env.CALENDAR_NUDGES_DISABLE)) {
    logger?.info?.('calendar nudges: disabled (CALENDAR_NUDGES_DISABLE)');
    return;
  }
  const calendar = googleCalendarFromEnv();
  if (!calendar) {
    logger?.info?.('calendar nudges: off (GOOGLE_CALENDAR_* credentials not set)');
    return;
  }
  const ownerChatId = getOwnerJid();
  if (!ownerChatId) {
    logger?.info?.('calendar nudges: off (MY_PHONE not set)');
    return;
  }
  const parsed = parseInt(String(process.env.CALENDAR_NUDGES_POLL_MS ?? ''), 10);
  const pollMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_MS;
  const logPath = nudgedLogPath();
  const rawAllDay = process.env.CALENDAR_ALLDAY_NUDGE_TIME;
  const parsedAllDay = parseAllDayNudgeTime(rawAllDay);
  const allDayNudgeMin = parsedAllDay ?? DEFAULT_ALL_DAY_NUDGE_MIN;
  if (rawAllDay?.trim() && parsedAllDay === null) {
    logger?.warn?.(
      { value: rawAllDay, allDayNudgeMin },
      'calendar nudges: bad CALENDAR_ALLDAY_NUDGE_TIME (want HH:MM), using the default'
    );
  }

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!getSocket()?.sendMessage) return;
      await runNudgeTick({
        calendar,
        ownerChatId,
        // SECOND_PHONE is also Nudged for the Reminders it created (#129).
        creatorChatId: (creatorActorId) => secondPhoneJid(creatorActorId),
        sendText: async (chatId, text) => {
          const live = getSocket();
          if (!live?.sendMessage) throw new Error('socket unavailable before send');
          await live.sendMessage(chatId, { text });
        },
        allDayNudgeMin,
        logPath,
        logger,
      });
    } catch (e) {
      logger?.warn?.(
        { err: e instanceof Error ? e.message : String(e) },
        'calendar nudge tick failed'
      );
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => void tick(), pollMs);
  void tick();
  logger?.info?.({ pollMs, allDayNudgeMin, logPath }, 'calendar nudges: started');
}

/** Stop polling (connection close). A tick still running keeps the `inFlight` guard. */
export function stopCalendarNudges() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
