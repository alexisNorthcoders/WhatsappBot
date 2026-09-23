import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askHomeManuals } from '../whatsapp/homeManualsClient.js';

describe('askHomeManuals', () => {
  let prevUrl;

  beforeEach(() => {
    prevUrl = process.env.HOME_MANUALS_URL;
    delete process.env.HOME_MANUALS_URL;
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.HOME_MANUALS_URL;
    else process.env.HOME_MANUALS_URL = prevUrl;
  });

  it('returns not_configured when HOME_MANUALS_URL is unset and no baseUrl given', async () => {
    const result = await askHomeManuals('what boiler do we have?');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');
  });

  it('POSTs { question } to baseUrl/ask and returns { answer, sources }', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answer: 'It is a Worcester Bosch Greenstar.',
          sources: [{ item: 'Boiler', manual: 'Worcester Bosch Manual', page: 4 }],
        }),
      };
    };

    const result = await askHomeManuals('what boiler do we have?', {
      baseUrl: 'http://127.0.0.1:3100',
      fetchImpl,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:3100/ask');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), { question: 'what boiler do we have?' });

    assert.equal(result.ok, true);
    assert.equal(result.answer, 'It is a Worcester Bosch Greenstar.');
    assert.deepEqual(result.sources, [{ item: 'Boiler', manual: 'Worcester Bosch Manual', page: 4 }]);
  });

  it('strips a trailing slash from baseUrl before appending /ask', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ answer: 'ok', sources: [] }) };
    };
    await askHomeManuals('q', { baseUrl: 'http://127.0.0.1:3100/', fetchImpl });
    assert.equal(calls[0], 'http://127.0.0.1:3100/ask');
  });

  it('returns ok:false reason:error on non-OK HTTP status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await askHomeManuals('q', { baseUrl: 'http://127.0.0.1:3100', fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.match(result.error.message, /500/);
  });

  it('returns ok:false reason:error when fetch throws (service unreachable)', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await askHomeManuals('q', { baseUrl: 'http://127.0.0.1:3100', fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.match(result.error.message, /ECONNREFUSED/);
  });

  it('defaults sources to [] when missing from the response', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ answer: 'ok' }) });
    const result = await askHomeManuals('q', { baseUrl: 'http://127.0.0.1:3100', fetchImpl });
    assert.equal(result.ok, true);
    assert.deepEqual(result.sources, []);
  });
});
