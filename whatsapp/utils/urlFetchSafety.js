/**
 * Shared guardrails for accepting user-provided URLs and fetching them in-process (SSRF reduction).
 */

import net from 'node:net';
import ipaddr from 'ipaddr.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const kBotFetchTimeoutMs = Symbol('botFetchTimeoutMs');
const kBotFetchUserSignal = Symbol('botFetchUserSignal');

export const DEFAULT_BOT_FETCH_TIMEOUT_MS = 45_000;
export const DEFAULT_BOT_FETCH_MAX_REDIRECTS = 10;
/** Hard cap on response body bytes after redirects (separate from character truncation of decoded text). */
export const DEFAULT_BOT_FETCH_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
/** Default cap on UTF-8 decoded characters passed to callers (e.g. Joplin note body). */
export const DEFAULT_BOT_FETCH_MAX_HTML_CHARS = 500_000;

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getBotFetchTimeoutMs() {
  return Math.min(
    parsePositiveInt(process.env.BOT_FETCH_TIMEOUT_MS, DEFAULT_BOT_FETCH_TIMEOUT_MS),
    600_000,
  );
}

export function getBotFetchMaxRedirects() {
  return Math.min(
    parsePositiveInt(process.env.BOT_FETCH_MAX_REDIRECTS, DEFAULT_BOT_FETCH_MAX_REDIRECTS),
    20,
  );
}

export function getBotFetchMaxResponseBytes() {
  return Math.min(
    parsePositiveInt(process.env.BOT_FETCH_MAX_RESPONSE_BYTES, DEFAULT_BOT_FETCH_MAX_RESPONSE_BYTES),
    64 * 1024 * 1024,
  );
}

/**
 * Max characters after UTF-8 decoding for HTML/text bodies (Joplin fetch and similar).
 * Env: `JOPLIN_FETCH_MAX_HTML_CHARS` — same variable name as historically used by the agent.
 */
export function getBotFetchMaxHtmlChars() {
  const n = parseInt(
    process.env.JOPLIN_FETCH_MAX_HTML_CHARS || String(DEFAULT_BOT_FETCH_MAX_HTML_CHARS),
    10,
  );
  return Number.isFinite(n) && n > 0
    ? Math.min(n, 2_000_000)
    : DEFAULT_BOT_FETCH_MAX_HTML_CHARS;
}

/**
 * Default numeric limits for bot HTTP fetches (timeouts, redirects, raw body size).
 */
export function getBotFetchLimits() {
  return {
    timeoutMs: getBotFetchTimeoutMs(),
    maxRedirects: getBotFetchMaxRedirects(),
    maxResponseBytes: getBotFetchMaxResponseBytes(),
  };
}

export const DEFAULT_BOT_FETCH_ACCEPT =
  'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8';

/**
 * @param {object} [opts]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.accept]
 * @param {AbortSignal} [opts.signal] Combined with timeout via AbortSignal.any when available.
 */
export function buildBotFetchSignal(timeoutMs, userSignal) {
  const t = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return t;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([t, userSignal]);
  }
  return t;
}

/**
 * Request init for a single hop (caller follows redirects). Uses `redirect: 'manual'`.
 * @param {object} [opts]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.accept]
 * @param {Record<string, string>} [opts.headers] Merged over Accept and User-Agent if those keys omitted.
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 */
export function buildBotFetchRequestInit(opts = {}) {
  const limits = getBotFetchLimits();
  const timeoutMs = opts.timeoutMs ?? limits.timeoutMs;
  const ua = opts.userAgent ?? 'WhatsappBot/1.0';
  const accept = opts.accept ?? DEFAULT_BOT_FETCH_ACCEPT;
  const headers = { Accept: accept, 'User-Agent': ua, ...opts.headers };
  return {
    redirect: 'manual',
    signal: buildBotFetchSignal(timeoutMs, opts.signal),
    headers,
    [kBotFetchTimeoutMs]: timeoutMs,
    [kBotFetchUserSignal]: opts.signal,
  };
}

/**
 * @param {string} host from URL.hostname (brackets already stripped by URL parser for IPv6)
 */
function isBlockedIPAddressLiteral(host) {
  const raw = (host || '').replace(/^\[|\]$/g, '');
  if (net.isIP(raw) === 0) return false;
  try {
    const addr = ipaddr.parse(raw);
    if (addr.kind() === 'ipv4') {
      return addr.range() !== 'unicast';
    }
    if (addr.isIPv4MappedAddress()) {
      return isBlockedIPAddressLiteral(addr.toIPv4Address().toString());
    }
    return addr.range() !== 'unicast';
  } catch {
    return true;
  }
}

function cloneRequestInitForHop(baseInit) {
  const limits = getBotFetchLimits();
  const timeoutMs = baseInit[kBotFetchTimeoutMs] ?? limits.timeoutMs;
  const userSignal = Object.hasOwn(baseInit, kBotFetchUserSignal)
    ? baseInit[kBotFetchUserSignal]
    : baseInit.signal;
  const {
    signal: _s,
    redirect: _r,
    [kBotFetchTimeoutMs]: _t,
    [kBotFetchUserSignal]: _u,
    ...rest
  } = baseInit;
  return {
    ...rest,
    redirect: 'manual',
    signal: buildBotFetchSignal(timeoutMs, userSignal),
  };
}

/**
 * `true` if the URL may be fetched (http/https only, no creds in URL, no obvious private/local hosts).
 * @param {string} urlStr
 */
export function isUrlAllowedForFetch(urlStr) {
  let u;
  try {
    u = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || isBlockedIPAddressLiteral(host)) return false;
  return true;
}

/**
 * Follow redirects manually so every hop is re-checked against {@link isUrlAllowedForFetch}.
 * @param {string} url
 * @param {RequestInit} [baseInit] Usually from {@link buildBotFetchRequestInit}; must use redirect 'manual' or be omitted.
 */
export async function botFetch(url, baseInit) {
  const limits = getBotFetchLimits();
  if (!isUrlAllowedForFetch(url)) {
    throw new Error('URL is not allowed for fetch (only public http(s); blocked: localhost, private ranges, credentials in URL)');
  }
  const template = baseInit ? { ...baseInit, redirect: 'manual' } : buildBotFetchRequestInit();

  let current = url;
  let redirects = 0;

  for (;;) {
    const init = cloneRequestInitForHop(template);
    const res = await fetch(current, init);
    if (REDIRECT_STATUSES.has(res.status)) {
      if (redirects >= limits.maxRedirects) {
        throw new Error(`Too many redirects (limit ${limits.maxRedirects})`);
      }
      const loc = res.headers.get('location');
      if (!loc || !loc.trim()) {
        throw new Error('Redirect response missing Location header');
      }
      redirects += 1;
      let next;
      try {
        next = new URL(loc.trim(), current).href;
      } catch {
        throw new Error('Invalid redirect Location URL');
      }
      if (!isUrlAllowedForFetch(next)) {
        throw new Error('Redirect target is not allowed');
      }
      current = next;
      continue;
    }
    return res;
  }
}

/**
 * Enforce Content-Length and streamed byte cap, then return ArrayBuffer.
 * @param {Response} res
 */
export async function readResponseBodyBuffer(res, maxBytes = getBotFetchMaxResponseBytes()) {
  const cl = res.headers.get('content-length');
  if (cl != null && cl !== '') {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Response body too large (${n} bytes, limit ${maxBytes})`);
    }
  }
  if (!res.body) {
    return new ArrayBuffer(0);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body too large (${total} bytes, limit ${maxBytes})`);
      }
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
