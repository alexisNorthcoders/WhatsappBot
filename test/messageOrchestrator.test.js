import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageOrchestrator } from '../whatsapp/orchestration/createMessageOrchestrator.js';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.js';

function fakeInbound(overrides = {}) {
  const base = {
    id: '1',
    chatId: '111@s.whatsapp.net',
    actorId: '111@s.whatsapp.net',
    fromMe: false,
    text: 'hello',
    features: { hasImage: false },
    raw: {
      key: { remoteJid: '111@s.whatsapp.net', id: '1', fromMe: false },
      message: { conversation: 'hello' },
    },
  };
  return { ...base, ...overrides, features: { ...base.features, ...overrides.features } };
}

function noopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function basePorts(overrides = {}) {
  const { __log: logOpt, ...rest } = overrides;
  const log = logOpt ?? [];
  return {
    receipts: { markRead: async () => {} },
    messaging: {
      sendText: async (chatId, text) => {
        log.push({ op: 'sendText', chatId, text });
      },
      sendPoll: async () => {
        log.push({ op: 'sendPoll' });
      },
      sendImage: async () => {
        log.push({ op: 'sendImage' });
      },
    },
    media: {
      downloadImageBuffer: async () => {
        log.push({ op: 'downloadImage' });
        return Buffer.from('x');
      },
    },
    buttonSink: {
      writeButton: async (b) => {
        log.push({ op: 'button', b });
      },
    },
    chatMemory: {
      get: async () => [],
      append: async (chatId, role, content) => {
        log.push({ op: 'append', chatId, role, content });
      },
      clear: async () => 0,
    },
    ai: {
      visionText: async () => {
        log.push({ op: 'visionText' });
        return 'vt';
      },
      visionTextHigh: async () => {
        log.push({ op: 'visionTextHigh' });
        return 'vth';
      },
      visionHelp: async () => {
        log.push({ op: 'visionHelp' });
        return 'vh';
      },
      assistant: async (t) => {
        log.push({ op: 'assistant', t });
        return 'ai-reply';
      },
    },
    routes: {
      runSpritePlus: async () => ({ handled: false }),
      runCommandByFirstToken: async () => ({ handled: false }),
      runLegacyRoutes: async () => ({ handled: false }),
    },
    agents: {
      tryHandle: async () => ({ handled: false }),
    },
    logger: noopLogger(),
    buttons: { labels: ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'] },
    ...rest,
    __log: log,
  };
}

describe('createMessageOrchestrator', () => {
  it('routes sprite+ before command registry (sprite+ wins)', async () => {
    const log = [];
    const ports = basePorts({
      __log: log,
      routes: {
        async runSpritePlus(m) {
          log.push('sprite');
          assert.match(m.text, /sprite\+/i);
          return { handled: true };
        },
        async runCommandByFirstToken() {
          log.push('cmd');
          return { handled: true };
        },
        async runLegacyRoutes() {
          log.push('legacy');
          return { handled: false };
        },
      },
    });
    const { handleInbound } = createMessageOrchestrator(ports);
    await handleInbound(fakeInbound({ text: 'sprite+ go' }));
    assert.deepEqual(log, ['sprite']);
  });

  it('image branch is exclusive: command registry is not run for image messages', async () => {
    const log = [];
    const ports = basePorts({
      __log: log,
      routes: {
        async runSpritePlus() {
          log.push('sprite');
          return { handled: false };
        },
        async runCommandByFirstToken() {
          log.push('cmd');
          return { handled: true };
        },
        async runLegacyRoutes() {
          log.push('legacy');
          return { handled: false };
        },
      },
    });
    const { handleInbound } = createMessageOrchestrator(ports);
    const inbound = fakeInbound({
      text: 'gpt4 do work',
      features: { hasImage: true },
      raw: {
        key: { remoteJid: '111@s.whatsapp.net', id: '1', fromMe: false },
        message: {
          imageMessage: { caption: 'gpt4 do work' },
        },
      },
    });
    await handleInbound(inbound);
    assert(log.some((e) => e.op === 'downloadImage'), 'should download image');
    assert(!log.includes('cmd'), 'command registry must not run');
    assert(!log.includes('sprite'), 'sprite must not run');
  });

  it('image caption Text high uses visionTextHigh before visionText', async () => {
    const log = [];
    const ports = basePorts({ __log: log });
    const { handleInbound } = createMessageOrchestrator(ports);
    await handleInbound(
      fakeInbound({
        text: 'Text high please',
        features: { hasImage: true },
        raw: {
          key: { remoteJid: '111@s.whatsapp.net', id: '1', fromMe: false },
          message: { imageMessage: { caption: 'Text high please' } },
        },
      }),
    );
    assert.deepEqual(
      log.filter((x) => typeof x === 'object' && x.op).map((x) => x.op),
      ['downloadImage', 'visionTextHigh', 'sendText'],
    );
  });

  it('image caption Help uses visionHelp', async () => {
    const log = [];
    const ports = basePorts({ __log: log });
    const { handleInbound } = createMessageOrchestrator(ports);
    await handleInbound(
      fakeInbound({
        text: 'Help me',
        features: { hasImage: true },
        raw: {
          key: { remoteJid: '111@s.whatsapp.net', id: '1', fromMe: false },
          message: { imageMessage: { caption: 'Help me' } },
        },
      }),
    );
    assert(log.some((e) => e.op === 'visionHelp'));
  });

  it('writes button then falls through to assistant when nothing else handles', async () => {
    const log = [];
    const ports = basePorts({ __log: log });
    const { handleInbound } = createMessageOrchestrator(ports);
    await handleInbound(fakeInbound({ text: 'a', raw: { key: {}, message: { conversation: 'a' } } }));
    const ops = log.filter((x) => typeof x === 'object' && x.op).map((x) => x.op);
    assert(ops.includes('button'));
    assert(ops.includes('assistant'));
  });

  it('command registry runs before agents when command handles', async () => {
    const log = [];
    const ports = basePorts({
      __log: log,
      routes: {
        async runSpritePlus() {
          return { handled: false };
        },
        async runCommandByFirstToken() {
          log.push('cmd');
          return { handled: true };
        },
        async runLegacyRoutes() {
          return { handled: false };
        },
      },
      agents: {
        tryHandle: async () => {
          log.push('agents');
          return { handled: false };
        },
      },
    });
    const { handleInbound } = createMessageOrchestrator(ports);
    await handleInbound(fakeInbound({ text: 'noop' }));
    assert.deepEqual(log, ['cmd']);
  });

  it('fallback assistant appends user then assistant', async () => {
    const log = [];
    const ports = basePorts({ __log: log });
    const { handleInbound } = createMessageOrchestrator(ports);
    await handleInbound(fakeInbound({ text: 'hi bot' }));
    const appends = log.filter((x) => x.op === 'append');
    assert.equal(appends[0].role, 'user');
    assert.equal(appends[0].content, 'hi bot');
    assert.equal(appends[1].role, 'assistant');
    assert.equal(appends[1].content, 'ai-reply');
  });
});

describe('runAgentsChainSequential', () => {
  it('SKIP from lights falls through to weather when weather handles', async () => {
    const log = [];
    const messaging = {
      sendText: async (chatId, text) => {
        log.push({ chatId, text });
      },
    };
    const chatMemory = {
      append: async (chatId, role, content) => {
        log.push({ append: [chatId, role, content] });
      },
    };
    const r = await runAgentsChainSequential(fakeInbound({ text: 'any' }), {
      logger: noopLogger(),
      messaging,
      chatMemory,
      shouldTryLightsAgent: () => true,
      runLightsAgent: async () => 'SKIP',
      LIGHTS_AGENT_SKIP: 'SKIP',
      shouldTryWeatherAgent: () => true,
      runWeatherAgent: async () => 'rainy',
      WEATHER_AGENT_SKIP: 'SKIP',
      shouldTryJoplinAgent: () => false,
      runJoplinAgent: async () => 'SKIP',
      JOPLIN_AGENT_SKIP: 'SKIP',
      shouldTryEmailAgent: () => false,
      runEmailAgent: async () => 'SKIP',
      EMAIL_AGENT_SKIP: 'SKIP',
    });
    assert.equal(r.handled, true);
    assert.equal(log[0].text, 'rainy');
  });
});
