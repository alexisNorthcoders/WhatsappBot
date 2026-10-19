/**
 * Thin client for reddit-bot's book recommendation service
 * (`POST /ask {question}` -> { kind, answer, sources }). Like homeManualsClient.ts, this targets
 * a trusted local service (BOOK_RECS_URL), so the public-URL SSRF guard does not apply.
 */

import type { FetchLike } from './types.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param [opts.baseUrl] Defaults to process.env.BOOK_RECS_URL
 */
export async function askBookRecs(question: string, opts: { baseUrl?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<{ ok: true; kind: string; answer: string; sources: Array<object | string> } |
{ ok: false; reason: 'not_configured' } |
{ ok: false; reason: 'timeout'; error: Error } |
{ ok: false; reason: 'error'; error: Error }> {
  const baseUrl = opts.baseUrl ?? process.env.BOOK_RECS_URL;
  if (!baseUrl || !baseUrl.trim()) {
    return { ok: false, reason: 'not_configured' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/ask`;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, reason: 'error', error: new Error(`book recommendation service returned HTTP ${res.status}`) };
    }
    const data = await res.json();
    return {
      ok: true,
      kind: typeof data?.kind === 'string' ? data.kind : '',
      answer: typeof data?.answer === 'string' ? data.answer : '',
      sources: Array.isArray(data?.sources) ? data.sources : [],
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // AbortSignal.timeout rejects with a TimeoutError; a plain abort surfaces as AbortError.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', error };
    }
    return { ok: false, reason: 'error', error };
  }
}
