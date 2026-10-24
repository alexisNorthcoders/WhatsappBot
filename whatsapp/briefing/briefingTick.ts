import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getRepoRoot } from '../repoRoot.ts';
import { zonedDate, zonedTimeMs } from '../calendar/nudgeTick.ts';
import { buildBriefing } from './buildBriefing.ts';
import type { BriefingDeps } from './buildBriefing.ts';
import type { Logger } from '../types.ts';

/** The daily Briefing goes out at this local time (minutes after midnight) by default. */
export const DEFAULT_BRIEFING_MIN = 7 * 60 + 30;
/** No daily Briefing from this local time on: it's no longer a morning message. */
export const BRIEFING_CUTOFF_MIN = 12 * 60;
/** While one section fails, the daily tick waits this long after its first attempt before a partial Briefing. */
export const BRIEFING_GRACE_MS = 30 * 60_000;

/**
 * The sent log: the last day (`YYYY-MM-DD`, in the Briefing's timezone) the daily Briefing went
 * out, and when the daily tick first held one back today for a failing section (the grace start), so a
 * restart doesn't restart the grace. Only the daily tick reads or writes it; an on-demand
 * `briefing` never does.
 */
export function briefingSentLogPath(): string {
  const fromEnv = process.env.BRIEFING_SENT_LOG_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getRepoRoot(), 'logs', 'briefing', 'sent.json');
}

type SentLog = { lastSentDate: string | null; graceStartMs: number | null };

async function readSentLog(filePath: string): Promise<SentLog> {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lastSentDate: null, graceStartMs: null };
    throw e;
  }
  const { lastSentDate, graceStartMs } = JSON.parse(raw) ?? {};
  return {
    lastSentDate: typeof lastSentDate === 'string' ? lastSentDate : null,
    graceStartMs: typeof graceStartMs === 'number' ? graceStartMs : null,
  };
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written log. */
async function writeSentLog(filePath: string, log: SentLog) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, ...log }, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

type BriefingTickDeps = Omit<BriefingDeps, 'nowMs' | 'chatId' | 'logger'> & {
  ownerChatId: string;
  sendText: (chatId: string, text: string) => Promise<unknown>;
  nowMs?: number;
  /** `BRIEFING_TIME`, minutes after midnight */
  sendAtMin?: number;
  logPath?: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
};

export type BriefingTickResult =
  | { sent: true }
  | {
      sent: false;
      reason: 'outside window' | 'already sent' | 'all sections failed' | 'grace period' | 'send failed';
    };

/**
 * One daily Briefing tick: from `sendAtMin` until 12:00 in the calendar's timezone (the Pi's
 * without a calendar), send the owner the Briefing unless the sent log already has today.
 * When every section fails, or the send itself fails, the day stays open so a later tick
 * retries; the day is marked only after a successful send. When one section fails, ticks keep
 * retrying for `BRIEFING_GRACE_MS` from the day's first failing attempt before sending it partial.
 */
export async function runBriefingTick(deps: BriefingTickDeps): Promise<BriefingTickResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const logPath = deps.logPath ?? briefingSentLogPath();
  const sendAtMin = deps.sendAtMin ?? DEFAULT_BRIEFING_MIN;
  const timeZone = await briefingTimeZone(deps);
  const today = zonedDate(nowMs, timeZone);
  if (nowMs < zonedTimeMs(today, sendAtMin, timeZone) || nowMs >= zonedTimeMs(today, BRIEFING_CUTOFF_MIN, timeZone)) {
    return { sent: false, reason: 'outside window' };
  }
  const log = await readSentLog(logPath);
  if (log.lastSentDate === today) return { sent: false, reason: 'already sent' };

  const { text, failed } = await buildBriefing({ ...deps, nowMs, chatId: deps.ownerChatId });
  if (failed.weather || failed.reminders) {
    let graceStartMs = log.graceStartMs;
    if (graceStartMs === null || zonedDate(graceStartMs, timeZone) !== today) {
      graceStartMs = nowMs;
      await writeSentLog(logPath, { ...log, graceStartMs });
      deps.logger?.info({ today, failed }, 'briefing: a section failed, retrying each tick');
    }
    // `failed.reminders` is the calendar section; without a calendar the weather is the only one.
    if (failed.weather && (failed.reminders || !deps.calendar)) {
      deps.logger?.warn({ today }, 'briefing: every section failed, retrying next tick');
      return { sent: false, reason: 'all sections failed' };
    }
    if (nowMs < graceStartMs + BRIEFING_GRACE_MS) return { sent: false, reason: 'grace period' };
  }
  try {
    await deps.sendText(deps.ownerChatId, text);
  } catch (e) {
    deps.logger?.warn(
      { err: e instanceof Error ? e.message : String(e), today },
      'briefing: send failed, retrying next tick',
    );
    return { sent: false, reason: 'send failed' };
  }
  await writeSentLog(logPath, { lastSentDate: today, graceStartMs: null });
  deps.logger?.info({ today, failed }, 'briefing: daily Briefing sent');
  return { sent: true };
}

async function briefingTimeZone({ calendar, logger }: BriefingTickDeps) {
  const piTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!calendar) return piTimeZone;
  try {
    return (await calendar.getSettings()).timeZone;
  } catch (e) {
    logger?.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "briefing: calendar settings failed, using the Pi's timezone",
    );
    return piTimeZone;
  }
}
