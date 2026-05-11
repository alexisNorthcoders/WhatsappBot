import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

/** Enough characters for Readability output to count as usable article text. */
const MIN_READABILITY_CHARS = 120;
/** Lower bar for tag-stripped body text fallback. */
const MIN_FALLBACK_CHARS = 80;

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
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
  if (fromReader.length >= MIN_READABILITY_CHARS) {
    return fromReader;
  }

  const dom2 = new JSDOM(html, { url: documentUrl });
  const fallback = normalizeWhitespace(fallbackPlainText(dom2.window.document));
  if (fallback.length >= MIN_FALLBACK_CHARS) {
    return fallback;
  }

  throw new Error(
    'Could not extract enough readable text from this page (empty or navigation-only HTML).',
  );
}
