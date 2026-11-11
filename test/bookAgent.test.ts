import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldTryBookAgent,
  runBookAgent,
  BOOK_AGENT_SKIP,
  BOOK_RECS_UNAVAILABLE,
} from '../whatsapp/agents/bookAgent.ts';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.ts';
import type { AgentChainDeps } from '../whatsapp/orchestration/agentsTryHandle.ts';
import type { Recommendation } from '../whatsapp/books/recommendBooks.ts';
import { fakeInbound } from './helpers/fakeInbound.ts';

const OWNER = '111@s.whatsapp.net';
const STRANGER = '999@s.whatsapp.net';

const inbound = (text: string, actorId = OWNER) => fakeInbound({ text, chatId: actorId, actorId });

const isAllowedActor = (actorId: string | null | undefined) => actorId === OWNER;

function fakeRecommend(result: Recommendation | Error) {
  const calls: string[] = [];
  const recommend = async (question: string) => {
    calls.push(question);
    if (result instanceof Error) throw result;
    return result;
  };
  recommend.calls = calls;
  return recommend;
}

const answer = (text: string): Recommendation => ({ kind: 'answer', text });
const NOT_A_REQUEST: Recommendation = { kind: 'not_a_request' };

describe('shouldTryBookAgent', () => {
  it('matches book-request phrasing', () => {
    for (const text of [
      'something like Mistborn but darker',
      'recommend a book',
      'any good books about WW2?',
      'what should I read next?',
      'finished my book today',
      'looking for a fantasy novel',
      'what to read next',
      'what can I read after Dune',
      'anything to read on holiday?',
      'recommend something to read',
      'something darker like Mistborn',
      'any recommendations for my reading list?',
      'something similar to The Name of the Wind',
    ]) {
      assert.equal(shouldTryBookAgent(text), true, text);
    }
  });

  it('does not match unrelated messages', () => {
    for (const text of [
      'tell me a joke',
      'turn off the lights',
      'will it rain tomorrow',
      'I read your message',
      'recommend a restaurant',
      '',
    ]) {
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
  it("sends the owner's question and returns the recommendation", async () => {
    const text = '1. *The Black Company* by Glen Cook';
    const recommend = fakeRecommend(answer(text));
    const reply = await runBookAgent(inbound('something like Mistborn but darker'), { recommend, isAllowedActor });
    assert.equal(reply, text);
    assert.deepEqual(recommend.calls, ['something like Mistborn but darker']);
  });

  it('skips when the message is not a request', async () => {
    const recommend = fakeRecommend(NOT_A_REQUEST);
    const reply = await runBookAgent(inbound('finished my book today'), { recommend, isAllowedActor });
    assert.equal(reply, BOOK_AGENT_SKIP);
  });

  it('never recommends for a non-owner', async () => {
    const recommend = fakeRecommend(answer('x'));
    const reply = await runBookAgent(inbound('recommend a book', STRANGER), { recommend, isAllowedActor });
    assert.equal(reply, BOOK_AGENT_SKIP);
    assert.equal(recommend.calls.length, 0);
  });

  it('denies when no isAllowedActor is given', async () => {
    const recommend = fakeRecommend(answer('x'));
    const reply = await runBookAgent(inbound('recommend a book'), { recommend });
    assert.equal(reply, BOOK_AGENT_SKIP);
    assert.equal(recommend.calls.length, 0);
  });

  it('skips silently when no catalog is configured', async () => {
    const reply = await runBookAgent(inbound('recommend a book'), { isAllowedActor });
    assert.equal(reply, BOOK_AGENT_SKIP);
  });

  it('replies "unavailable" when recommending fails', async () => {
    const recommend = fakeRecommend(new Error('fetch failed'));
    const reply = await runBookAgent(inbound('recommend a book'), { recommend, isAllowedActor });
    assert.equal(reply, BOOK_RECS_UNAVAILABLE);
  });
});

function chainDeps(overrides: Partial<AgentChainDeps>): AgentChainDeps {
  return {
    logger: { error() {} },
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
    isAllowedActor,
    ...overrides,
  };
}

describe('runAgentsChainSequential book agent wiring', () => {
  it("an owner's book request gets the recommendation", async () => {
    const sent: unknown[] = [];
    const recommend = fakeRecommend(answer('Try *Prince of Thorns*.'));
    const r = await runAgentsChainSequential(
      inbound('something like Mistborn but darker'),
      chainDeps({
        messaging: { sendText: async (chatId, text) => sent.push({ chatId, text }) },
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { recommend, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, true);
    assert.deepEqual(sent, [{ chatId: OWNER, text: 'Try *Prince of Thorns*.' }]);
  });

  it('not_a_request falls through to the normal handlers', async () => {
    const sent: unknown[] = [];
    const recommend = fakeRecommend(NOT_A_REQUEST);
    const r = await runAgentsChainSequential(
      inbound('finished my book today'),
      chainDeps({
        messaging: { sendText: async (chatId, text) => sent.push(text) },
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { recommend, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, false);
    assert.equal(recommend.calls.length, 1);
    assert.deepEqual(sent, []);
  });

  it('a Jev "books" route runs the book agent', async () => {
    const recommend = fakeRecommend(answer('Read *Dune*.'));
    const sent: unknown[] = [];
    const r = await runAgentsChainSequential(
      inbound('what next after the Expanse'),
      chainDeps({
        messaging: { sendText: async (chatId, text) => sent.push(text) },
        routeIntent: async () => ({ agent: 'books', probability: 0.9, answers: {} }),
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { recommend, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, true);
    assert.deepEqual(sent, ['Read *Dune*.']);
  });

  it('a Jev "books" route that is not a request is left for chat', async () => {
    const recommend = fakeRecommend(NOT_A_REQUEST);
    const r = await runAgentsChainSequential(
      inbound('finished my book today'),
      chainDeps({
        routeIntent: async () => ({ agent: 'books', probability: 0.8, answers: {} }),
        shouldTryBookAgent,
        runBookAgent: (m) => runBookAgent(m, { recommend, isAllowedActor }),
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, false);
  });

  it('the chain gates non-owners before the agent runs', async () => {
    let ran = false;
    const r = await runAgentsChainSequential(
      inbound('recommend a book', STRANGER),
      chainDeps({
        shouldTryBookAgent,
        runBookAgent: async () => {
          ran = true;
          return 'x';
        },
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, false);
    assert.equal(ran, false);
  });

  it('without isAllowedActor the book agent is not registered', async () => {
    let ran = false;
    const r = await runAgentsChainSequential(
      inbound('recommend a book'),
      chainDeps({
        isAllowedActor: undefined,
        routeIntent: async () => ({ agent: 'books', probability: 0.9, answers: {} }),
        shouldTryBookAgent,
        runBookAgent: async () => {
          ran = true;
          return 'x';
        },
        BOOK_AGENT_SKIP,
      }),
    );
    assert.equal(r.handled, false);
    assert.equal(ran, false);
  });
});
