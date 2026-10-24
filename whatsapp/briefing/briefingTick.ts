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
const CUTOFF_MIN = 12 * 60;

/**
 * The sent log: the last day (`YYYY-MM-DD`, in the Briefing's timezone) the daily Briefing went
 * out. Only the daily tick reads or writes it; an on-demand `briefing` never does.
 */
export function briefingSentLogPath(): string {
  const fromEnv = process.env.BRIEFING_SENT_LOG_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getRepoRoot(), 'logs', 'briefing', 'sent.json');
}

async function readLastSentDate(filePath: string): Promise<string | null> {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const date = JSON.parse(raw)?.lastSentDate;
  return typeof date === 'string' ? date : null;
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written log. */
async function writeLastSentDate(filePath: string, date: string) {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, lastSentDate: date }, null, 2), 'utf8');
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
  | { sent: false; reason: 'outside window' | 'already sent' | 'all sections failed' | 'send failed' };

/**
 * One daily Briefing tick: from `sendAtMin` until 12:00 in the calendar's timezone (the Pi's
 * without a calendar), send the owner the Briefing unless the sent log already has today.
 * When every section fails nothing is sent and the day stays open, so a later tick retries;
 * otherwise the day is marked before sending (at-most-once, like Nudges).
 */
export async function runBriefingTick(deps: BriefingTickDeps): Promise<BriefingTickResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const logPath = deps.logPath ?? briefingSentLogPath();
  const sendAtMin = deps.sendAtMin ?? DEFAULT_BRIEFING_MIN;
  const timeZone = await briefingTimeZone(deps);
  const today = zonedDate(nowMs, timeZone);
  if (nowMs < zonedTimeMs(today, sendAtMin, timeZone) || nowMs >= zonedTimeMs(today, CUTOFF_MIN, timeZone)) {
    return { sent: false, reason: 'outside window' };
  }
  if ((await readLastSentDate(logPath)) === today) return { sent: false, reason: 'already sent' };

  const { text, failed } = await buildBriefing({ ...deps, nowMs, chatId: deps.ownerChatId });
  // Without a calendar the weather is the only section.
  if (failed.weather && (failed.reminders || !deps.calendar)) {
    deps.logger?.warn({ today }, 'briefing: every section failed, retrying next tick');
    return { sent: false, reason: 'all sections failed' };
  }
  await writeLastSentDate(logPath, today);
  try {
    await deps.sendText(deps.ownerChatId, text);
  } catch (e) {
    deps.logger?.warn(
      { err: e instanceof Error ? e.message : String(e), today },
      'briefing: send failed (not retried)',
    );
    return { sent: false, reason: 'send failed' };
  }
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
