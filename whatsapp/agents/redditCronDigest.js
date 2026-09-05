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
 * @param {string} text
 * @param {number} [maxChars]
 */
export function truncateDigestMessage(text, maxChars = DEFAULT_MSG_MAX) {
  const t = String(text ?? '');
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * @param {{
 *   nowMs?: number,
 *   hourUtc?: number,
 *   minuteUtc?: number,
 *   lastSentYmd?: string | null,
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
  if (opts.lastSentYmd && opts.lastSentYmd === today) return false;
  const d = new Date(nowMs);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const target = hourUtc * 60 + minuteUtc;
  return mins >= target;
}

/**
 * @returns {Promise<string | null>}
 */
export async function readRedditCronDigestLastSentDay() {
  const path = redditCronDigestLastSentPath();
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    const day = data?.day;
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string} day YYYY-MM-DD UTC
 */
export async function writeRedditCronDigestLastSentDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`invalid digest last-sent day: ${JSON.stringify(day)}`);
  }
  const path = redditCronDigestLastSentPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(
    path,
    JSON.stringify({ day, savedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
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
  const readLast = deps.readLastSentDay ?? readRedditCronDigestLastSentDay;
  const writeLast = deps.writeLastSentDay ?? writeRedditCronDigestLastSentDay;
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

  const lastSent = await readLast();
  if (
    !shouldAttemptDigestSend({
      nowMs,
      hourUtc,
      minuteUtc,
      lastSentYmd: lastSent,
    })
  ) {
    return { sent: false, reason: 'skipped schedule or already sent' };
  }

  const today = utcCalendarDay(nowMs);
  /** @type {string} */
  let message;
  try {
    const { text, mtimeMs } = await readFile(statusPath);
    if (!isStatusFileFresh(mtimeMs, nowMs, maxAgeMs)) {
      message = `reddit-bot digest missing/stale\nFile: ${statusPath}\nAge exceeds ${Math.round(maxAgeMs / 3600000)}h (or clock skew).`;
    } else {
      const body = truncateDigestMessage(String(text || '').trim());
      message = body || `reddit-bot digest empty\nFile: ${statusPath}`;
    }
  } catch {
    message = `reddit-bot digest missing/stale\nFile: ${statusPath}\n(status file not found)`;
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

  await writeLast(today);
  logger?.info?.(`reddit cron digest: sent for ${today}`);
  return { sent: true, reason: 'sent' };
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
