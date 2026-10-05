import { askBookRecs } from '../bookRecsClient.js';

export const BOOK_AGENT_SKIP = 'SKIP';
export const BOOK_RECS_UNAVAILABLE = 'Book recommendations are unavailable right now.';

const KEYWORD_PATTERN = new RegExp(
  [
    String.raw`\b(?:books?|novels?|audiobooks?|reads|trilogy)\b`,
    String.raw`\bread(?:ing)?\s+(?:next|after|list)\b`,
    String.raw`\b(?:what|something|anything)\s+(?:\w+\s+){0,3}(?:to|should\s+i|could\s+i|can\s+i)\s+read\b`,
    String.raw`\brecommend(?:ation)?s?\b.*\bread\b`,
    String.raw`\b(?:something|anything)\s+(?:\w+\s+)?like\s+\S`,
    String.raw`\bsimilar\s+to\b`,
  ].join('|'),
  'i',
);

/**
 * Keyword gate; the service itself decides whether a hit is really a request (`not_a_request`).
 * @param {string} text
 * @returns {boolean}
 */
export function shouldTryBookAgent(text) {
  if (process.env.BOOK_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  return KEYWORD_PATTERN.test(text);
}

/**
 * Owner-only. Non-owners never reach the service.
 * @param {import('../orchestration/normalizeBaileysMessage.js').InboundMessage} m
 * @param {{
 *   askBookRecs?: typeof askBookRecs,
 *   isAllowedActor?: (actorId: string | null, actorAltId?: string | null) => boolean,
 *   logger?: { warn: Function },
 * }} [deps]
 * @returns {Promise<string>} The service's answer as is, the "unavailable" message, or BOOK_AGENT_SKIP.
 */
export async function runBookAgent(m, deps = {}) {
  const allowed = typeof deps.isAllowedActor === 'function' && deps.isAllowedActor(m.actorId, m.actorAltId);
  if (!allowed) return BOOK_AGENT_SKIP;

  const ask = deps.askBookRecs ?? askBookRecs;
  const result = await ask(m.text);

  if (!result.ok) {
    if (result.reason === 'not_configured') return BOOK_AGENT_SKIP;
    // 'timeout' and 'error' both mean the service is unavailable to the owner.
    deps.logger?.warn({ reason: result.reason, err: result.error?.message }, 'Book recommendation service failed');
    return BOOK_RECS_UNAVAILABLE;
  }
  if (result.kind === 'not_a_request') return BOOK_AGENT_SKIP;
  return result.answer.trim() ? result.answer : BOOK_RECS_UNAVAILABLE;
}
