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
  errorMessageFromUnknown,
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
 * @typedef {{
 *   getSocket?: () => import('@whiskeysockets/baileys').WASocket | null | undefined,
 *   getOwnerJid?: () => string | null | undefined,
 *   logger?: { info?: (o: object | string) => void, warn?: (o: object | string) => void },
 *   listOpenGithubIssues?: typeof listOpenGithubIssues,
 *   resolveIssueRepoSlug?: typeof resolveIssueRepoSlug,
 *   getDefaultWorkspaceRoot?: typeof getDefaultWorkspaceRoot,
 *   readCronLastStartedIssue?: typeof readCronLastStartedIssue,
 *   writeCronLastStartedIssue?: typeof writeCronLastStartedIssue,
 *   tryAcquireAgentBusyLock?: typeof tryAcquireAgentBusyLock,
 *   releaseAgentBusyLock?: typeof releaseAgentBusyLock,
 *   isCursorAgentBusy?: typeof isCursorAgentBusy,
 *   runIssueFetchAndGitPrep?: typeof runIssueFetchAndGitPrep,
 *   runCursorAgentWithPost?: typeof runCursorAgentWithPost,
 * }} CronIssueTracerTickDeps
 */

/**
 * One cron evaluation cycle (exported for tests; production uses `startCronIssueTracer`).
 * Persists last-started only after `runCursorAgentWithPost` completes without throwing, so a crash
 * or unexpected failure before that point does not suppress retries for the same open issue.
 *
 * @param {CronIssueTracerTickDeps} [deps]
 */
export async function runCronIssueTracerTick(deps = {}) {
  const getSocket = deps.getSocket ?? (() => null);
  const getOwnerJid = deps.getOwnerJid ?? (() => null);
  const logger = deps.logger;
  const listIssues = deps.listOpenGithubIssues ?? listOpenGithubIssues;
  const resolveRepo = deps.resolveIssueRepoSlug ?? resolveIssueRepoSlug;
  const getWorkspace = deps.getDefaultWorkspaceRoot ?? getDefaultWorkspaceRoot;
  const readLast = deps.readCronLastStartedIssue ?? readCronLastStartedIssue;
  const writeLast = deps.writeCronLastStartedIssue ?? writeCronLastStartedIssue;
  const tryLock = deps.tryAcquireAgentBusyLock ?? tryAcquireAgentBusyLock;
  const releaseLock = deps.releaseAgentBusyLock ?? releaseAgentBusyLock;
  const agentBusy = deps.isCursorAgentBusy ?? isCursorAgentBusy;
  const runPrep = deps.runIssueFetchAndGitPrep ?? runIssueFetchAndGitPrep;
  const runAgent = deps.runCursorAgentWithPost ?? runCursorAgentWithPost;

  let phase = 'initial checks';
  /** @type {string | null} */
  let repoForMsg = null;
  /** @type {number | null} */
  let issueNumForMsg = null;

  let acquired = false;
  try {
    if (agentBusy()) {
      return;
    }

    const sock = getSocket();
    if (!sock) return;
    const ownerJid = (getOwnerJid() || '').trim();
    if (!ownerJid) return;

    phase = 'listing open GitHub issues';
    const repo = resolveRepo();
    repoForMsg = repo;
    const rows = await listIssues({ repo });
    const next = pickNextEligibleIssue(rows);
    if (next == null) {
      return;
    }
    issueNumForMsg = next.number;

    phase = 'reading persisted last-started issue';
    const last = await readLast();
    if (last && last.repo === repo && last.number === next.number) {
      return;
    }

    if (!tryLock()) {
      return;
    }
    acquired = true;

    let workspaceRoot;
    phase = 'resolving default workspace';
    try {
      workspaceRoot = await getWorkspace();
    } catch (e) {
      const msg = errorMessageFromUnknown(e);
      await sock.sendMessage(ownerJid, {
        text: `Cron (WhatsappBot): could not resolve default workspace (step: ${phase}): ${truncateErrorSummary(msg, 2000)}`,
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
    phase = 'sending start notification to owner';
    await sock.sendMessage(ownerJid, { text: startText });

    phase = 'issue fetch / git prep';
    const prepped = await runPrep({
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
        text: `Cron (WhatsappBot): could not start work on #${next.number} in \`${repo}\` (step: issue fetch or git prep failed; see the message above if one was sent).`,
      });
      return;
    }

    const issueMatch = { issueNumber: next.number, extraInstructions: '' };
    phase = 'cursor agent run and post-run automation';
    try {
      await runAgent({
        sock,
        recipientJid: ownerJid,
        prompt: prepped.prompt,
        repo: workspaceRoot,
        issueMatch,
        issueSource: prepped.issueSource,
        joplinSource: null,
        sendProgressMessages: false,
      });
      phase = 'persisting last-started issue';
      await writeLast({ repo, number: next.number });
    } catch (runErr) {
      const e = errorMessageFromUnknown(runErr);
      try {
        await sock.sendMessage(ownerJid, {
          text: [
            `Cron (WhatsappBot): the Cursor run for \`${repo}\` issue #${next.number} failed during: ${phase}.`,
            '',
            truncateErrorSummary(e),
          ].join('\n'),
        });
      } catch (sendE) {
        logger?.warn(
          { err: errorMessageFromUnknown(sendE) },
          'cron issue tracer: failed to notify owner of run error'
        );
      }
    }
  } catch (e) {
    const err = errorMessageFromUnknown(e);
    logger?.warn({ err: e }, `cron issue tracer: ${err}`);
    const sock = getSocket();
    const ownerJid = (getOwnerJid() || '').trim();
    if (sock && ownerJid) {
      try {
        const issuePart =
          repoForMsg != null && issueNumForMsg != null
            ? `issue \`${repoForMsg}#${issueNumForMsg}\` — `
            : '';
        await sock.sendMessage(ownerJid, {
          text: `Cron (WhatsappBot) tick failed while ${issuePart}step *${phase}*: ${truncateErrorSummary(err)}`,
        });
      } catch (sendE) {
        logger?.warn(
          { err: errorMessageFromUnknown(sendE) },
          'cron issue tracer: failed to notify tick failure'
        );
      }
    }
  } finally {
    if (acquired) {
      releaseLock();
    }
  }
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
    try {
      await runCronIssueTracerTick({ getSocket, getOwnerJid, logger });
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
}
