import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentRunnerClient,
  AgentRunnerUnreachableError,
} from '../whatsapp/agentRunner/agentRunnerClient.js';

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('agent-runner client', () => {
  it('POSTs {text, replyTo} to /command and returns the reply', async () => {
    const calls = [];
    const client = createAgentRunnerClient({
      baseUrl: 'http://127.0.0.1:3790/',
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, body: JSON.parse(init.body) });
        return jsonResponse(200, { reply: 'Started run r1' });
      },
    });
    assert.equal(await client.sendCommand({ text: 'claude hi', replyTo: 'c@lid' }), 'Started run r1');
    assert.deepEqual(calls, [
      { url: 'http://127.0.0.1:3790/command', method: 'POST', body: { text: 'claude hi', replyTo: 'c@lid' } },
    ]);
  });

  it('passes through the reply of an error response (the runner answered)', async () => {
    const client = createAgentRunnerClient({
      baseUrl: 'http://x',
      fetchImpl: async () => jsonResponse(400, { reply: 'Bad request: nope' }),
    });
    assert.equal(await client.sendCommand({ text: 'claude', replyTo: 'c' }), 'Bad request: nope');
  });

  it('throws AgentRunnerUnreachableError when the connection fails or the answer is not the API', async () => {
    const refused = createAgentRunnerClient({
      baseUrl: 'http://x',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(refused.sendCommand({ text: 'claude', replyTo: 'c' }), AgentRunnerUnreachableError);
    await assert.rejects(refused.status(), AgentRunnerUnreachableError);

    const html = createAgentRunnerClient({
      baseUrl: 'http://x',
      fetchImpl: async () => new Response('<html>', { status: 502 }),
    });
    await assert.rejects(html.sendCommand({ text: 'claude', replyTo: 'c' }), AgentRunnerUnreachableError);
  });

  it('GETs /status', async () => {
    const client = createAgentRunnerClient({
      baseUrl: 'http://x',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'http://x/status');
        assert.equal(init.method, 'GET');
        return jsonResponse(200, { busy: true, activeRun: { runId: 'r9' }, paused: false });
      },
    });
    assert.deepEqual(await client.status(), { busy: true, activeRun: { runId: 'r9' }, paused: false });
  });
});
