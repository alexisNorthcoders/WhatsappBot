import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteIntent } from '../whatsapp/orchestration/createProductionPorts.ts';
import type { FetchLike } from '../whatsapp/types.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function service(answers: Record<string, unknown>) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => ({ answers }) } as never;
  };
  return { requests, fetch };
}

describe('router service (ROUTER_SERVICE_URL)', () => {
  const env = {
    ROUTER_SERVICE_URL: 'http://minipc.local:4000/v1/systemone',
    ROUTER_SERVICE_API_KEY: 'k',
    LOCAL_ROUTER_BASE_URL: 'http://minipc.local:4000/v1',
    TYPESAFE_API_KEY: 'jev',
  };

  it('sends the Jev-shaped request to the service, with its key and model name, ahead of the local router and Jev', async () => {
    const { requests, fetch } = service({
      route: { type: 'choice', choice: 'lights', probabilities: { lights: 0.97, chat: 0.03 } },
      lights_action: { type: 'choice', choice: 'off', probabilities: { off: 1 } },
    });
    const route = createRouteIntent(logger, env, fetch);
    assert.ok(route);
    const r = await route('hall light off please');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://minipc.local:4000/v1/systemone');
    assert.equal(requests[0].headers.Authorization, 'Bearer k');
    assert.equal(requests[0].body.model, 'whatsapp-router');
    assert.equal(requests[0].body.state.message, 'hall light off please');
    assert.ok(requests[0].body.questions.route.criteria.lights);
    assert.equal(r?.agent, 'lights');
    assert.equal(r?.answers.lights_action.choice, 'off');
  });

  it('keeps the bot cutoff: an unsure route goes to chat', async () => {
    const { fetch } = service({ route: { type: 'choice', choice: 'home', probabilities: { home: 0.4 } } });
    const r = await createRouteIntent(logger, env, fetch)!('why is my boiler noisy');
    assert.equal(r?.agent, 'chat');
  });

  it('falls back to the keyword gates (null) when the service fails', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal(await createRouteIntent(logger, env, fetch)!('hi'), null);
  });

  it('is unused without ROUTER_SERVICE_URL', () => {
    const { fetch } = service({});
    assert.equal(createRouteIntent(logger, {}, fetch), undefined);
  });
});
