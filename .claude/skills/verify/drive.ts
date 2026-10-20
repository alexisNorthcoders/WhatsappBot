/**
 * Drive the real bot pipeline with synthetic WhatsApp messages, without a socket.
 *
 *   node --no-deprecation .claude/skills/verify/drive.ts "<message>" ["<next message>" ...] [--as owner|second|stranger] [--chat <jid>]
 *
 * Several messages run in order, in one chat and one process, so chat memory and numbered lists
 * carry over between them as they do in the live bot.
 *
 * Runs the production handler (allowlist, normalize, orchestrator, commands, agents) with a fake
 * socket that records replies instead of sending them. External systems (OpenAI, DeepInfra, Hue,
 * Joplin, Google Calendar, Gmail) are real. agent-runner is read-only: `claude…` text is recorded,
 * never forwarded, since a forward would start a real Claude run.
 */
import dotenv from 'dotenv';
import pino from 'pino';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { WAMessage } from '@whiskeysockets/baileys';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.chdir(repo);
dotenv.config();

const { createBaileysMessageHandler } = await import('../../../whatsapp/orchestration/createBaileysMessageHandler.ts');
const { createProductionPorts } = await import('../../../whatsapp/orchestration/createProductionPorts.ts');
const { createAgentRunnerClient } = await import('../../../whatsapp/agentRunner/agentRunnerClient.ts');
const { isAllowedActor } = await import('../../../whatsapp/whatsAppActorAllowlist.ts');
const commands = await import('../../../whatsapp/commands/index.ts');
const { initializeLightCache } = await import('../../../hue/index.ts');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { as: { type: 'string', default: 'owner' }, chat: { type: 'string' } },
});
const texts = positionals.map((t) => t.trim()).filter(Boolean);
if (!texts.length) {
  console.error('usage: drive.ts "<message>" ["<next message>" ...] [--as owner|second|stranger] [--chat <jid>]');
  process.exit(2);
}

const phoneJid = (n: string | undefined) => (n ? `${n.replace(/\D/g, '')}@s.whatsapp.net` : undefined);
const actors: Record<string, string | undefined> = {
  owner: phoneJid(process.env.MY_PHONE),
  second: phoneJid(process.env.SECOND_PHONE),
  stranger: '15550000000@s.whatsapp.net',
};
const actorId = actors[values.as!];
if (!actorId) {
  console.error(`--as ${values.as}: unknown actor, or its phone env var is unset`);
  process.exit(2);
}

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
// A group-shaped chat keeps chat memory and per-chat lists away from the owner's real DM.
const chatId = values.chat ?? `verify-${stamp}@g.us`;
const outDir = path.join(repo, 'logs', 'verify');
mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, `${stamp}.log`);
const logger = pino({ level: 'debug' }, pino.destination({ dest: logFile, sync: true }));

let turn = 0;
const sent: { turn: number; to: string; content: unknown; at: string }[] = [];
const recordSend = async (to: string, content: unknown) => {
  const summary =
    content && typeof content === 'object' && 'image' in content
      ? { ...content, image: `<${(content as { image: Buffer }).image?.length ?? 0} bytes>` }
      : content;
  sent.push({ turn, to, content: summary, at: new Date().toISOString() });
  return undefined;
};
const sock = {
  sendMessage: recordSend,
  readMessages: async () => {},
  updateMediaMessage: async () => {
    throw new Error('verify harness: no media re-upload');
  },
  logger,
};

const runner = createAgentRunnerClient({
  baseUrl: process.env.AGENT_RUNNER_URL?.trim() || 'http://127.0.0.1:3790',
});
const forwarded: { text: string; replyTo: string }[] = [];
const agentRunner = {
  status: () => runner.status(),
  sendCommand: async (req: { text: string; replyTo: string }) => {
    forwarded.push(req);
    return '[verify] not forwarded to agent-runner';
  },
  missedReport: async () => '[verify] missed report not read',
};

const handler = createBaileysMessageHandler({
  sock,
  commands,
  createPorts: () =>
    createProductionPorts({
      sock: sock as unknown as Parameters<typeof createProductionPorts>[0]['sock'],
      downloadMediaMessage: (async () => {
        throw new Error('verify harness: images are not supported');
      }) as unknown as Parameters<typeof createProductionPorts>[0]['downloadMediaMessage'],
      logger,
      commands,
      secondPhone: process.env.SECOND_PHONE,
      isAllowedActor,
      agentRunner,
    }),
});

let error: string | null = null;
try {
  // whatsapp.ts loads the Hue light list (read-only GETs) before the socket opens; the lights agent needs it.
  await initializeLightCache();
  for (const text of texts) {
    turn += 1;
    const message = {
      key: { id: `VERIFY${Date.now()}${turn}`, remoteJid: chatId, participant: actorId, fromMe: false },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
    await handler.handleUpsert({ messages: [message], type: 'notify' });
  }
} catch (err) {
  error = (err as Error).stack ?? String(err);
}

const evidence = {
  input: { texts, as: values.as, actorId, chatId },
  startedAt: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  sent,
  forwardedToAgentRunner: forwarded,
  error,
  log: logFile,
};
const evidenceFile = path.join(outDir, `${stamp}.json`);
writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));

texts.forEach((text, i) => {
  console.log(`[${i + 1}] ${text}`);
  const replies = sent.filter((s) => s.turn === i + 1);
  for (const s of replies) {
    const c = s.content as { text?: string };
    console.log(`→ ${s.to}\n${typeof c?.text === 'string' ? c.text : JSON.stringify(c)}\n`);
  }
  if (!replies.length) console.log('(no reply sent)\n');
});
if (error) console.log(`harness error:\n${error}`);
console.log(`evidence: ${path.relative(repo, evidenceFile)}`);
process.exit(error ? 1 : 0);
