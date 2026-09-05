import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getCursorCliRepoRoot } from './cursorCliAgent.js';

const FILE = 'reddit-cron-digest-last-sent.json';
const DEFAULT_STATUS_FILE =
  '/home/alexis/Projects/reddit-bot/reports/daily-cron-status.txt';
const DEFAULT_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const DEFAULT_MSG_MAX = 3500;
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_HOUR_UTC = 3;
const DEFAULT_MINUTE_UTC = 0;

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;

/**
 * @returns {string}
 */
export function redditCronDigestLastSentPath() {
  const fromEnv = process.env.REDDIT_CRON_DIGEST_LAST_SENT_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getCursorCliRepoRoot(), 'logs', 'cursor-agent', FILE);
}

/**
 * @returns {string}
 */
export function redditCronDigestStatusFilePath() {
  const fromEnv = process.env.REDDIT_BOT_STATUS_FILE?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_STATUS_FILE;
}

/**
 * @param {number} [nowMs]
 * @returns {string} YYYY-MM-DD in UTC
 */
export function utcCalendarDay(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * @param {number} mtimeMs
 * @param {number} [nowMs]
 * @param {number} [maxAgeMs]
 */
export function isStatusFileFresh(
  mtimeMs,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
) {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - mtimeMs;
  // Allow small future skew (NTP / test clocks); reject large "future" mtimes.
  if (age < 0) return -age <= 60 * 60_000;
  return age <= maxAgeMs;
}

/**
 * Parse digest header day from reddit-bot `cron_digest` output.
 * @param {string} text
 * @returns {string | null} YYYY-MM-DD
 */
export function parseDigestHeaderDay(text) {
  const m = String(text || '').match(
    /^reddit-bot cron\s+[—–-]\s+(\d{4}-\d{2}-\d{2})\b/m
  );
  return m ? m[1] : null;
}

/**
 * True when status file is fresh, non-empty, and stamped for the expected UTC digest day.
 * @param {{
 *   text: string,
 *   mtimeMs: number,
 *   nowMs?: number,
 *   maxAgeMs?: number,
 *   expectedDay: string,
 * }} opts
 */
export function isDigestReadyForDay(opts) {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs)
    ? opts.maxAgeMs
    : DEFAULT_MAX_AGE_MS;
  const body = String(opts.text || '').trim();
  if (!body) return false;
  if (!isStatusFileFresh(opts.mtimeMs, nowMs, maxAgeMs)) return false;
  const headerDay = parseDigestHeaderDay(body);
  return headerDay === opts.expectedDay;
}

/**
 * @param {string} text
 * @param {number} [maxChars]
 */
export function truncateDigestMessage(text, maxChars = DEFAULT_MSG_MAX) {
  const t = String(text ?? '');
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Schedule gate only (UTC clock). Idempotency is handled via digest/alert state.
 * @param {{
 *   nowMs?: number,
 *   hourUtc?: number,
 *   minuteUtc?: number,
 *   lastSentYmd?: string | null,
 *   digestSentToday?: boolean,
 * }} opts
 * @returns {boolean}
 */
export function shouldAttemptDigestSend(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const hourUtc = Number.isFinite(opts.hourUtc) ? opts.hourUtc : DEFAULT_HOUR_UTC;
  const minuteUtc = Number.isFinite(opts.minuteUtc)
    ? opts.minuteUtc
    : DEFAULT_MINUTE_UTC;
  const today = utcCalendarDay(nowMs);
  if (opts.digestSentToday === true) return false;
  // Legacy: callers that only pass lastSentYmd treat it as "digest already sent".
  if (opts.lastSentYmd && opts.lastSentYmd === today) return false;
  const d = new Date(nowMs);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const target = hourUtc * 60 + minuteUtc;
  return mins >= target;
}

/**
 * @typedef {{ day: string | null, digestSent: boolean, alertSent: boolean }} RedditCronDigestState
 */

/**
 * @returns {Promise<RedditCronDigestState>}
 */
export async function readRedditCronDigestState() {
  const path = redditCronDigestLastSentPath();
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return { day: null, digestSent: false, alertSent: false };
  }
  try {
    const data = JSON.parse(raw);
    const day = data?.day;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return { day: null, digestSent: false, alertSent: false };
    }
    if (typeof data.digestSent === 'boolean' || typeof data.alertSent === 'boolean') {
      return {
        day,
        digestSent: data.digestSent === true,
        alertSent: data.alertSent === true,
      };
    }
    // Legacy `{ day }` meant any successful send (including alerts).
    return { day, digestSent: true, alertSent: false };
  } catch {
    return { day: null, digestSent: false, alertSent: false };
  }
}

/**
 * @returns {Promise<string | null>} UTC day of last successful *digest* send
 */
export async function readRedditCronDigestLastSentDay() {
  const state = await readRedditCronDigestState();
  return state.digestSent ? state.day : null;
}

/**
 * @param {string} day YYYY-MM-DD UTC
 * @param {{ digestSent?: boolean, alertSent?: boolean }} [flags]
 */
export async function writeRedditCronDigestState(day, flags = {}) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`invalid digest last-sent day: ${JSON.stringify(day)}`);
  }
  const path = redditCronDigestLastSentPath();
  const prev = await readRedditCronDigestState();
  const sameDay = prev.day === day;
  const digestSent =
    flags.digestSent !== undefined
      ? flags.digestSent
      : sameDay
        ? prev.digestSent
        : false;
  const alertSent =
    flags.alertSent !== undefined
      ? flags.alertSent
      : sameDay
        ? prev.alertSent
        : false;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(
    path,
    JSON.stringify(
      {
        day,
        digestSent,
        alertSent,
        savedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * @param {string} day YYYY-MM-DD UTC
 * @deprecated Prefer writeRedditCronDigestState(day, { digestSent: true })
 */
export async function writeRedditCronDigestLastSentDay(day) {
  await writeRedditCronDigestState(day, { digestSent: true });
}

/**
 * @param {string} [raw]
 * @returns {string | null}
 */
function phoneToJid(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (t.includes('@')) return t;
  const d = t.replace(/\D/g, '');
  return d ? `${d}@s.whatsapp.net` : null;
}

/**
 * @param {unknown} err
 */
function errMsg(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * One evaluation cycle (exported for tests).
 *
 * Missing/stale alerts do **not** lock the day: when a fresh, day-matching
 * status file appears later, the real digest is still sent once.
 *
 * @param {{
 *   getSocket?: () => import('@whiskeysockets/baileys').WASocket | null | undefined,
 *   getOwnerJid?: () => string | null | undefined,
 *   getSecondJid?: () => string | null | undefined,
 *   logger?: { info?: (o: object | string) => void, warn?: (o: object | string) => void },
 *   nowMs?: number,
 *   statusFilePath?: string,
 *   maxAgeMs?: number,
 *   hourUtc?: number,
 *   minuteUtc?: number,
 *   alsoSecondPhone?: boolean,
 *   readState?: typeof readRedditCronDigestState,
 *   writeState?: typeof writeRedditCronDigestState,
 *   readLastSentDay?: typeof readRedditCronDigestLastSentDay,
 *   writeLastSentDay?: typeof writeRedditCronDigestLastSentDay,
 *   readFile?: (path: string) => Promise<{ text: string, mtimeMs: number }>,
 * }} [deps]
 * @returns {Promise<{ sent: boolean, reason: string }>}
 */
export async function runRedditCronDigestTick(deps = {}) {
  const getSocket = deps.getSocket ?? (() => null);
  const getOwnerJid = deps.getOwnerJid ?? (() => null);
  const getSecondJid = deps.getSecondJid ?? (() => phoneToJid(process.env.SECOND_PHONE));
  const logger = deps.logger;
  const nowMs = deps.nowMs ?? Date.now();
  const statusPath = deps.statusFilePath ?? redditCronDigestStatusFilePath();
  const maxAgeMs = Number.isFinite(deps.maxAgeMs) ? deps.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const hourUtc = Number.isFinite(deps.hourUtc)
    ? deps.hourUtc
    : parseEnvInt(process.env.REDDIT_CRON_DIGEST_HOUR_UTC, DEFAULT_HOUR_UTC);
  const minuteUtc = Number.isFinite(deps.minuteUtc)
    ? deps.minuteUtc
    : parseEnvInt(process.env.REDDIT_CRON_DIGEST_MINUTE_UTC, DEFAULT_MINUTE_UTC);
  const alsoSecond =
    deps.alsoSecondPhone ??
    truthyEnv(process.env.REDDIT_CRON_DIGEST_ALSO_SECOND_PHONE);
  const readState = deps.readState ?? readRedditCronDigestState;
  const writeState = deps.writeState ?? writeRedditCronDigestState;
  const readFile =
    deps.readFile ??
    (async (p) => {
      const st = await fs.stat(p);
      const text = await fs.readFile(p, 'utf8');
      return { text, mtimeMs: st.mtimeMs };
    });

  const sock = getSocket();
  if (!sock) return { sent: false, reason: 'no socket' };
  const ownerJid = (getOwnerJid() || '').trim();
  if (!ownerJid) return { sent: false, reason: 'no owner jid' };

  const today = utcCalendarDay(nowMs);
  const state = await readState();
  const digestSentToday = state.day === today && state.digestSent;
  const alertSentToday = state.day === today && state.alertSent;

  if (
    !shouldAttemptDigestSend({
      nowMs,
      hourUtc,
      minuteUtc,
      digestSentToday,
    })
  ) {
    return {
      sent: false,
      reason: digestSentToday
        ? 'already sent digest today'
        : 'skipped schedule or already sent',
    };
  }

  /** @type {'digest' | 'alert' | 'wait'} */
  let kind = 'wait';
  /** @type {string} */
  let message = '';

  try {
    const { text, mtimeMs } = await readFile(statusPath);
    if (
      isDigestReadyForDay({
        text,
        mtimeMs,
        nowMs,
        maxAgeMs,
        expectedDay: today,
      })
    ) {
      kind = 'digest';
      message = truncateDigestMessage(String(text).trim());
    } else {
      kind = 'alert';
      const headerDay = parseDigestHeaderDay(text);
      const detail =
        !String(text || '').trim()
          ? 'status file empty'
          : !isStatusFileFresh(mtimeMs, nowMs, maxAgeMs)
            ? `Age exceeds ${Math.round(maxAgeMs / 3600000)}h (or clock skew)`
            : headerDay && headerDay !== today
              ? `header day ${headerDay} != ${today} (waiting for today's digest)`
              : 'status file not ready for today';
      message = `reddit-bot digest missing/stale\nFile: ${statusPath}\n${detail}.`;
    }
  } catch {
    kind = 'alert';
    message = `reddit-bot digest missing/stale\nFile: ${statusPath}\n(status file not found)`;
  }

  if (kind === 'alert' && alertSentToday) {
    return { sent: false, reason: 'waiting for fresh digest (alert already sent)' };
  }

  const recipients = [ownerJid];
  if (alsoSecond) {
    const second = (getSecondJid() || '').trim();
    if (second && second !== ownerJid) recipients.push(second);
  }

  for (const jid of recipients) {
    try {
      await sock.sendMessage(jid, { text: message });
    } catch (e) {
      logger?.warn?.(
        { err: errMsg(e), jid },
        'reddit cron digest: sendMessage failed'
      );
      throw e;
    }
  }

  if (kind === 'digest') {
    await writeState(today, {
      digestSent: true,
      alertSent: alertSentToday,
    });
    logger?.info?.(`reddit cron digest: sent digest for ${today}`);
    return { sent: true, reason: 'sent digest' };
  }

  await writeState(today, {
    digestSent: false,
    alertSent: true,
  });
  logger?.info?.(`reddit cron digest: sent missing/stale alert for ${today}`);
  return { sent: true, reason: 'sent alert' };
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseEnvInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string | undefined} raw
 */
function truthyEnv(raw) {
  const v = String(raw || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Daily sender after reddit-bot `cron_digest` writes the status file (~03:00 UTC).
 * Polls until a fresh, day-matching digest arrives; missing/stale alerts do not
 * suppress a later digest the same UTC day.
 * @param {{
 *   getSocket: () => import('@whiskeysockets/baileys').WASocket | null | undefined,
 *   getOwnerJid: () => string | null | undefined,
 *   logger: { info?: (o: object | string) => void, warn?: (o: object | string) => void },
 *   pollMs?: number,
 * }} opts
 */
export function startRedditCronDigest(opts) {
  const { getSocket, getOwnerJid, logger } = opts;
  if (truthyEnv(process.env.REDDIT_CRON_DIGEST_DISABLE)) {
    logger?.info?.('reddit cron digest: disabled (REDDIT_CRON_DIGEST_DISABLE)');
    return;
  }
  if (intervalId) return;

  const pollMs = Number.isFinite(opts.pollMs)
    ? opts.pollMs
    : parseEnvInt(process.env.REDDIT_CRON_DIGEST_POLL_MS, DEFAULT_POLL_MS);

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runRedditCronDigestTick({ getSocket, getOwnerJid, logger });
    } catch (e) {
      logger?.warn?.({ err: errMsg(e) }, 'reddit cron digest tick failed');
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => {
    void tick();
  }, pollMs);
  void tick();
}
