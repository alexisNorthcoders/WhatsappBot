import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJevRouter, ROUTE_CHAT } from '../whatsapp/orchestration/jevRouter.ts';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.ts';
import type { AgentChainDeps } from '../whatsapp/orchestration/agentsTryHandle.ts';
import type { FetchLike } from '../whatsapp/types.ts';
import { fakeInbound } from './helpers/fakeInbound.ts';

const quietLogger = { info() {}, warn() {}, error() {} };

type JevRequest = {
  url: string;
  headers: Record<string, string>;
  body: { model: string; state: unknown; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
};

function jevAnswer(choice: string, probability: number) {
  return async () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { route: { type: 'choice', choice, probabilities: { [choice]: probability }, confidence: probability } },
      }),
      { status: 200 },
    );
}

/** A fetch that records each Jev request and answers `lights` at 0.9. */
function capturing() {
  const requests: JevRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return jevAnswer('lights', 0.9)();
  };
  return { requests, fetch };
}

describe('createJevRouter', () => {
  it('sends a Choice question over the agents with the bearer key', async () => {
    const { requests, fetch } = capturing();
    const route = createJevRouter({ apiKey: 'k', logger: quietLogger, fetch });
    const r = await route('turn off the bedroom lights');
    assert.ok(r);
    assert.equal(r.agent, 'lights');
    assert.equal(r.probability, 0.9);
    assert.equal(r.answers.route.choice, 'lights');
    const [sent] = requests;
    assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(sent.headers.Authorization, 'Bearer k');
    assert.equal(sent.body.model, 'jev-latest');
    assert.deepEqual(sent.body.state, { message: 'turn off the bedroom lights' });
    assert.equal(sent.body.questions.route.type, 'choice');
    assert.ok(ROUTE_CHAT in sent.body.questions.route.criteria);
  });

  it('only offers the given agents, plus chat', async () => {
    const { requests, fetch } = capturing();
    const route = createJevRouter({ apiKey: 'k', agents: ['lights'], logger: quietLogger, fetch });
    await route('lights off');
    assert.deepEqual(Object.keys(requests[0].body.questions.route.criteria).sort(), ['chat', 'lights']);
  });

  it('routes to chat when the chosen agent is below the probability threshold', async () => {
    const route = createJevRouter({ apiKey: 'k', minProbability: 0.6, logger: quietLogger, fetch: jevAnswer('weather', 0.55) });
    const r = await route('is it nice out');
    assert.ok(r);
    assert.equal(r.agent, ROUTE_CHAT);
    assert.equal(r.probability, 0.55);
  });

  it('asks the extra questions in the same request', async () => {
    const { requests, fetch } = capturing();
    const route = createJevRouter({
      apiKey: 'k',
      logger: quietLogger,
      extraQuestions: () => ({ lights_action: { type: 'choice', instructions: 'x', criteria: { on: null } } }),
      fetch,
    });
    await route('lights on');
    assert.deepEqual(Object.keys(requests[0].body.questions).sort(), ['lights_action', 'route']);
  });

  it('returns null on HTTP errors, network errors and unexpected answers', async () => {
    const cases: FetchLike[] = [
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
  function chainDeps(overrides: Partial<AgentChainDeps> = {}) {
    const calls: string[] = [];
    const sent: string[] = [];
    const gate = (name: string) => () => {
      calls.push(`gate:${name}`);
      return true;
    };
    const run = (name: string) => async () => {
      calls.push(`run:${name}`);
      return `${name} reply`;
    };
    const deps: AgentChainDeps = {
      logger: quietLogger,
      messaging: { sendText: async (_chatId, text) => sent.push(text) },
      chatMemory: { append: async () => {} },
      shouldTryLightsAgent: gate('Lights'),
      runLightsAgent: run('Lights'),
      LIGHTS_AGENT_SKIP: 'SKIP',
      shouldTryWeatherAgent: gate('Weather'),
      runWeatherAgent: run('Weather'),
      WEATHER_AGENT_SKIP: 'SKIP',
      shouldTryJoplinAgent: gate('Joplin'),
      runJoplinAgent: run('Joplin'),
      JOPLIN_AGENT_SKIP: 'SKIP',
      shouldTryEmailAgent: gate('Email'),
      runEmailAgent: run('Email'),
      EMAIL_AGENT_SKIP: 'SKIP',
      ...overrides,
    };
    return { calls, sent, deps };
  }
  const m = fakeInbound({ chatId: 'c', text: 'is it cold out' });

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
    let got: { text: string; a: Record<string, unknown> } | undefined;
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
