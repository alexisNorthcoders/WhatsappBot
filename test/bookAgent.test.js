import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldTryBookAgent,
  runBookAgent,
  BOOK_AGENT_SKIP,
  BOOK_RECS_UNAVAILABLE,
} from '../whatsapp/agents/bookAgent.js';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.js';

const OWNER = '111@s.whatsapp.net';
const STRANGER = '999@s.whatsapp.net';

function fakeInbound(text, actorId = OWNER) {
  return {
    id: '1',
    chatId: actorId,
    actorId,
    actorAltId: null,
    text,
    features: { hasImage: false },
    raw: { key: { remoteJid: actorId, id: '1', fromMe: false }, message: { conversation: text } },
  };
}

const isAllowedActor = (actorId) => actorId === OWNER;

function fakeAsk(result) {
  const calls = [];
  const ask = async (question) => {
    calls.push(question);
    return typeof result === 'function' ? result(question) : result;
  };
  ask.calls = calls;
  return ask;
}

describe('shouldTryBookAgent', () => {
  it('matches book-request phrasing', () => {
    for (const text of [
      'something like Mistborn but darker',
      'recommend a book',
      'any good books about WW2?',
      'what should I read next?',
      'finished my book today',
      'looking for a fantasy novel',
    ]) {
      assert.equal(shouldTryBookAgent(text), true, text);
    }
  });

  it('does not match unrelated messages', () => {
    for (const text of ['tell me a joke', 'turn off the lights', 'will it rain tomorrow', '']) {
      assert.equal(shouldTryBookAgent(text), false, text);
    }
  });

  it('BOOK_AGENT_ALWAYS=1 bypasses the keyword gate', () => {
    const prev = process.env.BOOK_AGENT_ALWAYS;
    process.env.BOOK_AGENT_ALWAYS = '1';
    try {
      assert.equal(shouldTryBookAgent('tell me a joke'), true);
    } finally {
      if (prev === undefined) delete process.env.BOOK_AGENT_ALWAYS;
      else process.env.BOOK_AGENT_ALWAYS = prev;
    }
  });
});

describe('runBookAgent', () => {
  it("sends the owner's question and returns the service's answer as is", async () => {
    const answer = '*The Black Company* — Glen Cook\n_grimdark, mercenaries_';
    const askBookRecs = fakeAsk({ ok: true, kind: 'recommendation', answer, sources: [] });
    const reply = await runBookAgent(fakeInbound('something like Mistborn but darker'), { askBookRecs, isAllowedActor });
    assert.equal(reply, answer);
    assert.deepEqual(askBookRecs.calls, ['something like Mistborn but darker']);
  });

  it('skips when the service says not_a_request', async () => {
    const askBookRecs = fakeAsk({ ok: true, kind: 'not_a_request', answer: '', sources: [] });
    const reply = await runBookAgent(fakeInbound('finished my book today'), { askBookRecs, isAllowedActor });
    assert.equal(reply, BOOK_AGENT_SKIP);
  });

  it('never calls the service for a non-owner', async () => {
    const askBookRecs = fakeAsk({ ok: true, kind: 'recommendation', answer: 'x', sources: [] });
    const reply = await runBookAgent(fakeInbound('recommend a book', STRANGER), { askBookRecs, isAllowedActor });
    assert.equal(reply, BOOK_AGENT_SKIP);
    assert.equal(askBookRecs.calls.length, 0);
  });

  it('denies when no isAllowedActor is given', async () => {
    const askBookRecs = fakeAsk({ ok: true, kind: 'recommendation', answer: 'x', sources: [] });
    const reply = await runBookAgent(fakeInbound('recommend a book'), { askBookRecs });
    assert.equal(reply, BOOK_AGENT_SKIP);
    assert.equal(askBookRecs.calls.length, 0);
  });

  it('skips silently when not configured', async () => {
    const askBookRecs = fakeAsk({ ok: false, reason: 'not_configured' });
    const reply = await runBookAgent(fakeInbound('recommend a book'), { askBookRecs, isAllowedActor });
    assert.equal(reply, BOOK_AGENT_SKIP);
  });

  it('replies "unavailable" when the service errors or times out', async () => {
    const askBookRecs = fakeAsk({ ok: false, reason: 'error', error: new Error('timeout') });
    const reply = await runBookAgent(fakeInbound('recommend a book'), { askBookRecs, isAllowedActor });
    assert.equal(reply, BOOK_RECS_UNAVAILABLE);
  });

  it('replies "unavailable" when the service answers with an empty answer', async () => {
    const askBookRecs = fakeAsk({ ok: true, kind: 'recommendation', answer: '  ', sources: [] });
    const reply = await runBookAgent(fakeInbound('recommend a book'), { askBookRecs, isAllowedActor });
    assert.equal(reply, BOOK_RECS_UNAVAILABLE);
  });
});

function chainDeps(overrides) {
  return {
    logger: { info() {}, warn() {}, error() {} },
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
    ...overrides,
  };
}

describe('runAgentsChainSequential book agent wiring', () => {
  it("an owner's book request gets the service's answer", async () => {
    const sent = [];
    const askBookRecs = fakeAsk({ ok: true, kind: 'recommendation', answer: 'Try *Prince of Thorns*.', sources: [] });
    const r = await runAgentsChainSequential(
      fakeInbound('something like Mistborn but darker'),
      chainDeps({
        messaging: { sendText: async (chatId, text) => sent.push({ chatId, text }) },
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { askBookRecs, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, true);
    assert.deepEqual(sent, [{ chatId: OWNER, text: 'Try *Prince of Thorns*.' }]);
  });

  it('not_a_request falls through to the normal handlers', async () => {
    const sent = [];
    const askBookRecs = fakeAsk({ ok: true, kind: 'not_a_request', answer: '', sources: [] });
    const r = await runAgentsChainSequential(
      fakeInbound('finished my book today'),
      chainDeps({
        messaging: { sendText: async (chatId, text) => sent.push(text) },
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { askBookRecs, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, false);
    assert.equal(askBookRecs.calls.length, 1);
    assert.deepEqual(sent, []);
  });

  it('a Jev "books" route runs the book agent', async () => {
    const askBookRecs = fakeAsk({ ok: true, kind: 'recommendation', answer: 'Read *Dune*.', sources: [] });
    const sent = [];
    const r = await runAgentsChainSequential(
      fakeInbound('what next after the Expanse'),
      chainDeps({
        messaging: { sendText: async (chatId, text) => sent.push(text) },
        routeIntent: async () => ({ agent: 'books', probability: 0.9, answers: {} }),
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { askBookRecs, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, true);
    assert.deepEqual(sent, ['Read *Dune*.']);
  });
});
