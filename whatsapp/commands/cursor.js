import dotenv from 'dotenv';
import { join } from 'path';
import { runCursorCliAgent, getCursorCliRepoRoot } from '../agents/cursorCliAgent.js';
import {
  setPendingCursorRun,
  clearPendingCursorRun,
} from '../agents/cursorCliPending.js';
import { logAgentInvocation } from '../agents/agentUsageLog.js';
import { maybeCommitReviewEmail } from '../agents/cursorPostRun.js';
import joplinAPI, { WHATSAPP_BOT_NOTEBOOK } from '../../joplin/index.js';
import { actorJid, isAllowedActor, lidExtraJidsHint } from '../whatsAppActorAllowlist.js';

dotenv.config();

const WA_TEXT_MAX = 4096;
const JOPLIN_NOTEBOOK =
  process.env.JOPLIN_AGENT_NOTEBOOK?.trim() || WHATSAPP_BOT_NOTEBOOK;

const JOPLIN_PREFIX_RE = /^joplin:\s*(.+)/i;

/**
 * Detect `joplin:<query>` at the start of the prompt.
 * Returns { noteQuery } if matched, otherwise null.
 */
function parseJoplinPrefix(prompt) {
  const m = prompt.match(JOPLIN_PREFIX_RE);
  if (!m) return null;
  return { noteQuery: m[1].trim() };
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
    lines.push(`Timed out (exit ${result.exitCode ?? 'n/a'}, signal ${result.signal ?? 'n/a'}).`);
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

export default async function cursorCommand(sock, sender, text, msg) {
  const actor = actorJid(msg, sender);
  if (!isAllowedActor(actor)) {
    await sock.sendMessage(sender, {
      text:
        `Not allowed to run the Cursor agent from this identity.${lidExtraJidsHint(actor)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)`,
    });
    return;
  }

  const rawPrompt = text.replace(/^cursor\s*/i, '').trim();
  if (!rawPrompt) {
    await sock.sendMessage(sender, {
      text: 'Usage:\ncursor <instructions>\ncursor joplin:<note title or id>\n\nExamples:\ncursor add a README section about deployment.\ncursor joplin:refactor-plan',
    });
    return;
  }

  let prompt = rawPrompt;
  let joplinSource = null;

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
          text: `Joplin note "${note.title}" (${note.id}) has an empty body — nothing to send to Cursor.`,
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

  const repo = getCursorCliRepoRoot();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(repo, 'logs', 'cursor-agent', `${runId}.log`);
  const logRel = `logs/cursor-agent/${runId}.log`;

  await setPendingCursorRun(repo, {
    sender,
    logPath,
    runId,
    startedAt: new Date().toISOString(),
  });

  let outcome = 'error';
  let result;
  let delivered = false;

  try {
    const sourceHint = joplinSource
      ? `\nSource: Joplin note "${joplinSource.title}" (${joplinSource.id})`
      : '';
    await sock.sendMessage(sender, {
      text:
        `Running Cursor agent in ${repo} …${sourceHint}\n\nLive log (on the Pi):\n${logPath}\n\ntail -f ${logRel}`,
    });

    result = await runCursorCliAgent(prompt, { runId });
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
      await sock.sendMessage(sender, { text: chunk });
    }

    const agentRunOk = Boolean(
      result?.ok && !result?.spawnError && !result?.timedOut
    );
    try {
      const post = await maybeCommitReviewEmail({
        repo,
        userPrompt: prompt,
        agentRunOk,
      });
      if (post.note) {
        await sock.sendMessage(sender, { text: post.note });
      }
    } catch (postErr) {
      await sock.sendMessage(sender, {
        text: `Post-run commit/review/email failed: ${postErr.message || String(postErr)}`,
      });
    }

    delivered = true;
  } catch (sendErr) {
    try {
      await sock.sendMessage(sender, {
        text: `Could not send full Cursor result (${sendErr.message}). Log: ${result?.logPath ?? logPath}`,
      });
      delivered = true;
    } catch {
      /* keep pending file for startup notice */
    }
  } finally {
    if (delivered) await clearPendingCursorRun(repo);
  }
}
