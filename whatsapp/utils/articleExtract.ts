import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/** Enough characters for Readability output to count as usable article text. */
const MIN_READABILITY_CHARS = 120;
/** Lower bar for tag-stripped body text fallback. */
const MIN_FALLBACK_CHARS = 80;

function normalizeWhitespace(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackPlainText(document: Document): string {
  const body = document.body;
  if (!body) return '';
  const clone = body.cloneNode(true) as HTMLElement;
  for (const sel of ['script', 'style', 'noscript', 'template', 'iframe']) {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  }
  return clone.textContent || '';
}

/**
 * Extract main article text using Readability, then a simple DOM fallback.
 */
export function extractArticleTextFromHtml(html: string, documentUrl: string): string {
  const globals = { location: { href: documentUrl } };
  const doc = parseHTML(html, globals).document;
  const reader = new Readability(doc);
  const article = reader.parse();
  let fromReader = '';
  if (article?.textContent) {
    fromReader = normalizeWhitespace(article.textContent);
  }
  if (fromReader.length >= MIN_READABILITY_CHARS) {
    return fromReader;
  }

  const fallback = normalizeWhitespace(
    fallbackPlainText(parseHTML(html, globals).document),
  );
  if (fallback.length >= MIN_FALLBACK_CHARS) {
    return fallback;
  }

  throw new Error(
    'Could not extract enough readable text from this page (empty or navigation-only HTML).',
  );
}
