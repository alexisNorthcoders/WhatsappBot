/** Usage line sent when parsing fails (0 or multiple URLs, missing args). */
export const SUMMARIZE_USAGE =
  'Usage: *summarize* <https://…> [optional extra instructions]\n(Same with *summarise*.)';

const SUMMARIZE_PREFIX_RE = /^summari(ze|se)\b/iu;
const CMD_RE = /^summari(ze|se)\b\s*(.*)$/isu;

/** Word-boundary anchored http(s) token; excludes spaces and likely surrounding punctuation. */
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<'"()\[\]<>{}]+/giu;

/**
 * True when the trimmed message begins with summarize / summarise (command routing gate).
 * @param {string} fullText
 */
export function messageStartsWithSummarizeCommand(fullText) {
  return SUMMARIZE_PREFIX_RE.test(String(fullText ?? '').trimStart());
}

/**
 * Strip common trailing punctuation from a URL token matched inside user text.
 * @param {string} raw
 */
export function normalizeUrlToken(raw) {
  return raw.replace(/[.,;:!?)\]'"\u2019\u201D\]}>]+$/u, '');
}

/**
 * Strip one layer of brackets/quotes commonly wrapped around pasted URLs.
 * @param {string} raw
 */
export function unwrapUrlDecorators(raw) {
  let t = String(raw || '').trim();
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/^\(([\s\S]*)\)$/u, '$1')
      .replace(/^[[<{]([\s\S]*)[\]}>]$/u, '$1')
      .replace(/^["'\u201C\u201D]([\s\S]*)["'\u201C\u201D]$/u, '$1')
      .trim();
    if (next === t) break;
    t = next;
  }
  return normalizeUrlToken(t);
}

/**
 * Reject typo tokens like `https://ex am...` where the regex clipped a bogus host.
 * @param {URL} u
 */
function hostLooksPlausibleForSummarize(u) {
  const h = u.hostname.toLowerCase();
  if (!h) return false;
  if (h.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return h.includes('.');
}

/**
 * @param {string} token
 * @returns {string | null} normalized http(s) href or null if invalid
 */
export function parseValidHttpUrlToken(token) {
  const cleaned = unwrapUrlDecorators(token);
  if (!cleaned) return null;
  try {
    const u = new URL(cleaned);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!hostLooksPlausibleForSummarize(u)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * @param {string} extra
 */
function cleanSummarizeExtra(extra) {
  let t = extra.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 6; i++) {
    const n = t
      .replace(/\(\s*\)/g, '')
      .replace(/\[\s*\]/g, '')
      .replace(/<\s*>/g, '')
      .trim();
    if (n === t) break;
    t = n;
  }
  return t.replace(/^[—\-–:]\s*/, '').trim();
}

/**
 * @param {string} s
 * @returns {string[]}
 */
export function findHttpUrlsInString(s) {
  const str = String(s || '');
  const out = [];
  let m;
  const re = new RegExp(URL_IN_TEXT_RE.source, URL_IN_TEXT_RE.flags);
  while ((m = re.exec(str)) !== null) {
    const href = parseValidHttpUrlToken(m[0]);
    if (href) out.push(href);
  }
  return out;
}

/**
 * List valid http(s) URLs in order of appearance with match indices for splitting "extra".
 * @param {string} s
 * @returns {Array<{ href: string; index: number; rawLength: number }>}
 */
export function findValidatedHttpUrlOccurrences(s) {
  const str = String(s || '');
  const out = [];
  let m;
  const re = new RegExp(URL_IN_TEXT_RE.source, URL_IN_TEXT_RE.flags);
  while ((m = re.exec(str)) !== null) {
    const href = parseValidHttpUrlToken(m[0]);
    if (!href) continue;
    out.push({ href, index: m.index, rawLength: m[0].length });
  }
  return out;
}

/**
 * @param {string} fullText full WhatsApp message (must start with summarize / summarise)
 * @returns {{ ok: true, url: string, extra: string } | { ok: false, error: string }}
 */
export function parseSummarizeMessage(fullText) {
  const trimmed = String(fullText ?? '').trimStart();
  const m = trimmed.match(CMD_RE);
  if (!m) {
    return { ok: false, error: SUMMARIZE_USAGE };
  }
  const remainder = (m[2] || '').trim();
  if (!remainder) {
    return { ok: false, error: SUMMARIZE_USAGE };
  }
  const occurrences = findValidatedHttpUrlOccurrences(remainder);
  if (occurrences.length === 0) {
    return {
      ok: false,
      error: `${SUMMARIZE_USAGE}\n\nNo URL found. Include one https://… or http://… link.`,
    };
  }
  if (occurrences.length > 1) {
    return {
      ok: false,
      error: `${SUMMARIZE_USAGE}\n\nOnly one URL is allowed per request.`,
    };
  }
  const { href: url, index: idx, rawLength } = occurrences[0];
  const extra = cleanSummarizeExtra(
    remainder.slice(0, idx) + remainder.slice(idx + rawLength),
  );
  if (findHttpUrlsInString(extra).length > 0) {
    return {
      ok: false,
      error: `${SUMMARIZE_USAGE}\n\nOnly one URL is allowed per request.`,
    };
  }
  return { ok: true, url, extra };
}
