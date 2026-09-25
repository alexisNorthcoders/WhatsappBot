import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBaileysMessageHandler } from '../whatsapp/orchestration/createBaileysMessageHandler.js';
import { isAllowedActor } from '../whatsapp/whatsAppActorAllowlist.js';

const OWNER_PN = '447700900001@s.whatsapp.net';
const STRANGER_PN = '447700900999@s.whatsapp.net';

const noop = () => {};

/** Ports where every outbound effect is recorded; the handler only reaches them for allowed senders. */
function recordingPorts(log) {
  const record = (op) => async (...args) => {
    log.push({ op, args });
  };
  return {
    receipts: { markRead: record('markRead') },
    messaging: { sendText: record('sendText'), sendPoll: record('sendPoll'), sendImage: record('sendImage') },
    media: { downloadImageBuffer: async () => Buffer.alloc(0) },
    buttonSink: { writeButton: record('writeButton') },
    chatMemory: { get: async () => [], append: async () => {}, clear: async () => 0 },
    ai: {
      visionText: async () => '',
      visionTextHigh: async () => '',
      visionHelp: async () => '',
      assistant: async () => 'ai-reply',
    },
    routes: {
      runSpritePlus: async () => ({ handled: false }),
      runSdxlPlus: async () => ({ handled: false }),
      runCommandByFirstToken: async () => ({ handled: false }),
      runLegacyRoutes: async () => ({ handled: false }),
    },
    agents: { tryHandle: async () => ({ handled: false }) },
    access: { isAllowedActor },
    agentRunner: {
      sendCommand: async () => assert.fail('agent-runner should not be called'),
      status: async () => ({ busy: false, activeRun: null }),
      missedReport: async () => '',
    },
    logger: { info: noop, warn: noop, error: noop },
    buttons: { labels: [] },
  };
}

function upsertFrom(key, text = 'hello') {
  return { type: 'notify', messages: [{ key: { id: 'm1', fromMe: false, ...key }, message: { conversation: text } }] };
}

describe('createBaileysMessageHandler sender gate', () => {
  const saved = { MY_PHONE: process.env.MY_PHONE, SECOND_PHONE: process.env.SECOND_PHONE, EXTRA: process.env.CLAUDE_AGENT_EXTRA_JIDS };
  function withOwnerEnv(fn) {
    return async () => {
      process.env.MY_PHONE = '447700900001';
      delete process.env.SECOND_PHONE;
      delete process.env.CLAUDE_AGENT_EXTRA_JIDS;
      try {
        await fn();
      } finally {
        for (const [k, v] of [['MY_PHONE', saved.MY_PHONE], ['SECOND_PHONE', saved.SECOND_PHONE], ['CLAUDE_AGENT_EXTRA_JIDS', saved.EXTRA]]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };
  }

  function handlerWith(log, sent) {
    return createBaileysMessageHandler({
      sock: { sendMessage: async (...args) => sent.push(args) },
      commands: {},
      createPorts: () => recordingPorts(log),
    });
  }

  it('replies to the owner', withOwnerEnv(async () => {
    const log = [];
    await handlerWith(log, []).handleUpsert(upsertFrom({ remoteJid: OWNER_PN }));
    assert.deepEqual(log.map((e) => e.op), ['markRead', 'sendText']);
  }));

  it('replies to the owner writing from a LID when the key carries their phone JID', withOwnerEnv(async () => {
    const log = [];
    await handlerWith(log, []).handleUpsert(upsertFrom({ remoteJid: '999999999999999@lid', remoteJidAlt: OWNER_PN }));
    assert.deepEqual(log.map((e) => e.op), ['markRead', 'sendText']);
  }));

  it('ignores a stranger silently: no read receipt, no reply', withOwnerEnv(async () => {
    const log = [];
    const sent = [];
    await handlerWith(log, sent).handleUpsert(upsertFrom({ remoteJid: STRANGER_PN }));
    await handlerWith(log, sent).handleUpsert(upsertFrom({ remoteJid: '888888888888888@lid' }));
    assert.deepEqual(log, []);
    assert.deepEqual(sent, []);
  }));

  it('ignores strangers in a group the owner is in', withOwnerEnv(async () => {
    const log = [];
    await handlerWith(log, []).handleUpsert(upsertFrom({ remoteJid: '1203630@g.us', participant: STRANGER_PN }));
    assert.deepEqual(log, []);
  }));
});
