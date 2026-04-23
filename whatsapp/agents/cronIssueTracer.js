import {
  listOpenGithubIssues,
  resolveIssueRepoSlug,
} from './ghIssueForCursor.js';
import { getDefaultWorkspaceRoot } from '../cursorWorkspaces.js';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
  isCursorAgentBusy,
} from './cursorAgentBusy.js';
import {
  readCronLastStartedIssue,
  writeCronLastStartedIssue,
} from './cronLastStartedIssue.js';
import {
  runIssueFetchAndGitPrep,
  runCursorAgentWithPost,
} from './cursorIssuePipeline.js';

const DEFAULT_MS = 10 * 60 * 1000;

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;

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
 * @param {string} err
 * @param {number} [max]
 */
function truncateErrorSummary(err, max = 1500) {
  const t = (err || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Interval job: if an eligible WhatsappBot issue exists and the Cursor agent is free, run the
 * same pipeline as a manual `cursor issue:<n>` (fetch, git prep, agent, post-run automation).
 * Persists last-started (repo + issue) so the same open issue is not re-dispatched every tick.
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
    let acquired = false;
    try {
      if (isCursorAgentBusy()) {
        return;
      }

      const sock = getSocket();
      if (!sock) return;
      const ownerJid = (getOwnerJid() || '').trim();
      if (!ownerJid) return;

      const repo = resolveIssueRepoSlug();
      const rows = await listOpenGithubIssues({ repo });
      const next = pickNextEligibleIssue(rows);
      if (next == null) {
        return;
      }

      const last = await readCronLastStartedIssue();
      if (last && last.repo === repo && last.number === next.number) {
        return;
      }

      if (!tryAcquireAgentBusyLock()) {
        return;
      }
      acquired = true;

      let workspaceRoot;
      try {
        workspaceRoot = await getDefaultWorkspaceRoot();
      } catch (e) {
        const msg = e && typeof e === 'object' && 'message' in e ? (/** @type {Error} */ (e)).message : String(e);
        await sock.sendMessage(ownerJid, {
          text: `Cron (WhatsappBot): could not resolve default workspace: ${truncateErrorSummary(msg, 2000)}`,
        });
        return;
      }

      const startText = [
        'Cron: starting the Cursor *issue* workflow (same as `cursor issue:` from WhatsApp).',
        '',
        `*Repo:* ${repo}`,
        `*Issue:* #${next.number}`,
        `*Title:* ${next.title}`,
        '',
        'Fetching issue and preparing the workspace next…',
      ].join('\n');
      await sock.sendMessage(ownerJid, { text: startText });

      const prepped = await runIssueFetchAndGitPrep({
        sock,
        recipientJid: ownerJid,
        issueNumber: next.number,
        extraInstructions: '',
        workspaceRoot,
        workspaceAlias: null,
        sendProgressMessages: false,
      });

      if (!prepped) {
        await sock.sendMessage(ownerJid, {
          text: `Cron (WhatsappBot): could not start work on #${next.number} (fetch or git prep failed; see message above).`,
        });
        return;
      }

      const issueMatch = { issueNumber: next.number, extraInstructions: '' };
      await writeCronLastStartedIssue({ repo, number: next.number });
      try {
        await runCursorAgentWithPost({
          sock,
          recipientJid: ownerJid,
          prompt: prepped.prompt,
          repo: workspaceRoot,
          issueMatch,
          issueSource: prepped.issueSource,
          joplinSource: null,
          sendProgressMessages: false,
        });
      } catch (runErr) {
        const e = runErr && typeof runErr === 'object' && 'message' in runErr
          ? (/** @type {Error} */ (runErr)).message
          : String(runErr);
        try {
          await sock.sendMessage(ownerJid, {
            text: `Cron (WhatsappBot): the Cursor run for #${next.number} hit an error: ${truncateErrorSummary(e)}`,
          });
        } catch (sendE) {
          const se =
            sendE && typeof sendE === 'object' && 'message' in sendE
              ? (/** @type {Error} */ (sendE)).message
              : String(sendE);
          logger?.warn(
            { err: se },
            'cron issue tracer: failed to notify owner of run error'
          );
        }
      }
    } catch (e) {
      const err = e && typeof e === 'object' && 'message' in e ? (/** @type {Error} */ (e)).message : String(e);
      logger?.warn({ err: e }, `cron issue tracer: ${err}`);
      const sock = getSocket();
      const ownerJid = (getOwnerJid() || '').trim();
      if (sock && ownerJid) {
        try {
          await sock.sendMessage(ownerJid, {
            text: `Cron (WhatsappBot) tick failed: ${truncateErrorSummary(err)}`,
          });
        } catch (sendE) {
          const se = sendE && typeof sendE === 'object' && 'message' in sendE
            ? (/** @type {Error} */ (sendE)).message
            : String(sendE);
          logger?.warn({ err: se }, 'cron issue tracer: failed to notify tick failure');
        }
      }
    } finally {
      if (acquired) {
        releaseAgentBusyLock();
      }
      inFlight = false;
    }
  };

  intervalId = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
}
