import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProductionPorts } from '../whatsapp/orchestration/createProductionPorts.js';

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

  it('denies cursor command when isAllowedActor returns false', async () => {
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
      commands: { cursor: async () => assert.fail('cursor should not run') },
      secondPhone: undefined,
      isAllowedActor: () => false,
    });
    const inbound = {
      id: 'x',
      chatId: '1@s.whatsapp.net',
      actorId: '1@s.whatsapp.net',
      fromMe: false,
      text: 'cursor fix the bug',
      features: { hasImage: false },
      raw: { key: { remoteJid: '1@s.whatsapp.net', participant: null, id: 'x' }, message: {} },
    };
    const r = await ports.routes.runCommandByFirstToken(inbound);
    assert.equal(r.handled, true);
    assert.match(sent[0].text, /Not allowed to run the Cursor agent/);
  });
});
