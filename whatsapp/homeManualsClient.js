/**
 * Thin client for the home-manuals service (`POST /ask` -> { answer, sources }).
 * Unlike whatsapp/utils/urlFetchSafety.js, this targets a trusted local service
 * (HOME_MANUALS_URL, e.g. http://127.0.0.1:3100) so the public-URL SSRF guardrails
 * (which block localhost/private ranges) do not apply here.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} question
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] Defaults to process.env.HOME_MANUALS_URL
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<
 *   | { ok: true, answer: string, sources: Array<object|string> }
 *   | { ok: false, reason: 'not_configured' }
 *   | { ok: false, reason: 'error', error: Error }
 * >}
 */
export async function askHomeManuals(question, opts = {}) {
  const baseUrl = opts.baseUrl ?? process.env.HOME_MANUALS_URL;
  if (!baseUrl || !baseUrl.trim()) {
    return { ok: false, reason: 'not_configured' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/ask`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e : new Error(String(e)) };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: 'error',
      error: new Error(`home-manuals service returned HTTP ${res.status}`),
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e : new Error(String(e)) };
  }

  return {
    ok: true,
    answer: typeof data?.answer === 'string' ? data.answer : '',
    sources: Array.isArray(data?.sources) ? data.sources : [],
  };
}
