import { join } from 'path';
import { appendFile } from 'fs/promises';
import { runClaudeCliAgent } from './claudeCliAgent.js';
import { setPendingClaudeRun, clearPendingClaudeRun } from './claudeCliPending.js';
import { logAgentInvocation } from './agentUsageLog.js';
import { recordIssueRunResult } from './claudeRunTelemetry.js';
import {
  getRepoHeadShaFull,
  maybeCommitReviewEmail,
  prepareWorkspaceForGithubIssue,
  buildResumeContextSummary,
  findOpenPrForCurrentBranch,
} from './claudePostRun.js';
import { fetchGhIssuePromptText } from './ghIssueForClaude.js';

const WA_TEXT_MAX = 4096;

/**
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessageFromUnknown(err) {
  if (err instanceof Error) {
    const m = err.message;
    return typeof m === 'string' && m.trim() !== '' ? m : err.name || 'Error';
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const m = /** @type {{ message?: unknown }} */ (err).message;
    if (typeof m === 'string' && m.trim() !== '') return m;
  }
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Truncates to a single WhatsApp message (the caller sends exactly one message per run, so
 * this clips instead of chunking into several).
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
function truncateForWhatsApp(text, maxLen = WA_TEXT_MAX) {
  if (!text) return '(no output)';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 15).trimEnd()}\n…(truncated)`;
}

/**
 * One-line reason the agent process itself didn't succeed (spawn/timeout/non-zero exit).
 * @param {{ spawnError?: string, timedOut?: boolean, signal?: string|null, exitCode?: number|null }} result
 */
function agentFailureReason(result) {
  if (result?.spawnError) return `failed to start (${result.spawnError})`;
  if (result?.timedOut) return `timed out (signal ${result?.signal ?? 'n/a'})`;
  return `exited with code ${result?.exitCode ?? 'n/a'}`;
}

/**
 * Short WhatsApp message for a finished `claude issue:<n>` run: one `✅` line on success, a short
 * `⚠️` message naming the problem otherwise, or `null` when there is nothing to report (post-run
 * disabled or the agent changed nothing). The full narrative (`post.note`) goes to the run log.
 *
 * @param {{
 *   issue: { number: number, title?: string },
 *   agentRunOk: boolean,
 *   result?: { spawnError?: string, timedOut?: boolean, signal?: string|null, exitCode?: number|null },
 *   post: Record<string, any> | null,
 *   postErrMessage?: string,
 * }} p
 * @returns {string | null}
 */
export function buildIssueRunWhatsappMessage({ issue, agentRunOk, result, post, postErrMessage = '' }) {
  const label = `#${issue.number}${issue.title ? ` — ${issue.title}` : ''}`;
  const attention = (problem) => `⚠️ ${label}: ${problem} — needs a look.`;

  if (!agentRunOk) return attention(`agent ${agentFailureReason(result)}`);
  if (postErrMessage) return attention(`post-run pipeline failed (${postErrMessage})`);
  if (!post) return null;

  switch (post.skipReason) {
    case 'branch_prep_failed':
      return attention('could not prepare a feature branch');
    case 'empty_diff':
      return attention('changes detected but no diff could be read for review');
    case 'post_run_threw':
      return attention('post-run pipeline failed');
  }
  if (!post.commit) return null; // post-run disabled / no changes: nothing to report

  if (!post.commit.ok) return attention(`auto-commit failed (${post.commit.reason ?? 'unknown'})`);
  if (post.pushResult && !post.pushResult.ok) {
    return attention(`push failed (${post.pushResult.error ?? 'unknown error'})`);
  }
  if (post.prResult && !post.prResult.ok) {
    return attention(`PR creation failed (${post.prResult.error ?? 'unknown error'})`);
  }
  if (post.postReviewAutofix?.mergeBlocked) return attention('merge blocked by the autofix pass');
  if (post.postCloseChangesEmail && !post.postCloseChangesEmail.ok) {
    return attention(`post-close summary email failed (${post.postCloseChangesEmail.step ?? 'unknown step'})`);
  }
  if (post.prAutoMergeResult && !post.prAutoMergeResult.ok) {
    return attention(`auto-merge was not enabled (${post.prAutoMergeResult.error ?? 'unknown error'})`);
  }

  const url = post.prResult?.url ? ` ${post.prResult.url}` : '';
  const title = issue.title ? ` — ${issue.title}` : '';
  const merge = post.prAutoMergeResult;
  if (merge?.ok && (merge.mergedDirectly || post.issueCloseWait?.closed)) {
    return `✅ #${issue.number} merged${title}`;
  }
  if (merge?.ok) return `✅ #${issue.number} merge queued${title}${url}`;
  if (post.prResult?.ok) return `✅ #${issue.number} PR open${title}${url}`;
  return `✅ #${issue.number} pushed${title}`;
}

/**
 * Final result of an issue run for run history: `merged`, `pr_open` (PR created / merge queued),
 * `pushed` (branch pushed, no PR), `no_changes`, `timeout` or `failed`.
 *
 * @param {{
 *   agentRunOk: boolean,
 *   result?: { timedOut?: boolean },
 *   post: Record<string, any> | null,
 *   postErrMessage?: string,
 * }} p
 * @returns {'merged' | 'pr_open' | 'pushed' | 'no_changes' | 'timeout' | 'failed'}
 */
export function classifyIssueRunResult({ agentRunOk, result, post, postErrMessage = '' }) {
  if (result?.timedOut) return 'timeout';
  if (!agentRunOk || postErrMessage || !post) return 'failed';
  if (['branch_prep_failed', 'empty_diff', 'post_run_threw'].includes(post.skipReason)) return 'failed';
  if (!post.commit) return 'no_changes';
  if (
    !post.commit.ok ||
    (post.pushResult && !post.pushResult.ok) ||
    (post.prResult && !post.prResult.ok)
  ) {
    return 'failed';
  }
  const merge = post.prAutoMergeResult;
  if (merge?.ok && (merge.mergedDirectly || post.issueCloseWait?.closed)) return 'merged';
  if (merge?.ok || post.prResult?.ok) return 'pr_open';
  return 'pushed';
}

/**
 * Fetches the GitHub issue, prepares the workspace, and returns the agent prompt. Sends WhatsApp
 * error messages and returns `null` on failure.
 *
 * @param {{
 *   sock: import('@whiskeysockets/baileys').WASocket,
 *   recipientJid: string,
 *   issueNumber: number,
 *   extraInstructions: string,
 *   workspaceRoot: string,
 *   workspaceAlias: string | null,
 * }} p
 * @returns {Promise<{ prompt: string, issueSource: { number: number, repo: string, title: string } } | null>}
 */
export async function runIssueFetchAndGitPrep(p) {
  const { sock, recipientJid, issueNumber, extraInstructions, workspaceRoot, workspaceAlias } = p;

  try {
    const fetched = await fetchGhIssuePromptText(issueNumber, {
      extraInstructions,
      workspaceRoot,
      workspaceAlias,
    });
    let prompt = fetched.markdown;
    const issueSource = {
      number: fetched.number,
      repo: fetched.repo,
      title: fetched.title,
    };

    try {
      const prep = await prepareWorkspaceForGithubIssue(
        workspaceRoot,
        issueNumber,
        issueSource.title
      );
      if (prep.resumed) {
        const resumeNote = await buildResumeContextSummary(workspaceRoot, prep.defaultBranch);
        prompt = [
          prompt,
          '',
          '## Resuming an interrupted run',
          '',
          `You are continuing on the existing branch \`${prep.branchName}\` from a previous run on this ` +
            'same issue that did not finish (it timed out or errored before completing). Do not start over — ' +
            'inspect what is already there (git log, git status, and the files already changed) and continue ' +
            'or finish the remaining tasks.',
          resumeNote ? `\n${resumeNote}` : '',
        ]
          .filter((l) => l !== '')
          .join('\n');
        const pr = await findOpenPrForCurrentBranch(workspaceRoot);
        if (pr) prompt = [prompt, '', buildOpenPrResumeNote(pr, prep.defaultBranch)].join('\n');
      }
    } catch (prepErr) {
      await sock.sendMessage(recipientJid, {
        text: `Git setup for issue #${issueNumber} failed: ${errorMessageFromUnknown(prepErr)}`,
      });
      return null;
    }

    return { prompt, issueSource };
  } catch (err) {
    await sock.sendMessage(recipientJid, {
      text: `Failed to read GitHub issue: ${errorMessageFromUnknown(err)}`,
    });
    return null;
  }
}

/**
 * Resume-prompt section for a branch whose PR is already open but was never merged. A conflict is
 * resolved by merging (not rebasing) the default branch in, so the fix pushes as a fast-forward.
 * @param {{ url: string, state: string }} pr
 * @param {string} defaultBranch
 * @returns {string}
 */
export function buildOpenPrResumeNote(pr, defaultBranch) {
  const lines = [
    '## Open pull request',
    '',
    `This branch already has an open PR that was not merged: ${pr.url}. Read its review comments ` +
      '(`gh pr view --comments`) and address any that are valid.',
  ];
  if (pr.state === 'conflict') {
    lines.push(
      '',
      `**The PR conflicts with \`${defaultBranch}\`.** Run \`git fetch origin\` and \`git merge origin/${defaultBranch}\`, ` +
        'resolve the conflicts keeping the behaviour of both sides, run the tests, and commit the merge. ' +
        'Do not rebase or force-push.'
    );
  }
  return lines.join('\n');
}

/**
 * Whether cron should persist last-started after a finished `runClaudeAgentWithPost`.
 * Empty “success” runs (`clean_after_wait`) and failed agent exits must not suppress retries.
 *
 * @param {unknown} agentResult return value of `runClaudeAgentWithPost` (or a test mock)
 * @returns {boolean}
 */
export function cronShouldPersistLastStarted(agentResult) {
  if (agentResult == null || typeof agentResult !== 'object') {
    // Void / legacy mocks: treat as progress so existing tests keep “successful run” semantics.
    return true;
  }
  const r = /** @type {{ agentRunOk?: unknown, post?: { skipReason?: unknown } | null }} */ (
    agentResult
  );
  if (r.agentRunOk !== true) return false;
  const reason = r.post?.skipReason;
  if (reason === 'clean_after_wait' || reason === 'agent_not_ok') return false;
  return true;
}

/**
 * Runs the Claude agent and post-run PR/review steps (shared by manual and cron issue flows).
 *
 * @param {{
 *   sock: import('@whiskeysockets/baileys').WASocket,
 *   recipientJid: string,
 *   prompt: string,
 *   repo: string,
 *   issueMatch: { issueNumber: number } | null,
 *   issueSource: { number: number, repo: string, title: string } | null,
 *   joplinSource: { title: string, id: string } | null,
 *   trigger?: 'cron' | 'manual',
 * }} p
 * @returns {Promise<{
 *   agentRunOk: boolean,
 *   post: { ran?: boolean, note?: string, skipReason?: string } | null,
 * }>}
 */
export async function runClaudeAgentWithPost(p) {
  const { sock, recipientJid, prompt, repo, issueMatch, issueSource, joplinSource, trigger = 'manual' } = p;

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(repo, 'logs', 'claude-agent', `${runId}.log`);
  const logRel = `logs/claude-agent/${runId}.log`;

  await setPendingClaudeRun({
    sender: recipientJid,
    logPath,
    runId,
    startedAt: new Date().toISOString(),
    workspaceRoot: repo,
  });

  let outcome = 'error';
  let result;
  let delivered = false;
  /** Snapshot of `git rev-parse HEAD` before the CLI agent (issue runs only); used by post-run when the agent commits. */
  let preAgentHeadSha = null;

  try {
    if (issueMatch) {
      try {
        preAgentHeadSha = await getRepoHeadShaFull(repo);
      } catch {
        preAgentHeadSha = null;
      }
    }

    result = await runClaudeCliAgent(prompt, {
      runId,
      workspaceRoot: repo,
      // Only GitHub-issue pickups (manual `claude issue:n` or cron) invoke /implement — the
      // skill has `disable-model-invocation: true`, so freeform WhatsApp prompts and Joplin-note
      // runs (issueMatch is null for both) never trigger it.
      leadingCommand: issueMatch ? '/implement' : undefined,
      meta: {
        trigger,
        kind: issueMatch ? 'issue' : 'freeform',
        repo: issueSource?.repo ?? null,
        issueNumber: issueMatch?.issueNumber ?? null,
        issueTitle: issueSource?.title ?? null,
      },
    });
    if (result.timedOut) outcome = 'timeout';
    else if (result.spawnError) outcome = 'spawn_error';
    else if (result.ok) outcome = 'success';
    else outcome = `exit_${result.exitCode}`;
  } catch (err) {
    outcome = 'exception';
    result = {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: errorMessageFromUnknown(err),
      logPath,
      runId,
    };
  }

  await logAgentInvocation({
    agent: 'claude-cli',
    model: 'agent',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    outcome,
  });

  const agentRunOk = Boolean(
    result?.ok && !result?.spawnError && !result?.timedOut
  );
  /** @type {{ ran?: boolean, note?: string, skipReason?: string } | null} */
  let post = null;
  let postErrMessage = '';

  try {
    post = await maybeCommitReviewEmail({
      repo,
      userPrompt: prompt,
      agentRunOk,
      issueMode: issueMatch ? { number: issueMatch.issueNumber } : null,
      preAgentHeadSha,
      trigger,
    });
  } catch (postErr) {
    postErrMessage = errorMessageFromUnknown(postErr);
    post = { ran: false, note: '', skipReason: 'post_run_threw' };
  }

  if (issueMatch) {
    await recordIssueRunResult({
      runId,
      result: classifyIssueRunResult({ agentRunOk, result, post, postErrMessage }),
    });
  }

  const sourceLabel = issueSource
    ? `issue #${issueSource.number} (${issueSource.repo})`
    : joplinSource
      ? `Joplin note "${joplinSource.title}"`
      : `${repo}`;

  const lines = [];
  if (!agentRunOk) {
    lines.push(`Claude agent on ${sourceLabel} ${agentFailureReason(result)} — needs a look.`);
  }
  if (post.note) lines.push(post.note);
  if (postErrMessage) lines.push(`Post-run commit/PR pipeline failed: ${postErrMessage}`);

  // Issue runs get a short result line on WhatsApp; the full narrative goes to the run log.
  let message = lines.join('\n\n');
  if (issueSource && issueMatch) {
    message = buildIssueRunWhatsappMessage({
      issue: issueSource,
      agentRunOk,
      result,
      post,
      postErrMessage,
    }) ?? '';
    if (lines.length > 0) {
      try {
        await appendFile(logPath, `\n\n--- post-run report ---\n${lines.join('\n\n')}\n`);
      } catch {
        /* log is best-effort */
      }
    }
  }

  try {
    if (message) {
      await sock.sendMessage(recipientJid, { text: truncateForWhatsApp(message) });
    }
    delivered = true;
  } catch {
    /* keep pending file for startup notice */
  } finally {
    if (delivered) await clearPendingClaudeRun();
  }

  return { agentRunOk, post };
}
