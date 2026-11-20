import Anthropic from '@anthropic-ai/sdk';
import type { Complete } from './recommendBooks.ts';
import type { Logger } from '../types.ts';

export const BOOK_HAIKU_MODEL = 'claude-haiku-5-5';
/** A chat turn waits on this; past it the mini PC answers instead. */
const TIMEOUT_MS = 20_000;

/** The one SDK call the Haiku path makes, so tests can pass a fake. */
export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Pick<Anthropic.Message, 'content' | 'stop_reason'>>;

/** Book parse/pick prompts → Haiku 5.5 via the Messages API. Throws on an API error, a refusal or an empty reply. */
export function haikuComplete(create: CreateMessage, model = BOOK_HAIKU_MODEL): Complete {
  return async (prompt) => {
    const message = await create({
      model,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }],
    });
    if (message.stop_reason === 'refusal') throw new Error(`${model} refused`);
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    if (!text) throw new Error(`${model} returned no text (stop_reason ${message.stop_reason})`);
    return text;
  };
}

/** `primary`, or `fallback` when it throws. */
export function withFallback(primary: Complete, fallback: Complete, logger?: Pick<Logger, 'warn'>): Complete {
  return async (prompt) => {
    try {
      return await primary(prompt);
    } catch (err) {
      logger?.warn({ err: (err as Error).message }, 'book LLM failed, using the mini PC');
      return fallback(prompt);
    }
  };
}

/**
 * The book recommender's model. Default: `minipc` (the DeepInfra-compatible gateway). With
 * `BOOK_LLM=haiku` and `ANTHROPIC_API_KEY` set, Haiku 5.5 answers both calls and any error
 * falls back to the mini PC.
 */
export function bookCompleteFromEnv(minipc: Complete, logger?: Pick<Logger, 'warn' | 'info'>, env = process.env): Complete {
  if (env.BOOK_LLM?.trim().toLowerCase() !== 'haiku') return minipc;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    logger?.warn({}, 'BOOK_LLM=haiku needs ANTHROPIC_API_KEY; using the mini PC');
    return minipc;
  }
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  logger?.info({ model: BOOK_HAIKU_MODEL }, 'book recommendations use Haiku, falling back to the mini PC');
  return withFallback(haikuComplete((p) => client.messages.create(p)), minipc, logger);
}
