/**
 * Shared guardrails for accepting user-provided URLs and fetching them in-process (SSRF reduction).
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const DEFAULT_BOT_FETCH_TIMEOUT_MS = 45_000;
export const DEFAULT_BOT_FETCH_MAX_REDIRECTS = 10;
/** Hard cap on response body bytes after redirects (separate from character truncation of decoded text). */
export const DEFAULT_BOT_FETCH_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

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
  };
}

function isBlockedIPv4Octets(a, b) {
  if (a === 10) return true;
  if (a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** @param {string} host lowercased, dotted IPv4 or null */
function isBlockedIPv4Literal(host) {
  if (!host) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const nums = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
  if (nums.some((n) => n > 255 || !Number.isFinite(n))) return false;
  return isBlockedIPv4Octets(nums[0], nums[1]);
}

/** @param {string} tail IPv4-mapped tail after the `::ffff:` prefix */
function ipv4MappedTailToOctets(tail) {
  const t = tail.toLowerCase();
  if (t.includes('.')) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
    if (!m) return null;
    const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    return nums.every((n) => n <= 255 && Number.isFinite(n)) ? nums : null;
  }
  const parts = t.split(':').filter(Boolean);
  if (parts.length === 2) {
    const hi = parseInt(parts[0], 16);
    const lo = parseInt(parts[1], 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  if (parts.length === 1) {
    const v = parseInt(parts[0], 16);
    if (!Number.isFinite(v) || v > 0xffffffff) return null;
    return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }
  return null;
}

/**
 * @param {string} host from URL.hostname (may include brackets for IPv6)
 */
function isBlockedIPv6Literal(host) {
  const raw = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') return true;
  if (raw.startsWith('fe80:')) return true;
  if (/^f[cd][0-9a-f]{0,3}:/i.test(raw)) return true;
  const v4m = /^::ffff:(.+)$/i.exec(raw);
  if (v4m) {
    const octets = ipv4MappedTailToOctets(v4m[1]);
    if (octets) {
      return isBlockedIPv4Octets(octets[0], octets[1]);
    }
  }
  return false;
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
  if (host === '::1' || isBlockedIPv6Literal(host)) return false;
  if (isBlockedIPv4Literal(host)) return false;
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
  const init = baseInit ? { ...baseInit, redirect: 'manual' } : buildBotFetchRequestInit();

  let current = url;
  let redirects = 0;

  for (;;) {
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
 * Enforce Content-Length and post-read byte cap, then return ArrayBuffer.
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
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(`Response body too large (${buf.byteLength} bytes, limit ${maxBytes})`);
  }
  return buf;
}
