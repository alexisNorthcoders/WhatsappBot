import { askHomeManuals } from '../homeManualsClient.ts';
import { formatHomeAnswerReply } from '../utils/formatHomeAnswer.ts';

export const HOME_AGENT_SKIP = 'SKIP';

const KEYWORD_PATTERN =
  /\b(boiler|combi\s+boiler|immersion\s+heater|water\s+heater|thermostat|radiator|dishwasher|washing\s+machine|tumble\s+dryer|dryer|fridge|freezer|oven|hob|microwave|kettle|coffee\s+machine|extractor\s+fan|smoke\s+alarm|fuse\s+box|appliance|manual|instruction\s+manual|user\s+guide|warranty)\b|\bdescale\b/i;

export function shouldTryHomeAgent(text: string): boolean {
  if (process.env.HOME_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KEYWORD_PATTERN.test(trimmed);
}

function looksLikeUnknownAnswer(answer: string): boolean {
  return /\b(i\s+)?don'?t\s+know\b|\bnot\s+sure\b|\bno\s+information\b|\bcould\s?n'?t\s+find\b/i.test(
    answer || '',
  );
}

/**
 * @returns Final user-facing text, or HOME_AGENT_SKIP to fall through to other handlers.
 */
export async function runHomeAgent(userMessage: string, deps: { askHomeManuals?: typeof askHomeManuals } = {}): Promise<string> {
  const ask = deps.askHomeManuals ?? askHomeManuals;
  const result = await ask(userMessage);

  if (!result.ok) {
    return HOME_AGENT_SKIP;
  }

  const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
  if (!answer) {
    return HOME_AGENT_SKIP;
  }

  const sources = Array.isArray(result.sources) ? result.sources : [];
  if (sources.length === 0 && looksLikeUnknownAnswer(answer)) {
    return HOME_AGENT_SKIP;
  }

  return formatHomeAnswerReply(answer, sources);
}
