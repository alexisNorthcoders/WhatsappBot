import dotenv from 'dotenv';
import { getDefaultWorkspaceRoot, resolveWorkspaceFromAlias, resolveWorkspaceFromUserPath } from '../cursorWorkspaces.js';
import {
  runIssueFetchAndGitPrep,
  runCursorAgentWithPost,
} from '../agents/cursorIssuePipeline.js';
import joplinAPI, { WHATSAPP_BOT_NOTEBOOK } from '../../joplin/index.js';
import { actorJid, isAllowedActor, lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
} from '../agents/cursorAgentBusy.js';

dotenv.config();

const JOPLIN_NOTEBOOK =
  process.env.JOPLIN_AGENT_NOTEBOOK?.trim() || WHATSAPP_BOT_NOTEBOOK;

const JOPLIN_PREFIX_RE = /^joplin:\s*(.+)/is;

/**
 * After the leading `cursor` command, detect optional workspace prefix.
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

export default async function cursorCommand(sock, sender, text, msg) {
  const actor = actorJid(msg, sender);
  if (!isAllowedActor(actor)) {
    await sock.sendMessage(sender, {
      text:
        `Not allowed to run the Cursor agent from this identity.${lidExtraJidsHint(actor)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)`,
    });
    return;
  }

  const afterCursor = text.replace(/^cursor\s*/i, '').trim();
  if (!afterCursor) {
    await sock.sendMessage(sender, {
      text:
        'Usage:\ncursor <instructions>\ncursor <alias>: <instructions>\ncursor <absolute-path> <instructions>\ncursor issue:<n> [extra instructions]\ncursor issue:<alias>:<n> [extra instructions]\ncursor joplin:<note title or id>\n\nExamples:\ncursor add a README section about deployment.\ncursor dots: fix the scoring bug\ncursor /home/user/Projects/my-app add tests\ncursor issue:42\ncursor issue:platformer:123 add unit tests\ncursor issue:3 add unit tests\ncursor joplin:refactor-plan',
    });
    return;
  }

  const ws = parseWorkspacePrefix(afterCursor);
  const rawPrompt = ws.rest;
  if (!rawPrompt) {
    await sock.sendMessage(sender, {
      text: 'Usage: after the workspace prefix, add instructions, issue:…, or joplin:…\nExample: cursor dots: fix the bug',
    });
    return;
  }

  if (!tryAcquireAgentBusyLock()) {
    await sock.sendMessage(sender, {
      text:
        'The Cursor agent is busy (another run is in progress — issue or freeform). Try again later.',
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
        text: `Cursor workspace: ${e.message || String(e)}`,
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
          text: `Cursor workspace: ${e.message || String(e)}`,
        });
        return;
      }
      workspaceAliasForRepo = issueMatch.issueAlias;
    }

    if (issueMatch) {
      const prepped = await runIssueFetchAndGitPrep({
        sock,
        recipientJid: sender,
        issueNumber: issueMatch.issueNumber,
        extraInstructions: issueMatch.extraInstructions,
        workspaceRoot,
        workspaceAlias: workspaceAliasForRepo,
        sendProgressMessages: true,
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
    }

    await runCursorAgentWithPost({
      sock,
      recipientJid: sender,
      prompt,
      repo: workspaceRoot,
      issueMatch,
      issueSource,
      joplinSource,
      sendProgressMessages: true,
    });
  } finally {
    releaseAgentBusyLock();
  }
}
