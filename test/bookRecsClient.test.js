import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askBookRecs } from '../whatsapp/bookRecsClient.js';

describe('askBookRecs', () => {
  let prevUrl;

  beforeEach(() => {
    prevUrl = process.env.BOOK_RECS_URL;
    delete process.env.BOOK_RECS_URL;
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.BOOK_RECS_URL;
    else process.env.BOOK_RECS_URL = prevUrl;
  });

  it('returns not_configured without calling fetch when BOOK_RECS_URL is unset', async () => {
    let called = false;
    const result = await askBookRecs('something like Mistborn', {
      fetchImpl: async () => {
        called = true;
      },
    });
    assert.deepEqual(result, { ok: false, reason: 'not_configured' });
    assert.equal(called, false);
  });

  it('POSTs { question } to baseUrl/ask and returns { kind, answer, sources }', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: 'recommendation',
          answer: '*The Black Company* by Glen Cook',
          sources: [{ url: 'https://reddit.com/r/Fantasy/x' }],
        }),
      };
    };

    const result = await askBookRecs('something like Mistborn but darker', {
      baseUrl: 'http://127.0.0.1:3200/',
      fetchImpl,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:3200/ask');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), { question: 'something like Mistborn but darker' });
    assert.ok(calls[0].init.signal, 'request carries a timeout signal');

    assert.deepEqual(result, {
      ok: true,
      kind: 'recommendation',
      answer: '*The Black Company* by Glen Cook',
      sources: [{ url: 'https://reddit.com/r/Fantasy/x' }],
    });
  });

  it('returns reason:error on non-OK HTTP status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await askBookRecs('q', { baseUrl: 'http://127.0.0.1:3200', fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.match(result.error.message, /503/);
  });

  it('returns reason:error when the service is unreachable', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await askBookRecs('q', { baseUrl: 'http://127.0.0.1:3200', fetchImpl });
    assert.equal(result.reason, 'error');
    assert.match(result.error.message, /ECONNREFUSED/);
  });

  it('returns reason:error when the service is slower than the timeout', async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const result = await askBookRecs('q', { baseUrl: 'http://127.0.0.1:3200', fetchImpl, timeoutMs: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
  });

  it('returns reason:error on a non-JSON body', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    const result = await askBookRecs('q', { baseUrl: 'http://127.0.0.1:3200', fetchImpl });
    assert.equal(result.reason, 'error');
  });

  it('defaults missing fields', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const result = await askBookRecs('q', { baseUrl: 'http://127.0.0.1:3200', fetchImpl });
    assert.deepEqual(result, { ok: true, kind: '', answer: '', sources: [] });
  });
});
