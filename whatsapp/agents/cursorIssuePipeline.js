import { join } from 'path';
import { runCursorCliAgent } from './cursorCliAgent.js';
import { setPendingCursorRun, clearPendingCursorRun } from './cursorCliPending.js';
import { logAgentInvocation } from './agentUsageLog.js';
import { maybeCommitReviewEmail, prepareWorkspaceForGithubIssue } from './cursorPostRun.js';
import { fetchGhIssuePromptText } from './ghIssueForCursor.js';

const WA_TEXT_MAX = 4096;

/**
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string[]}
 */
function splitWhatsAppChunks(text, maxLen = WA_TEXT_MAX) {
  if (!text || text.length <= maxLen) return text ? [text] : ['(no output)'];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let chunk = remaining.slice(0, maxLen);
    const nl = chunk.lastIndexOf('\n');
    if (nl > Math.floor(maxLen * 0.5)) chunk = chunk.slice(0, nl + 1);
    parts.push(chunk.replace(/\s+$/, ''));
    remaining = remaining.slice(chunk.length);
  }
  return parts;
}

/** @param {Record<string, unknown> & { logPath?: string, spawnError?: string, timedOut?: boolean, exitCode?: number|null, signal?: string|null, ok?: boolean, stdout?: string, stderr?: string }} result */
function formatAgentResult(result) {
  const lines = [];
  if (result.logPath) {
    lines.push(`Log file: ${result.logPath}`);
    lines.push('');
  }
  if (result.spawnError) {
    lines.push(`Spawn error: ${result.spawnError}`);
    return lines.join('\n');
  }
  if (result.timedOut) {
    lines.push(
      `Timed out (exit ${result.exitCode ?? 'n/a'}, signal ${result.signal ?? 'n/a'}).`
    );
  } else {
    lines.push(`Exit code: ${result.exitCode ?? 'n/a'}`);
  }
  if (result.stdout?.trim()) {
    lines.push('--- stdout ---');
    lines.push(result.stdout.trimEnd());
  }
  if (result.stderr?.trim()) {
    lines.push('--- stderr ---');
    lines.push(result.stderr.trimEnd());
  }
  if (lines.length === 1 && lines[0].startsWith('Exit code:')) {
    lines.push('(no stdout/stderr captured)');
  }
  return lines.join('\n');
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
 *   sendProgressMessages?: boolean,
 * }} p
 * @returns {Promise<{ prompt: string, issueSource: { number: number, repo: string, title: string } } | null>}
 */
export async function runIssueFetchAndGitPrep(p) {
  const {
    sock,
    recipientJid,
    issueNumber,
    extraInstructions,
    workspaceRoot,
    workspaceAlias,
    sendProgressMessages = true,
  } = p;

  try {
    if (sendProgressMessages) {
      await sock.sendMessage(recipientJid, {
        text: `Fetching GitHub issue #${issueNumber} …`,
      });
    }
    const fetched = await fetchGhIssuePromptText(issueNumber, {
      extraInstructions,
      workspaceRoot,
      workspaceAlias,
    });
    const prompt = fetched.markdown;
    const issueSource = {
      number: fetched.number,
      repo: fetched.repo,
      title: fetched.title,
    };

    try {
      if (sendProgressMessages) {
        await sock.sendMessage(recipientJid, {
          text: `Preparing git in ${workspaceRoot}: checkout latest default branch, pull from origin, create issue branch …`,
        });
      }
      const prep = await prepareWorkspaceForGithubIssue(
        workspaceRoot,
        issueNumber,
        issueSource.title
      );
      if (sendProgressMessages) {
        await sock.sendMessage(recipientJid, {
          text: `Ready on branch \`${prep.branchName}\` (synced from \`${prep.defaultBranch}\`).`,
        });
      }
    } catch (prepErr) {
      await sock.sendMessage(recipientJid, {
        text: `Git setup for issue #${issueNumber} failed: ${prepErr.message || String(prepErr)}`,
      });
      return null;
    }

    return { prompt, issueSource };
  } catch (err) {
    await sock.sendMessage(recipientJid, {
      text: `Failed to read GitHub issue: ${err.message || String(err)}`,
    });
    return null;
  }
}

/**
 * Runs the Cursor agent and post-run PR/review steps (shared by manual and cron issue flows).
 *
 * @param {{
 *   sock: import('@whiskeysockets/baileys').WASocket,
 *   recipientJid: string,
 *   prompt: string,
 *   repo: string,
 *   issueMatch: { issueNumber: number } | null,
 *   issueSource: { number: number, repo: string, title: string } | null,
 *   joplinSource: { title: string, id: string } | null,
 *   sendProgressMessages?: boolean,
 * }} p
 */
export async function runCursorAgentWithPost(p) {
  const {
    sock,
    recipientJid,
    prompt,
    repo,
    issueMatch,
    issueSource,
    joplinSource,
    sendProgressMessages = true,
  } = p;

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(repo, 'logs', 'cursor-agent', `${runId}.log`);
  const logRel = `logs/cursor-agent/${runId}.log`;

  await setPendingCursorRun({
    sender: recipientJid,
    logPath,
    runId,
    startedAt: new Date().toISOString(),
    workspaceRoot: repo,
  });

  let outcome = 'error';
  let result;
  let delivered = false;

  try {
    const sourceHint = issueSource
      ? `\nSource: GitHub issue #${issueSource.number} (${issueSource.repo}) — ${issueSource.title || '(no title)'}`
      : joplinSource
        ? `\nSource: Joplin note "${joplinSource.title}" (${joplinSource.id})`
        : '';
    if (sendProgressMessages) {
      await sock.sendMessage(recipientJid, {
        text:
          `Running Cursor agent in ${repo} …${sourceHint}\n\nLive log (on the Pi):\n${logPath}\n\ntail -f ${logRel}`,
      });
    }

    result = await runCursorCliAgent(prompt, { runId, workspaceRoot: repo });
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
      stderr: String(err?.message || err),
      logPath,
      runId,
    };
  }

  await logAgentInvocation({
    agent: 'cursor-cli',
    model: 'agent',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    outcome,
  });

  try {
    const body = formatAgentResult(result);
    const chunks = splitWhatsAppChunks(body);
    for (const chunk of chunks) {
      await sock.sendMessage(recipientJid, { text: chunk });
    }

    const agentRunOk = Boolean(
      result?.ok && !result?.spawnError && !result?.timedOut
    );
    try {
      const post = await maybeCommitReviewEmail({
        repo,
        userPrompt: prompt,
        agentRunOk,
        issueMode: issueMatch ? { number: issueMatch.issueNumber } : null,
      });
      if (post.note) {
        await sock.sendMessage(recipientJid, { text: post.note });
      }
    } catch (postErr) {
      await sock.sendMessage(recipientJid, {
        text: `Post-run commit/PR pipeline failed: ${postErr.message || String(postErr)}`,
      });
    }

    delivered = true;
  } catch (sendErr) {
    try {
      await sock.sendMessage(recipientJid, {
        text: `Could not send full Cursor result (${sendErr.message}). Log: ${result?.logPath ?? logPath}`,
      });
      delivered = true;
    } catch {
      /* keep pending file for startup notice */
    }
  } finally {
    if (delivered) await clearPendingCursorRun();
  }
}
