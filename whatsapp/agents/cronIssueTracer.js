import { listOpenGithubIssues, resolveIssueRepoSlug } from './ghIssueForCursor.js';

const DEFAULT_MS = 10 * 60 * 1000;

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;
/** @type {number | null} last issue number we already notified the owner about */
let lastNotifiedNumber = null;

/**
 * @param {{ number: number, title: string }[]} rows
 * @returns {{ number: number, title: string } | null} lowest eligible OPEN issue
 */
export function pickNextEligibleIssue(rows) {
  const eligible = rows.filter(
    (r) => !String(r.title || '').trim().toLowerCase().startsWith('prd')
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (a.number < b.number ? a : b));
}

/**
 * 10-minute in-process check: lowest OPEN issue in WhatsappBot, excluding PRD* titles, notify owner.
 * @param {{
 *   getSocket: () => import('@whiskeysockets/baileys').WASocket | null | undefined,
 *   getOwnerJid: () => string | null | undefined,
 *   logger: { info?: (o: object | string) => void, warn?: (o: object | string) => void },
 *   intervalMs?: number,
 * }} opts
 */
export function startCronIssueTracer(opts) {
  const { getSocket, getOwnerJid, logger } = opts;
  const v = String(process.env.CRON_ISSUE_TRACER_DISABLE || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') {
    logger?.info('cron issue tracer: disabled (CRON_ISSUE_TRACER_DISABLE)');
    return;
  }
  if (intervalId) return;
  const raw = process.env.CRON_ISSUE_TRACER_INTERVAL_MS;
  const parsed = raw != null && String(raw).trim() !== '' ? parseInt(String(raw), 10) : NaN;
  const intervalMs = Number.isFinite(opts.intervalMs)
    ? opts.intervalMs
    : Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_MS;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const sock = getSocket();
      if (!sock) return;
      const ownerJid = (getOwnerJid() || '').trim();
      if (!ownerJid) return;
      const repo = resolveIssueRepoSlug();
      const rows = await listOpenGithubIssues({ repo });
      const next = pickNextEligibleIssue(rows);
      if (next == null) {
        lastNotifiedNumber = null;
        return;
      }
      if (next.number === lastNotifiedNumber) return;
      const text = [
        'Cron tracer (WhatsappBot): would run the Cursor flow for the next eligible GitHub issue (notify-only; no agent started).',
        '',
        `*Repo:* ${repo}`,
        `*Issue:* #${next.number}`,
        `*Title:* ${next.title}`,
      ].join('\n');
      await sock.sendMessage(ownerJid, { text });
      lastNotifiedNumber = next.number;
    } catch (e) {
      const err = e && typeof e === 'object' && 'message' in e ? (/** @type {Error} */ (e)).message : String(e);
      logger?.warn({ err }, `cron issue tracer: ${err}`);
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
}
