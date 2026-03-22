import dotenv from 'dotenv';
import { join } from 'path';
import { runCursorCliAgent, getCursorCliRepoRoot } from '../agents/cursorCliAgent.js';
import {
  setPendingCursorRun,
  clearPendingCursorRun,
} from '../agents/cursorCliPending.js';
import { logAgentInvocation } from '../agents/agentUsageLog.js';

dotenv.config();

const WA_TEXT_MAX = 4096;

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/** User part before @, strip :device and _agent suffixes (matches Baileys jidDecode user). */
function jidUserPart(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const at = jid.indexOf('@');
  if (at < 0) return '';
  const combined = jid.slice(0, at);
  const userAgent = combined.split(':')[0];
  return userAgent.split('_')[0] || '';
}

/** Phone digits for @s.whatsapp.net / @c.us only (not @lid). */
function phoneDigitsFromPnJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const server = jid.slice(jid.indexOf('@') + 1);
  if (server !== 's.whatsapp.net' && server !== 'c.us') return '';
  return digitsOnly(jidUserPart(jid));
}

function allowedPhoneDigitsSet() {
  const set = new Set();
  for (const raw of [process.env.MY_PHONE, process.env.SECOND_PHONE]) {
    const d = digitsOnly(raw);
    if (d) set.add(d);
  }
  return set;
}

/** Baileys may use @s.whatsapp.net while .env stores @c.us; DMs may arrive as @lid — match phones by digits, or list extra JIDs. */
function extraAllowedJids() {
  const raw = process.env.CURSOR_AGENT_EXTRA_JIDS?.trim();
  if (!raw) return [];
  return raw.split(',').map((j) => j.trim()).filter(Boolean);
}

/** Baileys may use @s.whatsapp.net while .env sometimes stores @c.us — allow both for the same user id. */
function jidVariants(envValue) {
  const v = envValue?.trim();
  if (!v) return [];
  if (v.includes('@')) {
    const user = v.split('@')[0];
    if (!user) return [v];
    return [`${user}@s.whatsapp.net`, `${user}@c.us`];
  }
  return [`${v}@s.whatsapp.net`, `${v}@c.us`];
}

function allowedJidsExact() {
  return [...jidVariants(process.env.MY_PHONE), ...jidVariants(process.env.SECOND_PHONE), ...extraAllowedJids()];
}

/**
 * Who sent the message: in groups `remoteJid` is the group; use `participant`.
 * @param {import('@whiskeysockets/baileys').proto.WebMessageInfo} [msg]
 * @param {string} remoteJid
 */
function actorJid(msg, remoteJid) {
  const p = msg?.key?.participant;
  if (p) return p;
  return remoteJid;
}

function isAllowedActor(actorJid) {
  const phones = allowedPhoneDigitsSet();
  const fromPn = phoneDigitsFromPnJid(actorJid);
  if (fromPn && phones.has(fromPn)) return true;
  return allowedJidsExact().includes(actorJid);
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
    const lidHint =
      actor?.endsWith('@lid') ? `\n\nAdd to .env:\nCURSOR_AGENT_EXTRA_JIDS=${actor}` : '';
    await sock.sendMessage(sender, {
      text:
        `Not allowed to run the Cursor agent from this identity.${lidHint}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)`,
    });
    return;
  }

  const prompt = text.replace(/^cursor\s*/i, '').trim();
  if (!prompt) {
    await sock.sendMessage(sender, {
      text: 'Usage: cursor <instructions for the agent>\nExample: cursor add a README section about deployment.',
    });
    return;
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
    await sock.sendMessage(sender, {
      text:
        `Running Cursor agent in ${repo} …\n\nLive log (on the Pi):\n${logPath}\n\ntail -f ${logRel}`,
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
