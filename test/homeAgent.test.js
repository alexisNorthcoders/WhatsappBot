import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTryHomeAgent, runHomeAgent, HOME_AGENT_SKIP } from '../whatsapp/agents/homeAgent.js';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.js';

describe('shouldTryHomeAgent', () => {
  it('matches natural-language home questions from the issue examples', () => {
    assert.equal(shouldTryHomeAgent('what boiler do we have?'), true);
    assert.equal(shouldTryHomeAgent('how do I descale the coffee machine?'), true);
  });

  it('does not match unrelated questions', () => {
    assert.equal(shouldTryHomeAgent('what is the capital of France?'), false);
    assert.equal(shouldTryHomeAgent('tell me a joke'), false);
    assert.equal(shouldTryHomeAgent(''), false);
  });
});

describe('runHomeAgent', () => {
  it('returns the formatted answer with sources when the service answers', async () => {
    const askHomeManuals = async (question) => {
      assert.equal(question, 'what boiler do we have?');
      return {
        ok: true,
        answer: 'A Worcester Bosch Greenstar.',
        sources: [{ item: 'Boiler', manual: 'Boiler Manual', page: 3 }],
      };
    };
    const reply = await runHomeAgent('what boiler do we have?', { askHomeManuals });
    assert.match(reply, /A Worcester Bosch Greenstar\./);
    assert.match(reply, /Sources:/);
    assert.match(reply, /Boiler Manual, p\. 3/);
  });

  it('skips when the service is unreachable/errors', async () => {
    const askHomeManuals = async () => ({ ok: false, reason: 'error', error: new Error('down') });
    const reply = await runHomeAgent('what boiler do we have?', { askHomeManuals });
    assert.equal(reply, HOME_AGENT_SKIP);
  });

  it('skips when not configured', async () => {
    const askHomeManuals = async () => ({ ok: false, reason: 'not_configured' });
    const reply = await runHomeAgent('what boiler do we have?', { askHomeManuals });
    assert.equal(reply, HOME_AGENT_SKIP);
  });

  it('skips on an "I don\'t know" answer with no sources', async () => {
    const askHomeManuals = async () => ({
      ok: true,
      answer: "I don't know based on the manuals I have.",
      sources: [],
    });
    const reply = await runHomeAgent('what boiler do we have?', { askHomeManuals });
    assert.equal(reply, HOME_AGENT_SKIP);
  });

  it('does not skip an "I don\'t know" style answer if sources are present', async () => {
    const askHomeManuals = async () => ({
      ok: true,
      answer: "I don't know the exact model, but here is the relevant manual.",
      sources: [{ item: 'Boiler', manual: 'Boiler Manual' }],
    });
    const reply = await runHomeAgent('what boiler do we have?', { askHomeManuals });
    assert.notEqual(reply, HOME_AGENT_SKIP);
  });
});

function fakeInbound(text) {
  return {
    id: '1',
    chatId: '111@s.whatsapp.net',
    actorId: '111@s.whatsapp.net',
    fromMe: false,
    text,
    features: { hasImage: false },
    raw: { key: { remoteJid: '111@s.whatsapp.net', id: '1', fromMe: false }, message: { conversation: text } },
  };
}

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

describe('runAgentsChainSequential home agent wiring', () => {
  it('a natural-language home question reaches homeAgent and its reply is sent', async () => {
    const log = [];
    const r = await runAgentsChainSequential(fakeInbound('what boiler do we have?'), {
      logger: noopLogger(),
      messaging: { sendText: async (chatId, text) => log.push({ chatId, text }) },
      chatMemory: { append: async () => {} },
      shouldTryLightsAgent: () => false,
      runLightsAgent: async () => 'SKIP',
      LIGHTS_AGENT_SKIP: 'SKIP',
      shouldTryWeatherAgent: () => false,
      runWeatherAgent: async () => 'SKIP',
      WEATHER_AGENT_SKIP: 'SKIP',
      shouldTryJoplinAgent: () => false,
      runJoplinAgent: async () => 'SKIP',
      JOPLIN_AGENT_SKIP: 'SKIP',
      shouldTryEmailAgent: () => false,
      runEmailAgent: async () => 'SKIP',
      EMAIL_AGENT_SKIP: 'SKIP',
      shouldTryHomeAgent,
      runHomeAgent: (text) =>
        runHomeAgent(text, {
          askHomeManuals: async () => ({ ok: true, answer: 'A combi boiler.', sources: [] }),
        }),
      HOME_AGENT_SKIP,
    });
    assert.equal(r.handled, true);
    assert.equal(log[0].text, 'A combi boiler.');
  });

  it('an unrelated question never calls the home service', async () => {
    let homeCalled = false;
    const r = await runAgentsChainSequential(fakeInbound('tell me a joke'), {
      logger: noopLogger(),
      messaging: { sendText: async () => {} },
      chatMemory: { append: async () => {} },
      shouldTryLightsAgent: () => false,
      runLightsAgent: async () => 'SKIP',
      LIGHTS_AGENT_SKIP: 'SKIP',
      shouldTryWeatherAgent: () => false,
      runWeatherAgent: async () => 'SKIP',
      WEATHER_AGENT_SKIP: 'SKIP',
      shouldTryJoplinAgent: () => false,
      runJoplinAgent: async () => 'SKIP',
      JOPLIN_AGENT_SKIP: 'SKIP',
      shouldTryEmailAgent: () => false,
      runEmailAgent: async () => 'SKIP',
      EMAIL_AGENT_SKIP: 'SKIP',
      shouldTryHomeAgent,
      runHomeAgent: async (text) => {
        homeCalled = true;
        return runHomeAgent(text, { askHomeManuals: async () => ({ ok: true, answer: 'x', sources: [] }) });
      },
      HOME_AGENT_SKIP,
    });
    assert.equal(r.handled, false);
    assert.equal(homeCalled, false, 'home service should not be called for unrelated text');
  });
});
