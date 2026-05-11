import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  botFetch,
  buildBotFetchRequestInit,
  getBotFetchMaxHtmlChars,
  getBotFetchMaxRedirects,
  getBotFetchMaxResponseBytes,
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
    assert.equal(isUrlAllowedForFetch('http://100.64.0.1/'), false);
  });

  it('denies IPv6 loopback, ULA, link-local, reserved, and IPv4-mapped private', () => {
    assert.equal(isUrlAllowedForFetch('http://[::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[0:0:0:0:0:0:0:1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fe80::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fc00::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fd12:3456::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[::ffff:192.168.0.1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[::ffff:127.0.0.1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[fec0::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[2001:db8::1]/'), false);
    assert.equal(isUrlAllowedForFetch('http://[::]/'), false);
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

describe('getBotFetchMaxRedirects (env)', () => {
  const prev = process.env.BOT_FETCH_MAX_REDIRECTS;

  afterEach(() => {
    if (prev === undefined) delete process.env.BOT_FETCH_MAX_REDIRECTS;
    else process.env.BOT_FETCH_MAX_REDIRECTS = prev;
  });

  it('reads BOT_FETCH_MAX_REDIRECTS when set', () => {
    process.env.BOT_FETCH_MAX_REDIRECTS = '3';
    assert.equal(getBotFetchMaxRedirects(), 3);
  });
});

describe('getBotFetchMaxResponseBytes (env)', () => {
  const prev = process.env.BOT_FETCH_MAX_RESPONSE_BYTES;

  afterEach(() => {
    if (prev === undefined) delete process.env.BOT_FETCH_MAX_RESPONSE_BYTES;
    else process.env.BOT_FETCH_MAX_RESPONSE_BYTES = prev;
  });

  it('reads BOT_FETCH_MAX_RESPONSE_BYTES when set', () => {
    process.env.BOT_FETCH_MAX_RESPONSE_BYTES = '2048';
    assert.equal(getBotFetchMaxResponseBytes(), 2048);
  });
});

describe('getBotFetchMaxHtmlChars (env)', () => {
  const prev = process.env.JOPLIN_FETCH_MAX_HTML_CHARS;

  afterEach(() => {
    if (prev === undefined) delete process.env.JOPLIN_FETCH_MAX_HTML_CHARS;
    else process.env.JOPLIN_FETCH_MAX_HTML_CHARS = prev;
  });

  it('reads JOPLIN_FETCH_MAX_HTML_CHARS when set', () => {
    process.env.JOPLIN_FETCH_MAX_HTML_CHARS = '999';
    assert.equal(getBotFetchMaxHtmlChars(), 999);
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

  it('aborts streaming read when body grows past cap without Content-Length', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('a'.repeat(600)));
        controller.enqueue(enc.encode('b'.repeat(600)));
        controller.close();
      },
    });
    const res = new Response(stream);
    await assert.rejects(() => readResponseBodyBuffer(res, 1000), /too large/);
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
      /Redirect target is not allowed/,
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

  it('throws when redirect limit is exhausted', async () => {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://example.com/next' },
      });

    await assert.rejects(
      () =>
        botFetch('https://example.com/start', buildBotFetchRequestInit({ timeoutMs: 5000 })),
      /Too many redirects/,
    );
  });

  it('throws on empty Location', async () => {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: '   ' },
      });

    await assert.rejects(
      () => botFetch('https://example.com/start', buildBotFetchRequestInit()),
      /missing Location/i,
    );
  });

  it('throws on malformed Location URL', async () => {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://%ZZ' },
      });

    await assert.rejects(
      () => botFetch('https://example.com/start', buildBotFetchRequestInit()),
      /Invalid redirect Location/,
    );
  });

  it('passes a fresh RequestInit (signal) on each redirect hop', async () => {
    const signals = [];
    globalThis.fetch = async (_url, init) => {
      signals.push(init.signal);
      if (signals.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/two' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    await botFetch('https://example.com/one', buildBotFetchRequestInit());
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
  });
});
