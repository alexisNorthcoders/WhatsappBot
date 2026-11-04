import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJevRouter } from '../whatsapp/orchestration/jevRouter.ts';
import { createLocalRouterFetch } from '../whatsapp/orchestration/localRouter.ts';
import { lightsJevQuestions, runLightsFromJev } from '../whatsapp/agents/lightsJev.ts';
import type { FetchLike } from '../whatsapp/types.ts';

const LIGHTS = [
  { id: '9', name: 'Bedroom', room: 'Bedroom', state: 'ON' },
  { id: '5', name: 'Office', room: 'Office', state: 'OFF' },
  { id: '12', name: 'Desk', room: 'Office', state: 'OFF' },
];
const quiet = { info: () => {}, warn: () => {} };

/** An OpenAI-compatible server that sends back `replies` in order, each its one confident token. */
function fakeServer(replies: string[], status = 200) {
  const requests: { url: string; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    const content = replies[requests.length - 1];
    return {
      ok: status === 200,
      status,
      json: async () => ({
        choices: [{ message: { content }, logprobs: { content: [{ token: content, logprob: 0, top_logprobs: [] }] } }],
      }),
    };
  };
  return { fetch, requests };
}

describe('local router', () => {
  it('routes a lights message and drives the fast path from the model', async () => {
    const server = fakeServer(['lights', '{"action":"off","target":"Bedroom"}']);
    const route = createJevRouter({
      apiKey: '',
      fetch: createLocalRouterFetch({
        baseUrl: 'http://minipc.local:4000/v1',
        apiKey: 'k',
        model: 'qwen3-4b',
        lights: () => LIGHTS,
        fetch: server.fetch,
      }),
      extraQuestions: () => lightsJevQuestions(LIGHTS),
      logger: quiet,
    });

    const r = await route('bedroom light off');
    assert.equal(r?.agent, 'lights');
    const switched: [string, boolean][] = [];
    const reply = await runLightsFromJev('bedroom light off', r!.answers, {
      lights: LIGHTS,
      hue: {
        switchLight: async (id, on) => switched.push([id, on]),
        switchOffAllLights: async () => {},
        setLightBrightness: async () => {},
        setLightColor: async () => {},
        setLightColorTemperature: async () => {},
      },
      logUsage: async () => {},
    });
    assert.deepEqual(switched, [['9', false]]);
    assert.match(String(reply), /Turned off/);

    assert.equal(server.requests.length, 2, 'one route call, one lights call');
    for (const { url, body } of server.requests) {
      assert.equal(url, 'http://minipc.local:4000/v1/chat/completions');
      assert.equal(body.model, 'qwen3-4b');
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    }
  });

  it('asks only the route for a message that is not about the lights', async () => {
    const server = fakeServer(['weather']);
    const route = createJevRouter({
      apiKey: '',
      fetch: createLocalRouterFetch({
        baseUrl: 'http://x/v1',
        apiKey: 'k',
        model: 'qwen3-4b',
        lights: () => LIGHTS,
        fetch: server.fetch,
      }),
      extraQuestions: () => lightsJevQuestions(LIGHTS),
      logger: quiet,
    });
    assert.equal((await route('will it rain tomorrow'))?.agent, 'weather');
    assert.equal(server.requests.length, 1);
  });

  it('returns null when the server fails, so the keyword gates run', async () => {
    const route = createJevRouter({
      apiKey: '',
      fetch: createLocalRouterFetch({
        baseUrl: 'http://x/v1',
        apiKey: 'k',
        model: 'qwen3-4b',
        lights: () => LIGHTS,
        fetch: fakeServer([], 503).fetch,
      }),
      logger: quiet,
    });
    assert.equal(await route('will it rain tomorrow'), null);
  });
});
