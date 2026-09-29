import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJevRouter, ROUTE_CHAT } from '../whatsapp/orchestration/jevRouter.js';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.js';

const quietLogger = { info() {}, warn() {}, error() {} };

function jevAnswer(choice, probability) {
  return async () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { route: { type: 'choice', choice, probabilities: { [choice]: probability }, confidence: probability } },
      }),
      { status: 200 },
    );
}

describe('createJevRouter', () => {
  it('sends a Choice question over the agents with the bearer key', async () => {
    let sent;
    const route = createJevRouter({
      apiKey: 'k',
      logger: quietLogger,
      fetch: async (url, init) => {
        sent = { url, init, body: JSON.parse(init.body) };
        return jevAnswer('lights', 0.9)();
      },
    });
    const r = await route('turn off the bedroom lights');
    assert.equal(r.agent, 'lights');
    assert.equal(r.probability, 0.9);
    assert.equal(r.answers.route.choice, 'lights');
    assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(sent.init.headers.Authorization, 'Bearer k');
    assert.equal(sent.body.model, 'jev-latest');
    assert.deepEqual(sent.body.state, { message: 'turn off the bedroom lights' });
    assert.equal(sent.body.questions.route.type, 'choice');
    assert.ok(ROUTE_CHAT in sent.body.questions.route.criteria);
  });

  it('only offers the given agents, plus chat', async () => {
    let criteria;
    const route = createJevRouter({
      apiKey: 'k',
      agents: ['lights'],
      logger: quietLogger,
      fetch: async (_url, init) => {
        criteria = JSON.parse(init.body).questions.route.criteria;
        return jevAnswer('lights', 0.9)();
      },
    });
    await route('lights off');
    assert.deepEqual(Object.keys(criteria).sort(), ['chat', 'lights']);
  });

  it('routes to chat when the chosen agent is below the probability threshold', async () => {
    const route = createJevRouter({ apiKey: 'k', minProbability: 0.6, logger: quietLogger, fetch: jevAnswer('weather', 0.55) });
    const r = await route('is it nice out');
    assert.equal(r.agent, ROUTE_CHAT);
    assert.equal(r.probability, 0.55);
  });

  it('asks the extra questions in the same request', async () => {
    let questions;
    const route = createJevRouter({
      apiKey: 'k',
      logger: quietLogger,
      extraQuestions: () => ({ lights_action: { type: 'choice', instructions: 'x', criteria: { on: null } } }),
      fetch: async (_url, init) => {
        questions = JSON.parse(init.body).questions;
        return jevAnswer('lights', 0.9)();
      },
    });
    await route('lights on');
    assert.deepEqual(Object.keys(questions).sort(), ['lights_action', 'route']);
  });

  it('returns null on HTTP errors, network errors and unexpected answers', async () => {
    const cases = [
      async () => new Response('{}', { status: 529 }),
      async () => {
        throw new Error('ECONNRESET');
      },
      jevAnswer('not_an_agent', 0.9),
    ];
    for (const fetch of cases) {
      const route = createJevRouter({ apiKey: 'k', logger: quietLogger, fetch });
      assert.equal(await route('hi'), null);
    }
  });
});

describe('runAgentsChainSequential with routeIntent', () => {
  function chainDeps(overrides = {}) {
    const calls = [];
    const sent = [];
    const agent = (name, reply = `${name} reply`) => ({
      [`shouldTry${name}Agent`]: () => {
        calls.push(`gate:${name}`);
        return true;
      },
      [`run${name}Agent`]: async () => {
        calls.push(`run:${name}`);
        return reply;
      },
      [`${name.toUpperCase()}_AGENT_SKIP`]: 'SKIP',
    });
    return {
      calls,
      sent,
      deps: {
        logger: quietLogger,
        messaging: { sendText: async (_chatId, text) => sent.push(text) },
        chatMemory: { append: async () => {} },
        ...agent('Lights'),
        ...agent('Weather'),
        ...agent('Joplin'),
        ...agent('Email'),
        ...overrides,
      },
    };
  }
  const m = { chatId: 'c', text: 'is it cold out' };

  it('runs only the agent Jev picked, skipping the keyword gates', async () => {
    const { deps, calls, sent } = chainDeps({ routeIntent: async () => ({ agent: 'weather', probability: 0.9 }) });
    assert.deepEqual(await runAgentsChainSequential(m, deps), { handled: true });
    assert.deepEqual(calls, ['run:Weather']);
    assert.deepEqual(sent, ['Weather reply']);
  });

  it('leaves chat routes unhandled without running any agent', async () => {
    const { deps, calls } = chainDeps({ routeIntent: async () => ({ agent: 'chat', probability: 0.8 }) });
    assert.deepEqual(await runAgentsChainSequential(m, deps), { handled: false });
    assert.deepEqual(calls, []);
  });

  it('falls through to chat when the picked agent says SKIP', async () => {
    const { deps, calls } = chainDeps({
      routeIntent: async () => ({ agent: 'lights', probability: 0.9 }),
      runLightsAgent: async () => 'SKIP',
    });
    assert.deepEqual(await runAgentsChainSequential(m, deps), { handled: false });
    assert.deepEqual(calls, []);
  });

  it('answers a lights route from the Jev answers when the fast path handles it', async () => {
    const answers = { lights_action: { choice: 'off' } };
    let got;
    const { deps, calls, sent } = chainDeps({
      routeIntent: async () => ({ agent: 'lights', probability: 0.9, answers }),
      runLightsFromJev: async (text, a) => {
        got = { text, a };
        return 'Turned off the Bedroom lights.';
      },
    });
    assert.deepEqual(await runAgentsChainSequential(m, deps), { handled: true });
    assert.deepEqual(got, { text: m.text, a: answers });
    assert.deepEqual(calls, []);
    assert.deepEqual(sent, ['Turned off the Bedroom lights.']);
  });

  it('hands a lights route to the GPT agent when the fast path declines', async () => {
    const { deps, calls } = chainDeps({
      routeIntent: async () => ({ agent: 'lights', probability: 0.9, answers: {} }),
      runLightsFromJev: async () => null,
    });
    assert.deepEqual(await runAgentsChainSequential(m, deps), { handled: true });
    assert.deepEqual(calls, ['run:Lights']);
  });

  it('uses the keyword gates when Jev is unavailable', async () => {
    const { deps, calls } = chainDeps({ routeIntent: async () => null });
    assert.deepEqual(await runAgentsChainSequential(m, deps), { handled: true });
    assert.deepEqual(calls, ['gate:Lights', 'run:Lights']);
  });
});
