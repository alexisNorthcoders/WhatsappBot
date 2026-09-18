import {
  listOpenGithubIssues,
  resolveIssueRepoSlug,
  resolveIssueRepoSlugForWorkspace,
  getGithubIssueBlockedByCount,
} from './ghIssueForClaude.js';
import { getDefaultWorkspaceRoot, resolveWorkspaceFromAlias } from '../claudeWorkspaces.js';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
  isClaudeAgentBusy,
} from './claudeAgentBusy.js';
import {
  readCronPerRepoLastStarted,
  writeCronPerRepoLastStartedEntry,
} from './cronLastStartedIssue.js';
import {
  runIssueFetchAndGitPrep,
  runClaudeAgentWithPost,
  cronShouldPersistLastStarted,
  errorMessageFromUnknown,
} from './claudeIssuePipeline.js';
import { getAgentPauseForWorkspace } from './claudeAgentPause.js';

const DEFAULT_MS = 10 * 60 * 1000;

/** Only issues carrying this label are eligible for cron pickup. */
const READY_FOR_AGENT_LABEL = 'ready-for-agent';

/**
 * Secondary repos tried (in order, after this bot's own repo) each tick, one issue per tick
 * across the whole cron run. Each alias must exist in `CLAUDE_WORKSPACE_MAP`.
 * `CRON_SECONDARY_WORKSPACE_ALIASES` (comma-separated) is preferred; the older single-alias
 * `CRON_PLATFORMER_WORKSPACE_ALIAS` is still honored when the list var is unset.
 */
const CRON_SECONDARY_WORKSPACE_ALIASES = (() => {
  const raw = process.env.CRON_SECONDARY_WORKSPACE_ALIASES?.trim();
  if (raw) {
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list;
  }
  const legacy = (process.env.CRON_PLATFORMER_WORKSPACE_ALIAS || 'platformer').trim();
  return legacy ? [legacy] : [];
})();

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;

/**
 * @param {{ number: number, title: string, labels?: string[] }[]} rows
 * @returns {{ number: number, title: string, labels?: string[] }[]}
 */
function filterReadyForAgentRows(rows) {
  return rows.filter(
    (r) =>
      Array.isArray(r.labels) &&
      r.labels.some((l) => String(l).trim().toLowerCase() === READY_FOR_AGENT_LABEL)
  );
}

/**
 * @param {{ number: number, title: string, labels?: string[] }[]} rows
 * @returns {{ number: number, title: string, labels?: string[] } | null} lowest OPEN issue labeled `ready-for-agent`
 */
export function pickNextEligibleIssue(rows) {
  const eligible = filterReadyForAgentRows(rows);
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (a.number < b.number ? a : b));
}

/**
 * Lowest `ready-for-agent`-labeled eligible issue for `gitRepo` that is not suppressed by
 * per-repo last-started. Excludes the last-started issue itself from consideration (rather than
 * bailing out entirely when it happens to be the lowest-numbered eligible issue) so a completed
 * run whose issue wasn't auto-closed (e.g. a merged PR that didn't reference "Closes #N") can't
 * permanently block every other queued issue in the same repo.
 *
 * @param {{ number: number, title: string, labels?: string[] }[]} rows
 * @param {string} gitRepo
 * @param {Map<string, number>} lastByRepo
 * @returns {{ number: number, title: string, labels?: string[] } | null}
 */
export function pickNextRunnableIssueForRepo(rows, gitRepo, lastByRepo) {
  const sorted = sortedEligibleIssuesForRepo(rows, gitRepo, lastByRepo);
  return sorted.length ? sorted[0] : null;
}

/**
 * Same eligibility filter as `pickNextRunnableIssueForRepo` (ready-for-agent labeled, excluding
 * the repo's last-started issue), but returns every candidate in ascending issue-number order
 * instead of just the lowest — lets a dependency-blocked check skip forward within the same repo.
 *
 * @param {{ number: number, title: string, labels?: string[] }[]} rows
 * @param {string} gitRepo
 * @param {Map<string, number>} lastByRepo
 * @returns {{ number: number, title: string, labels?: string[] }[]}
 */
export function sortedEligibleIssuesForRepo(rows, gitRepo, lastByRepo) {
  const lastStarted = lastByRepo.get(gitRepo);
  const candidates = lastStarted == null ? rows : rows.filter((r) => r.number !== lastStarted);
  return filterReadyForAgentRows(candidates)
    .slice()
    .sort((a, b) => a.number - b.number);
}

/**
 * Like `pickNextRunnableIssueForRepo`, but skips any candidate that GitHub's native issue
 * dependencies report as currently blocked (`issue_dependencies_summary.blocked_by > 0` — see
 * docs/agents/issue-tracker.md's "Blocking" convention), trying the next-lowest eligible issue in
 * the same repo before giving up on it. A lookup failure is treated as blocked (fail-safe) rather
 * than risking work on a dependency we couldn't actually confirm is resolved.
 *
 * @param {{ number: number, title: string, labels?: string[] }[]} rows
 * @param {string} gitRepo
 * @param {Map<string, number>} lastByRepo
 * @param {{ getBlockedByCount: (repo: string, issueNumber: number) => Promise<number> }} deps
 * @returns {Promise<{ number: number, title: string, labels?: string[] } | null>}
 */
export async function pickNextRunnableUnblockedIssueForRepo(rows, gitRepo, lastByRepo, deps) {
  const candidates = sortedEligibleIssuesForRepo(rows, gitRepo, lastByRepo);
  for (const candidate of candidates) {
    let blockedByCount;
    try {
      blockedByCount = await deps.getBlockedByCount(gitRepo, candidate.number);
    } catch {
      blockedByCount = 1;
    }
    if (!blockedByCount) return candidate;
  }
  return null;
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
 *   resolveIssueRepoSlugForWorkspace?: typeof resolveIssueRepoSlugForWorkspace,
 *   getDefaultWorkspaceRoot?: typeof getDefaultWorkspaceRoot,
 *   resolveWorkspaceFromAlias?: typeof resolveWorkspaceFromAlias,
 *   readCronPerRepoLastStarted?: typeof readCronPerRepoLastStarted,
 *   writeCronPerRepoLastStartedEntry?: typeof writeCronPerRepoLastStartedEntry,
 *   tryAcquireAgentBusyLock?: typeof tryAcquireAgentBusyLock,
 *   releaseAgentBusyLock?: typeof releaseAgentBusyLock,
 *   isClaudeAgentBusy?: typeof isClaudeAgentBusy,
 *   runIssueFetchAndGitPrep?: typeof runIssueFetchAndGitPrep,
 *   runClaudeAgentWithPost?: typeof runClaudeAgentWithPost,
 *   getAgentPauseForWorkspace?: typeof getAgentPauseForWorkspace,
 *   cronSecondaryWorkspaceAliases?: string[],
 *   getGithubIssueBlockedByCount?: typeof getGithubIssueBlockedByCount,
 * }} CronIssueTracerTickDeps
 */

/**
 * One cron evaluation cycle (exported for tests; production uses `startCronIssueTracer`).
 * Persists last-started per GitHub repo only after `runClaudeAgentWithPost` completes with
 * lasting progress (agent ok and not an empty/no-git-change run). Crashes, failed exits, and
 * empty “success” runs do not suppress retries for the same open issue in that repo.
 *
 * @param {CronIssueTracerTickDeps} [deps]
 */
export async function runCronIssueTracerTick(deps = {}) {
  const getSocket = deps.getSocket ?? (() => null);
  const getOwnerJid = deps.getOwnerJid ?? (() => null);
  const logger = deps.logger;
  const listIssues = deps.listOpenGithubIssues ?? listOpenGithubIssues;
  const resolveRepo = deps.resolveIssueRepoSlug ?? resolveIssueRepoSlug;
  const resolveForWs = deps.resolveIssueRepoSlugForWorkspace ?? resolveIssueRepoSlugForWorkspace;
  const getWorkspace = deps.getDefaultWorkspaceRoot ?? getDefaultWorkspaceRoot;
  const resolvePlatRoot = deps.resolveWorkspaceFromAlias ?? resolveWorkspaceFromAlias;
  const readPerRepo = deps.readCronPerRepoLastStarted ?? readCronPerRepoLastStarted;
  const writePerRepo = deps.writeCronPerRepoLastStartedEntry ?? writeCronPerRepoLastStartedEntry;
  const tryLock = deps.tryAcquireAgentBusyLock ?? tryAcquireAgentBusyLock;
  const releaseLock = deps.releaseAgentBusyLock ?? releaseAgentBusyLock;
  const agentBusy = deps.isClaudeAgentBusy ?? isClaudeAgentBusy;
  const runPrep = deps.runIssueFetchAndGitPrep ?? runIssueFetchAndGitPrep;
  const runAgent = deps.runClaudeAgentWithPost ?? runClaudeAgentWithPost;
  const getPause = deps.getAgentPauseForWorkspace ?? getAgentPauseForWorkspace;
  const secondaryAliases = deps.cronSecondaryWorkspaceAliases ?? CRON_SECONDARY_WORKSPACE_ALIASES;
  const getBlockedByCount = deps.getGithubIssueBlockedByCount ?? getGithubIssueBlockedByCount;

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

    /**
     * @param {string} cronLabel
     * @param {string} gitRepo
     * @param {{ number: number, title: string }} next
     * @param {string} workspaceRoot
     * @param {string | null} workspaceAlias
     */
    const runCronIssueJob = async (cronLabel, gitRepo, next, workspaceRoot, workspaceAlias) => {
      repoForMsg = gitRepo;
      issueNumForMsg = next.number;

      phase = 'issue fetch / git prep';
      const prepped = await runPrep({
        sock,
        recipientJid: ownerJid,
        issueNumber: next.number,
        extraInstructions: '',
        workspaceRoot,
        workspaceAlias,
      });

      if (!prepped) {
        await sock.sendMessage(ownerJid, {
          text: `Cron (${cronLabel}): could not start work on #${next.number} in \`${gitRepo}\` (step: issue fetch or git prep failed; see the message above if one was sent).`,
        });
        return;
      }

      const issueMatch = { issueNumber: next.number, extraInstructions: '' };
      phase = 'claude agent run and post-run automation';
      try {
        const agentResult = await runAgent({
          sock,
          recipientJid: ownerJid,
          prompt: prepped.prompt,
          repo: workspaceRoot,
          issueMatch,
          issueSource: prepped.issueSource,
          joplinSource: null,
        });
        if (!cronShouldPersistLastStarted(agentResult)) {
          const skip = agentResult?.post?.skipReason;
          const why =
            skip === 'clean_after_wait'
              ? 'the agent finished with no git changes (empty run)'
              : agentResult?.agentRunOk === false
                ? 'the agent run did not succeed'
                : `post-run reported skipReason=${String(skip || 'unknown')}`;
          phase = 'notifying owner (not persisting last-started)';
          await sock.sendMessage(ownerJid, {
            text: [
              `Cron (${cronLabel}): \`${gitRepo}\` issue #${next.number} did not make lasting progress (${why}).`,
              '',
              'Not recording last-started — the next cron tick can retry this issue.',
            ].join('\n'),
          });
          return;
        }
        phase = 'persisting last-started issue';
        await writePerRepo({ repo: gitRepo, number: next.number });
      } catch (runErr) {
        const e = errorMessageFromUnknown(runErr);
        try {
          await sock.sendMessage(ownerJid, {
            text: [
              `Cron (${cronLabel}): the Claude run for \`${gitRepo}\` issue #${next.number} failed during: ${phase}.`,
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
    };

    phase = 'reading last-started by repo';
    const lastByRepo = await readPerRepo();

    phase = 'listing open GitHub issues (WhatsappBot)';
    const whRepo = resolveRepo();
    const whRows = await listIssues({ repo: whRepo });
    const nextWh = await pickNextRunnableUnblockedIssueForRepo(whRows, whRepo, lastByRepo, {
      getBlockedByCount,
    });

    if (nextWh != null) {
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

      phase = 'checking agent pause (WhatsappBot)';
      const whPause = await getPause({ workspaceRoot });
      if (whPause) {
        // Fall through to the secondary repos instead of returning — pausing this workspace
        // shouldn't block cron from working an unrelated repo.
        logger?.info(
          { workspaceRoot, reason: whPause.reason },
          'cron issue tracer: skipping WhatsappBot — workspace paused'
        );
      } else {
        if (!tryLock()) {
          return;
        }
        acquired = true;
        await runCronIssueJob('WhatsappBot', whRepo, nextWh, workspaceRoot, null);
        return;
      }
    }

    for (const alias of secondaryAliases) {
      phase = `resolving secondary repo (${alias})`;
      /** @type {string} */
      let secRoot;
      /** @type {string} */
      let secGitRepo;
      try {
        secRoot = await resolvePlatRoot(alias);
        secGitRepo = await resolveForWs(secRoot, alias);
      } catch (e) {
        const msg = errorMessageFromUnknown(e);
        logger?.warn({ err: e }, `cron issue tracer: "${alias}" not available: ${msg}`);
        continue;
      }

      phase = `checking agent pause (${alias})`;
      const secPause = await getPause({ workspaceRoot: secRoot });
      if (secPause) {
        logger?.info(
          { workspaceRoot: secRoot, reason: secPause.reason },
          `cron issue tracer: skipping ${alias} — workspace paused`
        );
        continue;
      }

      phase = `listing open GitHub issues (${alias})`;
      const secRows = await listIssues({ repo: secGitRepo });
      const nextSec = await pickNextRunnableUnblockedIssueForRepo(secRows, secGitRepo, lastByRepo, {
        getBlockedByCount,
      });
      if (nextSec == null) {
        continue;
      }
      if (!tryLock()) {
        return;
      }
      acquired = true;

      await runCronIssueJob(alias, secGitRepo, nextSec, secRoot, alias);
      return;
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
          text: `Cron tick failed while ${issuePart}step *${phase}*: ${truncateErrorSummary(err)}`,
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
 * Interval job: if the Claude agent is free, find the next eligible open issue, preferring
 * this bot’s repo, then each secondary allowlisted workspace in `CRON_SECONDARY_WORKSPACE_ALIASES`
 * order, stopping at the first one with a runnable issue.
 * Runs the same pipeline as manual `claude issue:…` (fetch, git prep, agent, post-run automation).
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
