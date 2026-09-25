import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProductionPorts } from '../whatsapp/orchestration/createProductionPorts.js';
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

    function portsWith(commands, sent) {
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
      });
    }

    it('denies !restart from a LID with no alternate id', async () => {
      const sent = [];
      const ports = portsWith({}, sent);
      await ports.routes.runLegacyRoutes(lidDm('!restart'));
      assert.match(sent[0].text, /Not allowed to restart/);
    });

  });
});
