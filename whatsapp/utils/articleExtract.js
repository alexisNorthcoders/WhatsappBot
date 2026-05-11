import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

/** Enough characters for Readability output to count as usable article text. */
const MIN_READABILITY_CHARS = 120;
/** Lower bar for tag-stripped body text fallback before semantic checks. */
const MIN_FALLBACK_CHARS = 80;
/** Minimum real body copy (words) before we trust a fallback without multiple paragraphs. */
const MIN_FALLBACK_WORDS = 55;
/** Anchors dominate nav chrome: require a sane text-to-anchor-text ratio when few <p>s exist. */
const MAX_LINK_TEXT_RATIO_FALLBACK = 0.52;
const SUBSTANTIAL_P_LEN = 40;

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  return normalizeWhitespace(text)
    .split(/\s/u)
    .filter((w) => w.length > 0).length;
}

/**
 * @param {import('jsdom').DOMWindow['document']} document
 */
function fallbackPlainText(document) {
  const body = document.body;
  if (!body) return '';
  const clone = /** @type {HTMLElement} */ (body.cloneNode(true));
  for (const sel of ['script', 'style', 'noscript', 'template', 'iframe']) {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  }
  return clone.textContent || '';
}

/**
 * @param {HTMLElement | null} body
 */
function countSubstantialParagraphs(body) {
  if (!body) return 0;
  const ps = body.querySelectorAll('p');
  let n = 0;
  for (let i = 0; i < ps.length; i++) {
    const t = normalizeWhitespace(ps[i].textContent || '');
    if (t.length >= SUBSTANTIAL_P_LEN) n++;
  }
  return n;
}

/**
 * @param {HTMLElement | null} body
 */
function linkTextRatio(body) {
  if (!body) return 0;
  const totalChars = normalizeWhitespace(body.textContent || '').length || 1;
  let linkChars = 0;
  body.querySelectorAll('a').forEach((a) => {
    linkChars += normalizeWhitespace(a.textContent || '').length;
  });
  return linkChars / totalChars;
}

/**
 * Reject navigation-heavy pages where Readability produced a thin string but body copy is mostly links.
 * @param {string} fallback
 * @param {HTMLElement | null} body
 */
function fallbackSemanticOk(fallback, body) {
  const words = wordCount(fallback);
  const paras = countSubstantialParagraphs(body);
  const ratio = linkTextRatio(body);
  if (paras >= 2) return true;
  if (paras >= 1 && ratio <= MAX_LINK_TEXT_RATIO_FALLBACK && words >= MIN_FALLBACK_WORDS) {
    return true;
  }
  if (
    paras === 0 &&
    words >= 90 &&
    ratio <= 0.28 &&
    fallback.length >= MIN_FALLBACK_CHARS
  ) {
    return true;
  }
  return false;
}

/**
 * Readability sometimes returns long strings that are still mostly navigation chrome.
 * @param {HTMLElement | null} body
 * @param {string} extractedText
 */
function readerOutputPlausible(body, extractedText) {
  const paras = countSubstantialParagraphs(body);
  const ratio = linkTextRatio(body);
  const words = wordCount(extractedText);
  if (paras >= 2) return true;
  if (paras >= 1 && ratio <= MAX_LINK_TEXT_RATIO_FALLBACK) return true;
  if (
    paras === 0 &&
    ratio > MAX_LINK_TEXT_RATIO_FALLBACK &&
    words < 220
  ) {
    return false;
  }
  return true;
}

/**
 * Extract main article text using Readability, then a simple DOM fallback.
 * @param {string} html
 * @param {string} documentUrl resolved URL for relative links (Readability)
 */
export function extractArticleTextFromHtml(html, documentUrl) {
  const dom = new JSDOM(html, { url: documentUrl });
  const doc = dom.window.document;
  const reader = new Readability(doc);
  const article = reader.parse();
  let fromReader = '';
  if (article?.textContent) {
    fromReader = normalizeWhitespace(article.textContent);
  }
  if (
    fromReader.length >= MIN_READABILITY_CHARS &&
    readerOutputPlausible(doc.body, fromReader)
  ) {
    return fromReader;
  }

  const dom2 = new JSDOM(html, { url: documentUrl });
  const body = dom2.window.document.body;
  const fallback = normalizeWhitespace(fallbackPlainText(dom2.window.document));
  if (
    fallback.length >= MIN_FALLBACK_CHARS &&
    fallbackSemanticOk(fallback, body)
  ) {
    return fallback;
  }

  throw new Error(
    'Could not extract enough readable text from this page (empty or navigation-only HTML).',
  );
}
