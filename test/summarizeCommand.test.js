import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  findHttpUrlsInString,
  normalizeUrlToken,
  parseSummarizeMessage,
  SUMMARIZE_USAGE,
} from '../whatsapp/utils/summarizeArgs.js';
import { isHtmlLikeResponse } from '../whatsapp/utils/htmlResponse.js';
import { extractArticleTextFromHtml } from '../whatsapp/utils/articleExtract.js';
import { DEEPINFRA_DEFAULT_CHAT_MODEL } from '../models/models.js';
import summarizeCommand, {
  SUMMARIZE_ACK,
  SUMMARIZE_BUSY,
  summarizeInjectedDeps,
} from '../whatsapp/commands/summarize.js';
import {
  resetSummarizeLockState,
  tryAcquireSummarizeLock,
  releaseSummarizeLock,
} from '../whatsapp/utils/summarizeLock.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'summarize');

describe('normalizeUrlToken', () => {
  it('strips trailing punctuation from URL token', () => {
    assert.equal(
      normalizeUrlToken('https://example.com/path).'),
      'https://example.com/path',
    );
    assert.equal(normalizeUrlToken('https://example.com/a.'), 'https://example.com/a');
  });
});

describe('findHttpUrlsInString', () => {
  it('finds multiple http(s) URLs', () => {
    const s = 'see https://a.com/x and https://b.com/y';
    assert.deepEqual(findHttpUrlsInString(s), [
      'https://a.com/x',
      'https://b.com/y',
    ]);
  });
});

describe('parseSummarizeMessage', () => {
  it('accepts summarize spelling with one URL', () => {
    const r = parseSummarizeMessage(
      'summarize https://example.com/article focus on dates',
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.url, 'https://example.com/article');
      assert.equal(r.extra, 'focus on dates');
    }
  });

  it('accepts summarise spelling', () => {
    const r = parseSummarizeMessage('summarise https://ex.test/');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.url, 'https://ex.test/');
      assert.equal(r.extra, '');
    }
  });

  it('is case-insensitive on command word', () => {
    const r = parseSummarizeMessage('Summarize https://ex.test/hi');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.url, 'https://ex.test/hi');
  });

  it('fails with usage when no URL', () => {
    const r = parseSummarizeMessage('summarize just text');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes(SUMMARIZE_USAGE));
    }
  });

  it('fails when more than one URL', () => {
    const r = parseSummarizeMessage(
      'summarize https://a.com/one https://b.com/two',
    );
    assert.equal(r.ok, false);
  });

  it('fails when extra text contains another URL', () => {
    const r = parseSummarizeMessage(
      'summarize https://a.com/ also see https://b.com/',
    );
    assert.equal(r.ok, false);
  });

  it('fails on empty payload after command', () => {
    const r = parseSummarizeMessage('summarize');
    assert.equal(r.ok, false);
  });
});

describe('isHtmlLikeResponse', () => {
  it('treats text/html as HTML', () => {
    assert.equal(isHtmlLikeResponse('text/html', 'x'), true);
    assert.equal(isHtmlLikeResponse('Text/HTML; charset=utf-8', ''), true);
  });

  it('rejects JSON content type', () => {
    assert.equal(isHtmlLikeResponse('application/json', '<!DOCTYPE html><html>'), false);
  });

  it('sniffs doctype when content-type is vague', () => {
    assert.equal(isHtmlLikeResponse('', '<!DOCTYPE html><html></html>'), true);
  });
});

describe('extractArticleTextFromHtml (fixtures, no network)', () => {
  it('throws when the page has no meaningful extractable text', () => {
    const html = readFileSync(
      path.join(fixturesDir, 'empty-body.html'),
      'utf8',
    );
    assert.throws(
      () => extractArticleTextFromHtml(html, 'https://example.com/doc'),
      /Could not extract enough readable text/,
    );
  });

  it('extracts long article-like HTML', () => {
    const html = readFileSync(
      path.join(fixturesDir, 'article.html'),
      'utf8',
    );
    const text = extractArticleTextFromHtml(html, 'https://example.com/news/1');
    assert.ok(text.length >= 80);
    assert.match(text, /Pangolin/i);
  });
});

const SENDER = '15551234567@s.whatsapp.net';

const HTML_ONLY_MSG =
  'This command only supports HTML web pages. The response was not HTML (check Content-Type or body).';

/** @param {unknown} line */
function assertSummarizeLogHasNoPageTextLeak(line) {
  const json = JSON.stringify(line);
  assert.match(
    json,
    /"event":"summarize_run"/,
    'expected single structured summarize_run payload',
  );
  assert.ok(
    !json.includes('Pangolin'),
    'log must not include extracted page text',
  );
  assert.ok(json.length < 900, 'log payload should stay small (no bodies or prompts)');
}

describe('summarize command (WhatsApp lock UX)', () => {
  beforeEach(() => {
    resetSummarizeLockState();
  });

  afterEach(() => {
    resetSummarizeLockState();
  });

  it('responds busy when the summarize lock is already held', async () => {
    const lease = tryAcquireSummarizeLock();
    assert.ok(lease);

    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ jid, /** @type {{ text?: string }} */ content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    await summarizeCommand(sock, SENDER, 'summarize https://example.com/news/1');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, SENDER);
    assert.equal(sent[0].text, SUMMARIZE_BUSY);

    releaseSummarizeLock(lease.leaseId);
  });

  it('sends acknowledgement then the model reply on the happy path', async () => {
    const articleHtml = readFileSync(path.join(fixturesDir, 'article.html'), 'utf8');

    /**
     * @type {typeof import('../whatsapp/utils/urlFetchSafety.js').botFetch}
     */
    async function fakeBotFetch(_url, _init) {
      return new Response(articleHtml, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    /**
     * @type {typeof import('../models/models.js').deepInfraAPI}
     */
    async function fakeDeepInfra(_content, _model, _opts) {
      return 'Mocked summary bullets.';
    }

    /** @type {unknown[]} */
    const logPayloads = [];
    const logger = {
      info(/** @type {Record<string, unknown>} */ o) {
        logPayloads.push(o);
      },
    };

    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    await summarizeCommand(
      sock,
      SENDER,
      'summarize https://example.com/news/1 brief',
      summarizeInjectedDeps({
        botFetch: fakeBotFetch,
        deepInfraAPI: fakeDeepInfra,
        logger,
      }),
    );

    assert.deepEqual(
      sent.map((m) => m.text),
      [SUMMARIZE_ACK, 'Mocked summary bullets.'],
    );

    assert.equal(logPayloads.length, 1);
    const line = /** @type {Record<string, unknown>} */ (logPayloads[0]);
    assert.equal(line.event, 'summarize_run');
    assert.equal(line.host, 'example.com');
    assert.equal(line.httpStatus, 200);
    assert.equal(typeof line.extractedLength, 'number');
    assert.ok((/** @type {number} */ (line.extractedLength)) >= 80);
    assert.equal(line.outcome, 'success');
    assert.equal(line.model, DEEPINFRA_DEFAULT_CHAT_MODEL);
    assert.equal(line.provider, 'deepinfra');
    assert.equal(typeof line.durationMs, 'number');
    assert.ok((/** @type {number} */ (line.durationMs)) >= 0);
    assertSummarizeLogHasNoPageTextLeak(line);
  });

  it('emits summarize_run with http_error when the fetch returns non-OK', async () => {
    async function fakeBotFetch404() {
      return new Response('', {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    /** @type {unknown[]} */
    const logPayloads = [];
    const logger = {
      info(/** @type {Record<string, unknown>} */ o) {
        logPayloads.push(o);
      },
    };

    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    await summarizeCommand(
      sock,
      SENDER,
      'summarize https://example.com/missing',
      summarizeInjectedDeps({
        botFetch: fakeBotFetch404,
        logger,
      }),
    );

    assert.ok(sent.length >= 2);
    assert.equal(sent[0].text, SUMMARIZE_ACK);
    assert.match(sent[sent.length - 1].text, /HTTP 404/);

    assert.equal(logPayloads.length, 1);
    const line = /** @type {Record<string, unknown>} */ (logPayloads[0]);
    assert.equal(line.event, 'summarize_run');
    assert.equal(line.host, 'example.com');
    assert.equal(line.httpStatus, 404);
    assert.equal(line.extractedLength, null);
    assert.equal(line.outcome, 'http_error');
    assertSummarizeLogHasNoPageTextLeak(line);
  });

  it('emits summarize_run with fetch_error and null http status when fetch throws', async () => {
    async function fakeBotFetchThrows() {
      throw new Error('network down');
    }

    /** @type {unknown[]} */
    const logPayloads = [];
    const logger = {
      info(/** @type {Record<string, unknown>} */ o) {
        logPayloads.push(o);
      },
    };

    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    await summarizeCommand(
      sock,
      SENDER,
      'summarize https://example.com/news/1',
      summarizeInjectedDeps({ botFetch: fakeBotFetchThrows, logger }),
    );

    assert.match(sent[sent.length - 1].text, /Could not fetch URL/);

    assert.equal(logPayloads.length, 1);
    const line = /** @type {Record<string, unknown>} */ (logPayloads[0]);
    assert.equal(line.event, 'summarize_run');
    assert.equal(line.host, 'example.com');
    assert.equal(line.httpStatus, null);
    assert.equal(line.extractedLength, null);
    assert.equal(line.outcome, 'fetch_error');
    assert.equal(line.model, DEEPINFRA_DEFAULT_CHAT_MODEL);
    assertSummarizeLogHasNoPageTextLeak(line);
  });

  it('emits summarize_run with not_html when the body is not HTML', async () => {
    async function fakeBotFetchJson() {
      return new Response('{"x":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    /** @type {unknown[]} */
    const logPayloads = [];
    const logger = {
      info(/** @type {Record<string, unknown>} */ o) {
        logPayloads.push(o);
      },
    };

    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    await summarizeCommand(
      sock,
      SENDER,
      'summarize https://example.com/data.json',
      summarizeInjectedDeps({ botFetch: fakeBotFetchJson, logger }),
    );

    assert.equal(sent[sent.length - 1].text, HTML_ONLY_MSG);

    assert.equal(logPayloads.length, 1);
    const line = /** @type {Record<string, unknown>} */ (logPayloads[0]);
    assert.equal(line.event, 'summarize_run');
    assert.equal(line.host, 'example.com');
    assert.equal(line.httpStatus, 200);
    assert.equal(line.extractedLength, null);
    assert.equal(line.outcome, 'not_html');
    assert.equal(line.model, DEEPINFRA_DEFAULT_CHAT_MODEL);
    assertSummarizeLogHasNoPageTextLeak(line);
  });

  it('emits summarize_run with llm_error when the model call throws', async () => {
    const articleHtml = readFileSync(path.join(fixturesDir, 'article.html'), 'utf8');

    async function fakeBotFetch() {
      return new Response(articleHtml, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    async function fakeDeepInfraThrows() {
      throw new Error('DeepInfra refused');
    }

    /** @type {unknown[]} */
    const logPayloads = [];
    const logger = {
      info(/** @type {Record<string, unknown>} */ o) {
        logPayloads.push(o);
      },
    };

    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    await summarizeCommand(
      sock,
      SENDER,
      'summarize https://example.com/news/1',
      summarizeInjectedDeps({
        botFetch: fakeBotFetch,
        deepInfraAPI: fakeDeepInfraThrows,
        logger,
      }),
    );

    assert.match(sent[sent.length - 1].text, /Summary request failed/);

    assert.equal(logPayloads.length, 1);
    const line = /** @type {Record<string, unknown>} */ (logPayloads[0]);
    assert.equal(line.event, 'summarize_run');
    assert.equal(line.host, 'example.com');
    assert.equal(line.httpStatus, 200);
    assert.equal(typeof line.extractedLength, 'number');
    assert.ok((/** @type {number} */ (line.extractedLength)) >= 80);
    assert.equal(line.outcome, 'llm_error');
    assert.equal(line.model, DEEPINFRA_DEFAULT_CHAT_MODEL);
    assertSummarizeLogHasNoPageTextLeak(line);
  });
});
