import type { Recommendation } from '../books/recommendBooks.ts';
import { parseProfileCommand } from '../books/readingProfile.ts';
import type { InboundMessage } from '../orchestration/normalizeBaileysMessage.ts';
import type { isAllowedActor } from '../whatsAppActorAllowlist.ts';
import type { Logger } from '../types.ts';

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
 * Keyword gate, plus reading-profile messages ("loved Mistborn", "show my reading profile"); the
 * recommender itself decides whether a hit is really a request (`not_a_request`).
 */
export function shouldTryBookAgent(text: string): boolean {
  if (process.env.BOOK_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  return KEYWORD_PATTERN.test(text) || parseProfileCommand(text) !== null;
}

/**
 * Owner-only (the allowlist). Reading-profile messages are answered first, then requests. Non-owners, and every message when no catalog is configured, get BOOK_AGENT_SKIP.
 * @returns The recommendation, the "unavailable" message, or BOOK_AGENT_SKIP.
 */
export async function runBookAgent(m: InboundMessage, deps: {
  recommend?: (question: string) => Promise<Recommendation>;
  /** Reading-profile messages: the reply, or null when the message isn't one. */
  profile?: (text: string) => Promise<string | null>;
  isAllowedActor?: typeof isAllowedActor;
  logger?: Pick<Logger, 'warn'>;
} = {}): Promise<string> {
  const allowed = typeof deps.isAllowedActor === 'function' && deps.isAllowedActor(m.actorId, m.actorAltId);
  if (!allowed || !deps.recommend) return BOOK_AGENT_SKIP;

  let result: Recommendation;
  try {
    const shelved = deps.profile ? await deps.profile(m.text) : null;
    if (shelved !== null) return shelved;
    result = await deps.recommend(m.text);
  } catch (err) {
    deps.logger?.warn({ err: (err as Error).message }, 'Book recommendations failed');
    return BOOK_RECS_UNAVAILABLE;
  }
  return result.kind === 'not_a_request' ? BOOK_AGENT_SKIP : result.text;
}
