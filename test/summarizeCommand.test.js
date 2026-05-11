import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  findHttpUrlsInString,
  normalizeUrlToken,
  parseSummarizeMessage,
  parseValidHttpUrlToken,
  messageStartsWithSummarizeCommand,
} from '../whatsapp/utils/summarizeArgs.js';
import { isHtmlLikeResponse } from '../whatsapp/utils/htmlResponse.js';
import { extractArticleTextFromHtml } from '../whatsapp/utils/articleExtract.js';
import summarizeCommand from '../whatsapp/commands/summarize.js';
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

describe('parseValidHttpUrlToken', () => {
  it('unwraps parentheses and quotes', () => {
    assert.equal(parseValidHttpUrlToken('(https://example.com/a)'), 'https://example.com/a');
    assert.equal(
      parseValidHttpUrlToken('"https://example.com/b/"'),
      'https://example.com/b/',
    );
  });

  it('accepts percent-encoded paths', () => {
    const u = parseValidHttpUrlToken('https://example.com/a%20b/c');
    assert.equal(u, 'https://example.com/a%20b/c');
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

  it('ignores tokens that are not valid URLs', () => {
    assert.deepEqual(findHttpUrlsInString('https://ex am ple.com'), []);
  });
});

describe('messageStartsWithSummarizeCommand', () => {
  it('is true only when the message leads with the command', () => {
    assert.equal(messageStartsWithSummarizeCommand('summarize https://x.test/'), true);
    assert.equal(messageStartsWithSummarizeCommand('Summarise https://x.test/'), true);
    assert.equal(
      messageStartsWithSummarizeCommand('please summarize https://x.test/'),
      false,
    );
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

  it('fails when summarize is not at the start', () => {
    const r = parseSummarizeMessage('foo summarize https://ex.test/x');
    assert.equal(r.ok, false);
  });

  it('parses parenthesized URL and trailing instructions', () => {
    const r = parseSummarizeMessage(
      'summarize (https://ex.test/story) please focus on risks',
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.url, 'https://ex.test/story');
      assert.equal(r.extra, 'please focus on risks');
    }
  });

  it('extracts URL before instructions when URL is last', () => {
    const r = parseSummarizeMessage(
      'summarize quick read https://ex.test/z only key numbers',
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.url, 'https://ex.test/z');
      assert.equal(r.extra, 'quick read only key numbers');
    }
  });

  it('fails with usage when no URL', () => {
    const r = parseSummarizeMessage('summarize just text');
    assert.equal(r.ok, false);
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

  it('rejects JSON content type even if body looks like HTML', () => {
    assert.equal(isHtmlLikeResponse('application/json', '<!DOCTYPE html><html>'), false);
  });

  it('rejects declared text/plain even if body contains angle brackets', () => {
    assert.equal(
      isHtmlLikeResponse('text/plain; charset=utf-8', '<!DOCTYPE html><html></html>'),
      false,
    );
  });

  it('rejects RSS / Atom shapes', () => {
    const rss = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>';
    assert.equal(isHtmlLikeResponse('', rss), false);
    assert.equal(isHtmlLikeResponse('application/rss+xml', rss), false);
    assert.equal(isHtmlLikeResponse('application/atom+xml', '<feed></feed>'), false);
  });

  it('allows XHTML served as application/xml when a document appears', () => {
    const xhtml =
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hi</p></body></html>';
    assert.equal(isHtmlLikeResponse('application/xml', xhtml), true);
  });

  it('sniffs doctype only when content-type is vague', () => {
    assert.equal(isHtmlLikeResponse('', '<!DOCTYPE html><html></html>'), true);
    assert.equal(isHtmlLikeResponse('application/octet-stream', '<!DOCTYPE html><html></html>'), true);
  });

  it('does not treat bare text or random XML as HTML when Content-Type is missing', () => {
    assert.equal(isHtmlLikeResponse('', 'Hello world'), false);
    assert.equal(isHtmlLikeResponse('', '<div>no document element</div>'), false);
    assert.equal(
      isHtmlLikeResponse('', '<?xml version="1.0"?><thing><item/></thing>'),
      false,
    );
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

  it('throws on navigation-only fixture', () => {
    const html = readFileSync(path.join(fixturesDir, 'nav-only.html'), 'utf8');
    assert.throws(
      () => extractArticleTextFromHtml(html, 'https://example.com/'),
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

describe('summarizeCommand fetch path (mocked global fetch)', () => {
  const chat = '111@s.whatsapp.net';
  let previousFetch;

  beforeEach(() => {
    previousFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  async function captureMessages(text, fetchImpl) {
    globalThis.fetch = fetchImpl;
    const sent = [];
    const sock = {
      sendMessage: async (to, payload) => {
        assert.equal(to, chat);
        sent.push(payload.text);
      },
    };
    await summarizeCommand(sock, chat, text);
    return sent;
  }

  it('reports non-OK HTTP status', async () => {
    const messages = await captureMessages('summarize https://example.com/page', async () =>
      new Response('', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/html' },
      }),
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Fetch failed: HTTP 502/);
    assert.match(messages[0], /example\.com\/page/);
  });

  it('rejects non-HTML responses', async () => {
    const messages = await captureMessages('summarize https://example.com/api', async () =>
      new Response('not a web page', {
        status: 200,
        headers: { 'content-type': 'text/plain;charset=utf-8' },
      }),
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0], /only supports HTML/i);
  });
});
