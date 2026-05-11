import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  botFetch,
  buildBotFetchRequestInit,
  getBotFetchTimeoutMs,
  isUrlAllowedForFetch,
  readResponseBodyBuffer,
} from '../whatsapp/utils/urlFetchSafety.js';

describe('isUrlAllowedForFetch', () => {
  it('allows public https URLs', () => {
    assert.equal(isUrlAllowedForFetch('https://example.com/path?q=1'), true);
    assert.equal(isUrlAllowedForFetch('http://8.8.8.8/'), true);
  });

  it('denies non-http(s) schemes', () => {
    assert.equal(isUrlAllowedForFetch('file:///etc/passwd'), false);
    assert.equal(isUrlAllowedForFetch('ftp://example.com/'), false);
    assert.equal(isUrlAllowedForFetch('javascript:alert(1)'), false);
  });

  it('denies credentials in URL', () => {
    assert.equal(isUrlAllowedForFetch('https://user:pass@example.com/'), false);
    assert.equal(isUrlAllowedForFetch('http://user@example.com/'), false);
  });

  it('denies localhost and obvious local hostnames', () => {
    assert.equal(isUrlAllowedForFetch('http://localhost/'), false);
    assert.equal(isUrlAllowedForFetch('http://api.localhost/'), false);
    assert.equal(isUrlAllowedForFetch('http://mybox.local/'), false);
  });

  it('denies private and loopback IPv4 literals', () => {
    assert.equal(isUrlAllowedForFetch('http://127.0.0.1/'), false);
    assert.equal(isUrlAllowedForFetch('http://10.0.0.1/'), false);
    assert.equal(isUrlAllowedForFetch('http://192.168.1.2/'), false);
    assert.equal(isUrlAllowedForFetch('http://172.17.0.1/'), false);
    assert.equal(isUrlAllowedForFetch('http://169.254.1.1/'), false);
    assert.equal(isUrlAllowedForFetch('http://0.0.0.0/'), false);
  });

  it('denies IPv6 loopback, ULA, link-local, and IPv4-mapped private', () => {
    assert.equal(isUrlAllowedForFetch('http://[::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fe80::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fc00::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fd12:3456::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[::ffff:192.168.0.1]/'), false);
  });

  it('rejects malformed URLs', () => {
    assert.equal(isUrlAllowedForFetch('not a url'), false);
    assert.equal(isUrlAllowedForFetch(''), false);
  });
});

describe('getBotFetchTimeoutMs (env)', () => {
  const prev = process.env.BOT_FETCH_TIMEOUT_MS;

  afterEach(() => {
    if (prev === undefined) delete process.env.BOT_FETCH_TIMEOUT_MS;
    else process.env.BOT_FETCH_TIMEOUT_MS = prev;
  });

  it('reads BOT_FETCH_TIMEOUT_MS when set', () => {
    process.env.BOT_FETCH_TIMEOUT_MS = '12345';
    assert.equal(getBotFetchTimeoutMs(), 12345);
  });
});

describe('readResponseBodyBuffer', () => {
  it('throws when Content-Length exceeds cap', async () => {
    const res = new Response('', {
      headers: { 'content-length': String(50 * 1024 * 1024) },
    });
    await assert.rejects(() => readResponseBodyBuffer(res, 1024), /too large/);
  });

  it('returns buffer when within cap', async () => {
    const res = new Response('hello', {
      headers: { 'content-length': '5' },
    });
    const buf = await readResponseBodyBuffer(res, 1024);
    assert.equal(new TextDecoder().decode(buf), 'hello');
  });
});

describe('buildBotFetchRequestInit', () => {
  it('sets manual redirect and User-Agent', () => {
    const init = buildBotFetchRequestInit({
      userAgent: 'TestUA/1',
    });
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    assert.equal(init.headers['User-Agent'], 'TestUA/1');
    assert.ok(String(init.headers.Accept).includes('text/html'));
  });
});

describe('botFetch redirect validation', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects redirect to disallowed host', async () => {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/secret' },
      });

    await assert.rejects(
      () => botFetch('https://example.com/start', buildBotFetchRequestInit()),
      /not allowed|Redirect target/i,
    );
  });

  it('follows allowed redirect then returns final response', async () => {
    let n = 0;
    globalThis.fetch = async (url) => {
      n += 1;
      if (n === 1) {
        assert.equal(String(url), 'https://example.com/a');
        return new Response(null, {
          status: 302,
          headers: { Location: '/b' },
        });
      }
      assert.equal(String(url), 'https://example.com/b');
      return new Response('done', { status: 200 });
    };

    const res = await botFetch('https://example.com/a', buildBotFetchRequestInit());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'done');
  });
});
