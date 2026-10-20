import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { createProductionPorts } from '../whatsapp/orchestration/createProductionPorts.ts';
import type { ProductionPortsDeps } from '../whatsapp/orchestration/createProductionPorts.ts';
import type { OrchestratorPorts } from '../whatsapp/orchestration/createMessageOrchestrator.ts';
import { createMessageOrchestrator } from '../whatsapp/orchestration/createMessageOrchestrator.ts';
import { normalizeBaileysMessage } from '../whatsapp/orchestration/normalizeBaileysMessage.ts';
import { isAllowedActor } from '../whatsapp/whatsAppActorAllowlist.ts';

type RunnerCommand = Parameters<OrchestratorPorts['agentRunner']['sendCommand']>[0];

const quiet = { info() {}, warn() {}, error() {} };
const noMedia = async () => Buffer.from('');

function textRecorder() {
  const texts: string[] = [];
  const sock: ProductionPortsDeps['sock'] = {
    sendMessage: async (_jid: string, content: AnyMessageContent) => {
      if ('text' in content && content.text != null) texts.push(String(content.text));
      return undefined;
    },
    readMessages: async () => {},
    logger: pino({ level: 'silent' }),
    updateMediaMessage: async (m) => m,
  };
  return { texts, sock };
}

function runnerRecording(forwarded: RunnerCommand[]): OrchestratorPorts['agentRunner'] {
  return {
    sendCommand: async (req) => {
      forwarded.push(req);
      return 'queued';
    },
    status: async () => ({ busy: false, activeRun: null }),
    missedReport: async () => '',
  };
}

describe('createProductionPorts privileged routes', () => {
  it('refuses to build ports without an isAllowedActor gate', () => {
    assert.throws(
      () =>
        // @ts-expect-error the type requires the gate too
        createProductionPorts({
          sock: textRecorder().sock,
          downloadMediaMessage: noMedia,
          logger: quiet,
          commands: {},
          secondPhone: undefined,
        }),
      /isAllowedActor is required/,
    );
  });

  it('denies !restart when isAllowedActor returns false', async () => {
    const { texts, sock } = textRecorder();
    const ports = createProductionPorts({
      sock,
      downloadMediaMessage: noMedia,
      logger: quiet,
      commands: {},
      secondPhone: undefined,
      isAllowedActor: () => false,
      agentRunner: runnerRecording([]),
    });
    const inbound = {
      id: 'x',
      chatId: '1@s.whatsapp.net',
      actorId: '1@s.whatsapp.net',
      actorAltId: null,
      fromMe: false,
      text: '!restart',
      features: { hasImage: false },
      raw: { key: { remoteJid: '1@s.whatsapp.net', participant: null, id: 'x' }, message: {} },
    };
    await ports.routes.runLegacyRoutes(inbound);
    assert.match(texts[0], /Not allowed to restart/);
  });

  describe('with the real allowlist and @lid senders', () => {
    const OWNER_LID = '123456789012345@lid';
    let savedPhone: string | undefined;
    before(() => {
      savedPhone = process.env.MY_PHONE;
      process.env.MY_PHONE = '447700900001';
    });
    after(() => {
      if (savedPhone === undefined) delete process.env.MY_PHONE;
      else process.env.MY_PHONE = savedPhone;
    });

    function lidDm(text: string, remoteJidAlt?: string) {
      return normalizeBaileysMessage({
        key: { id: 'l1', remoteJid: OWNER_LID, fromMe: false, ...(remoteJidAlt ? { remoteJidAlt } : {}) },
        message: { conversation: text },
      });
    }

    function portsWith(agentRunner = runnerRecording([])) {
      const { texts, sock } = textRecorder();
      const ports = createProductionPorts({
        sock,
        downloadMediaMessage: noMedia,
        logger: quiet,
        commands: {},
        secondPhone: undefined,
        isAllowedActor,
        agentRunner,
      });
      return { texts, ports };
    }

    it('forwards claude from a LID whose remoteJidAlt is the owner phone to agent-runner', async () => {
      const forwarded: RunnerCommand[] = [];
      const { texts, ports } = portsWith(runnerRecording(forwarded));
      await createMessageOrchestrator(ports).handleInbound(
        lidDm('claude fix it', '447700900001@s.whatsapp.net'),
      );
      assert.deepEqual(forwarded, [{ text: 'claude fix it', replyTo: OWNER_LID }]);
      assert.equal(texts[0], 'queued');
    });

    it('denies claude from a LID with no alternate id without reaching agent-runner', async () => {
      const forwarded: RunnerCommand[] = [];
      const { texts, ports } = portsWith(runnerRecording(forwarded));
      await createMessageOrchestrator(ports).handleInbound(lidDm('claude fix it'));
      assert.deepEqual(forwarded, []);
      assert.match(texts[0], /Not allowed to run the Claude agent/);
    });

    it('denies !restart from a LID with no alternate id', async () => {
      const { texts, ports } = portsWith();
      await ports.routes.runLegacyRoutes(lidDm('!restart'));
      assert.match(texts[0], /Not allowed to restart/);
    });
  });
});
