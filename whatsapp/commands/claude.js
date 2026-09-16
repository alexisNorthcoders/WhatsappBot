import dotenv from 'dotenv';
import { getDefaultWorkspaceRoot, resolveWorkspaceFromAlias, resolveWorkspaceFromUserPath } from '../claudeWorkspaces.js';
import {
  runIssueFetchAndGitPrep,
  runClaudeAgentWithPost,
} from '../agents/claudeIssuePipeline.js';
import joplinAPI, { WHATSAPP_BOT_NOTEBOOK } from '../../joplin/index.js';
import { actorJid, isAllowedActor, lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
} from '../agents/claudeAgentBusy.js';
import {
  pauseAgentForWorkspace,
  resumeAgentForWorkspace,
  getAgentPauseForWorkspace,
  parsePauseArgs,
  formatDurationSeconds,
} from '../agents/claudeAgentPause.js';

dotenv.config();

const JOPLIN_NOTEBOOK =
  process.env.JOPLIN_AGENT_NOTEBOOK?.trim() || WHATSAPP_BOT_NOTEBOOK;

const JOPLIN_PREFIX_RE = /^joplin:\s*(.+)/is;

/**
 * After the leading `claude` command, detect optional workspace prefix.
 * @returns {{ kind: 'default', rest: string } | { kind: 'alias', alias: string, rest: string } | { kind: 'path', path: string, rest: string }}
 */
function parseWorkspacePrefix(remainder) {
  const trimmed = remainder.trim();
  if (!trimmed) return { kind: 'default', rest: '' };

  // Do not treat `joplin:…` as a workspace alias (reserved for note-based prompts).
  if (/^joplin:\s*/i.test(trimmed)) {
    return { kind: 'default', rest: trimmed };
  }

  // Do not treat `issue:…` as a workspace alias (reserved for GitHub issue prompts).
  if (/^issue:\s*/i.test(trimmed)) {
    return { kind: 'default', rest: trimmed };
  }

  const mAlias = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/s);
  if (mAlias) {
    return { kind: 'alias', alias: mAlias[1], rest: mAlias[2].trim() };
  }

  const mPath = trimmed.match(/^(\/[^\s:]+)(?:\s+|:)\s*(.*)$/s);
  if (mPath) {
    return { kind: 'path', path: mPath[1], rest: mPath[2].trim() };
  }

  const mLone = trimmed.match(/^(\/[^\s:]+)$/s);
  if (mLone) {
    return { kind: 'path', path: mLone[1], rest: '' };
  }

  return { kind: 'default', rest: trimmed };
}

/**
 * Detect `joplin:<query>` at the start of the prompt.
 * Returns { noteQuery } if matched, otherwise null.
 */
function parseJoplinPrefix(prompt) {
  const m = prompt.match(JOPLIN_PREFIX_RE);
  if (!m) return null;
  return { noteQuery: m[1].trim() };
}

/**
 * Detect `issue:<alias>:<n>` or `issue:<n>` at the start of the prompt (checked before joplin).
 * @returns {{ issueNumber: number, issueAlias: string | null, extraInstructions: string } | null}
 */
function parseIssuePrefix(prompt) {
  const trimmed = prompt.trim();
  const mAlias = trimmed.match(/^issue:\s*([a-zA-Z0-9_-]+):\s*(\d+)\s*(.*)$/is);
  if (mAlias) {
    return {
      issueNumber: parseInt(mAlias[2], 10),
      issueAlias: mAlias[1],
      extraInstructions: (mAlias[3] || '').trim(),
    };
  }
  const m = trimmed.match(/^issue:\s*(\d+)\s*(.*)$/is);
  if (!m) return null;
  return {
    issueNumber: parseInt(m[1], 10),
    issueAlias: null,
    extraInstructions: (m[2] || '').trim(),
  };
}

function isHexId(s) {
  return /^[a-f0-9]{6,}$/i.test(s);
}

/**
 * Fetch the body of a Joplin note by title or hex id, scoped to the bot notebook.
 * Returns { title, body, id }.
 */
async function fetchJoplinNote(noteQuery) {
  if (isHexId(noteQuery)) {
    return joplinAPI.getNoteInNotebook(noteQuery, JOPLIN_NOTEBOOK);
  }
  const results = await joplinAPI.searchNotesInNotebook(JOPLIN_NOTEBOOK, noteQuery);
  if (results.length === 0) {
    throw new Error(`No Joplin notes matching "${noteQuery}" in notebook "${JOPLIN_NOTEBOOK}".`);
  }
  const exact = results.find(
    (n) => n.title.toLowerCase() === noteQuery.toLowerCase()
  );
  const best = exact || results[0];
  return joplinAPI.getNoteInNotebook(best.id, JOPLIN_NOTEBOOK);
}

export default async function claudeCommand(sock, sender, text, msg, deps = {}) {
  const pauseForWorkspace = deps.pauseAgentForWorkspace ?? pauseAgentForWorkspace;
  const resumeForWorkspace = deps.resumeAgentForWorkspace ?? resumeAgentForWorkspace;
  const getPauseForWorkspace = deps.getAgentPauseForWorkspace ?? getAgentPauseForWorkspace;

  const actor = actorJid(msg, sender);
  if (!isAllowedActor(actor)) {
    await sock.sendMessage(sender, {
      text:
        `Not allowed to run the Claude agent from this identity.${lidExtraJidsHint(actor)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CLAUDE_AGENT_EXTRA_JIDS.)`,
    });
    return;
  }

  const afterClaude = text.replace(/^claude\s*/i, '').trim();
  if (!afterClaude) {
    await sock.sendMessage(sender, {
      text:
        'Usage:\nclaude <instructions>\nclaude <alias>: <instructions>\nclaude <absolute-path> <instructions>\nclaude issue:<n> [extra instructions]\nclaude issue:<alias>:<n> [extra instructions]\nclaude joplin:<note title or id>\nclaude pause [duration] [reason]\nclaude resume\n\nExamples:\nclaude add a README section about deployment.\nclaude dots: fix the scoring bug\nclaude /home/user/Projects/my-app add tests\nclaude issue:42\nclaude issue:platformer:123 add unit tests\nclaude issue:3 add unit tests\nclaude joplin:refactor-plan\nclaude pause 2h working on issue 90 by hand\nclaude dots: pause 30m\nclaude resume',
    });
    return;
  }

  const ws = parseWorkspacePrefix(afterClaude);
  const rawPrompt = ws.rest;
  if (!rawPrompt) {
    await sock.sendMessage(sender, {
      text: 'Usage: after the workspace prefix, add instructions, issue:…, joplin:…, pause, or resume.\nExample: claude dots: fix the bug',
    });
    return;
  }

  // `pause`/`resume` manage the workspace flag that gates both this command and the cron issue
  // tracer — they are not agent runs, so they bypass the single-flight busy lock entirely.
  const pauseMatch = /^pause(?:\s+(.*))?$/is.exec(rawPrompt);
  const isResumeCommand = /^resume$/is.test(rawPrompt);
  if (pauseMatch || isResumeCommand) {
    let workspaceRoot;
    try {
      if (ws.kind === 'alias') {
        workspaceRoot = await resolveWorkspaceFromAlias(ws.alias);
      } else if (ws.kind === 'path') {
        workspaceRoot = await resolveWorkspaceFromUserPath(ws.path);
      } else {
        workspaceRoot = await getDefaultWorkspaceRoot();
      }
    } catch (e) {
      await sock.sendMessage(sender, {
        text: `Claude workspace: ${e.message || String(e)}`,
      });
      return;
    }

    if (pauseMatch) {
      const { ttlSeconds, reason } = parsePauseArgs(pauseMatch[1] || '');
      const state = await pauseForWorkspace({ workspaceRoot, reason, ttlSeconds });
      const resumeHint = ws.kind === 'alias' ? `claude ${ws.alias}: resume` : 'claude resume';
      await sock.sendMessage(sender, {
        text: `Claude agent paused for \`${workspaceRoot}\` for ${formatDurationSeconds(state.ttlSeconds)} (${state.reason}).\nManual runs and the cron issue tracer will refuse to touch this workspace until it's resumed or the pause expires.\nSend \`${resumeHint}\` to lift it early.`,
      });
    } else {
      const cleared = await resumeForWorkspace({ workspaceRoot });
      await sock.sendMessage(sender, {
        text: cleared
          ? `Claude agent resumed for \`${workspaceRoot}\`.`
          : `No active pause found for \`${workspaceRoot}\`.`,
      });
    }
    return;
  }

  if (!tryAcquireAgentBusyLock()) {
    await sock.sendMessage(sender, {
      text:
        'The Claude agent is busy (another run is in progress — issue or freeform). Try again later.',
    });
    return;
  }
  try {
    let workspaceRoot;
    try {
      if (ws.kind === 'alias') {
        workspaceRoot = await resolveWorkspaceFromAlias(ws.alias);
      } else if (ws.kind === 'path') {
        workspaceRoot = await resolveWorkspaceFromUserPath(ws.path);
      } else {
        workspaceRoot = await getDefaultWorkspaceRoot();
      }
    } catch (e) {
      await sock.sendMessage(sender, {
        text: `Claude workspace: ${e.message || String(e)}`,
      });
      return;
    }

    let prompt = rawPrompt;
    let joplinSource = null;
    let issueSource = null;

    const issueMatch = parseIssuePrefix(rawPrompt);
    let workspaceAliasForRepo = ws.kind === 'alias' ? ws.alias : null;

    if (issueMatch?.issueAlias && ws.kind === 'default') {
      try {
        workspaceRoot = await resolveWorkspaceFromAlias(issueMatch.issueAlias);
      } catch (e) {
        await sock.sendMessage(sender, {
          text: `Claude workspace: ${e.message || String(e)}`,
        });
        return;
      }
      workspaceAliasForRepo = issueMatch.issueAlias;
    }

    const activePause = await getPauseForWorkspace({ workspaceRoot });
    if (activePause) {
      const resumeHint = workspaceAliasForRepo ? `claude ${workspaceAliasForRepo}: resume` : 'claude resume';
      const expiry = activePause.ttlRemainingSeconds
        ? `, resumes automatically in ${formatDurationSeconds(activePause.ttlRemainingSeconds)}`
        : '';
      await sock.sendMessage(sender, {
        text: `Claude agent is paused for \`${workspaceRoot}\` (${activePause.reason}${expiry}).\nSend \`${resumeHint}\` to lift it now.`,
      });
      return;
    }

    if (issueMatch) {
      const prepped = await runIssueFetchAndGitPrep({
        sock,
        recipientJid: sender,
        issueNumber: issueMatch.issueNumber,
        extraInstructions: issueMatch.extraInstructions,
        workspaceRoot,
        workspaceAlias: workspaceAliasForRepo,
      });
      if (!prepped) return;
      prompt = prepped.prompt;
      issueSource = prepped.issueSource;
    } else {
      const joplinMatch = parseJoplinPrefix(rawPrompt);
      if (joplinMatch) {
        try {
          await sock.sendMessage(sender, {
            text: `Reading Joplin note "${joplinMatch.noteQuery}" from notebook "${JOPLIN_NOTEBOOK}" …`,
          });
          const note = await fetchJoplinNote(joplinMatch.noteQuery);
          const body = (note.body || '').trim();
          if (!body) {
            await sock.sendMessage(sender, {
              text: `Joplin note "${note.title}" (${note.id}) has an empty body — nothing to send to Claude.`,
            });
            return;
          }
          prompt = body;
          joplinSource = { title: note.title, id: note.id };
        } catch (err) {
          await sock.sendMessage(sender, {
            text: `Failed to read Joplin note: ${err.message || String(err)}`,
          });
          return;
        }
      }
    }

    await runClaudeAgentWithPost({
      sock,
      recipientJid: sender,
      prompt,
      repo: workspaceRoot,
      issueMatch,
      issueSource,
      joplinSource,
    });
  } finally {
    releaseAgentBusyLock();
  }
}
