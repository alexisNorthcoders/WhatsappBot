import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProductionPorts } from '../whatsapp/orchestration/createProductionPorts.js';
import { createMessageOrchestrator } from '../whatsapp/orchestration/createMessageOrchestrator.js';
import { normalizeBaileysMessage } from '../whatsapp/orchestration/normalizeBaileysMessage.js';
import { isAllowedActor } from '../whatsapp/whatsAppActorAllowlist.js';

describe('createProductionPorts privileged routes', () => {
  it('denies !restart when isAllowedActor returns false', async () => {
    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, ...content });
      },
      readMessages: async () => {},
      logger: {},
      updateMediaMessage: async () => {},
    };
    const ports = createProductionPorts({
      sock,
      downloadMediaMessage: async () => Buffer.from(''),
      fs: { writeFile: async () => {} },
      logger: { info() {}, warn() {}, error() {} },
      commands: {},
      secondPhone: undefined,
      isAllowedActor: () => false,
    });
    const inbound = {
      id: 'x',
      chatId: '1@s.whatsapp.net',
      actorId: '1@s.whatsapp.net',
      fromMe: false,
      text: '!restart',
      features: { hasImage: false },
      raw: { key: { remoteJid: '1@s.whatsapp.net', participant: null, id: 'x' }, message: {} },
    };
    await ports.routes.runLegacyRoutes(inbound);
    assert.match(sent[0].text, /Not allowed to restart/);
  });

  describe('with the real allowlist and @lid senders', () => {
    const OWNER_LID = '123456789012345@lid';
    let savedPhone;
    before(() => {
      savedPhone = process.env.MY_PHONE;
      process.env.MY_PHONE = '447700900001';
    });
    after(() => {
      if (savedPhone === undefined) delete process.env.MY_PHONE;
      else process.env.MY_PHONE = savedPhone;
    });

    function lidDm(text, remoteJidAlt) {
      return normalizeBaileysMessage({
        key: { id: 'l1', remoteJid: OWNER_LID, fromMe: false, ...(remoteJidAlt ? { remoteJidAlt } : {}) },
        message: { conversation: text },
      });
    }

    function portsWith(commands, sent, agentRunner) {
      return createProductionPorts({
        sock: {
          sendMessage: async (jid, content) => {
            sent.push({ jid, ...content });
          },
        },
        downloadMediaMessage: async () => Buffer.from(''),
        fs: { writeFile: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        commands,
        secondPhone: undefined,
        isAllowedActor,
        agentRunner,
      });
    }

    function runnerRecording(forwarded) {
      return {
        sendCommand: async (req) => {
          forwarded.push(req);
          return 'queued';
        },
        status: async () => ({ busy: false, activeRun: null }),
        missedReport: async () => '',
      };
    }

    it('forwards claude from a LID whose remoteJidAlt is the owner phone to agent-runner', async () => {
      const sent = [];
      const forwarded = [];
      const ports = portsWith({}, sent, runnerRecording(forwarded));
      await createMessageOrchestrator(ports).handleInbound(
        lidDm('claude fix it', '447700900001@s.whatsapp.net'),
      );
      assert.deepEqual(forwarded, [{ text: 'claude fix it', replyTo: OWNER_LID }]);
      assert.equal(sent[0].text, 'queued');
    });

    it('denies claude from a LID with no alternate id without reaching agent-runner', async () => {
      const sent = [];
      const forwarded = [];
      const ports = portsWith({}, sent, runnerRecording(forwarded));
      await createMessageOrchestrator(ports).handleInbound(lidDm('claude fix it'));
      assert.deepEqual(forwarded, []);
      assert.match(sent[0].text, /Not allowed to run the Claude agent/);
    });

    it('denies !restart from a LID with no alternate id', async () => {
      const sent = [];
      const ports = portsWith({}, sent);
      await ports.routes.runLegacyRoutes(lidDm('!restart'));
      assert.match(sent[0].text, /Not allowed to restart/);
    });
  });
});
