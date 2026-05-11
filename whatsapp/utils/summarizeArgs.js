/** Usage line sent when parsing fails (0 or multiple URLs, missing args). */
export const SUMMARIZE_USAGE =
  'Usage: *summarize*|*summarise* <url> [optional extra instructions]';

const CMD_RE = /^summari(ze|se)\b\s*(.*)$/is;

/**
 * Strip common trailing punctuation from a URL token matched inside user text.
 * @param {string} raw
 */
export function normalizeUrlToken(raw) {
  return raw.replace(/[.,;:!?)\]]+$/u, '');
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/gi;

/**
 * @param {string} s
 * @returns {string[]}
 */
export function findHttpUrlsInString(s) {
  const matches = s.match(URL_IN_TEXT_RE);
  if (!matches) return [];
  return matches.map(normalizeUrlToken);
}

/**
 * @param {string} fullText full WhatsApp message (starts with summarize / summarise)
 * @returns {{ ok: true, url: string, extra: string } | { ok: false, error: string }}
 */
export function parseSummarizeMessage(fullText) {
  const m = String(fullText || '').match(CMD_RE);
  if (!m) {
    return { ok: false, error: SUMMARIZE_USAGE };
  }
  const remainder = (m[2] || '').trim();
  if (!remainder) {
    return { ok: false, error: SUMMARIZE_USAGE };
  }
  const urlMatches = [...remainder.matchAll(URL_IN_TEXT_RE)];
  if (urlMatches.length === 0) {
    return {
      ok: false,
      error: `${SUMMARIZE_USAGE}\n\nNo URL found. Include one https://… or http://… link.`,
    };
  }
  if (urlMatches.length > 1) {
    return {
      ok: false,
      error: `${SUMMARIZE_USAGE}\n\nOnly one URL is allowed per request.`,
    };
  }
  const rawToken = urlMatches[0][0];
  const idx = urlMatches[0].index ?? 0;
  const url = normalizeUrlToken(rawToken);
  const extra = (remainder.slice(0, idx) + remainder.slice(idx + rawToken.length))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[—\-–:]\s*/, '')
    .trim();
  if (findHttpUrlsInString(extra).length > 0) {
    return {
      ok: false,
      error: `${SUMMARIZE_USAGE}\n\nOnly one URL is allowed per request.`,
    };
  }
  return { ok: true, url, extra };
}
