/**
 * Picks which agent (if any) should handle a message, using TypeSafe's Jev model
 * (a Choice question over the agent names). Replaces the per-agent keyword gates
 * when TYPESAFE_API_KEY is set. See https://docs.typesafe.ai/api.
 */

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';

export const ROUTE_CHAT = 'chat';

/** Option keys must match the agent keys in agentsTryHandle.js. */
export const ROUTE_CRITERIA = {
  reminder: {
    what: 'Create, list, cancel or get help with scheduled reminders ("remind me", "nudge me").',
    examples: ['remind me to call mum at 6pm', 'nudge me in 20 minutes', 'what reminders do I have', 'cancel reminder 3'],
  },
  lights: {
    what: 'Control or ask about the Philips Hue lights in the house: on/off, brightness, colour, rooms.',
    examples: ['turn off the bedroom lights', 'dim the living room', 'is the kitchen light on'],
  },
  weather: {
    what: 'Weather conditions or forecast for a place or time.',
    examples: ['will it rain tomorrow', 'how cold is it in Manchester', 'do I need a coat today'],
  },
  joplin: {
    what: "Read, search, create, edit or delete notes in the user's Joplin notebook, or save a web page into it.",
    examples: ['save a note: buy milk', 'find my note about the boiler service', 'save https://example.com to my notes'],
  },
  email: {
    what: 'Send an email to someone.',
    examples: ['email john@example.com saying I will be late', 'send an email to my boss about Friday'],
  },
  home: {
    what: 'Questions about household appliances and equipment answered from their manuals (boiler, oven, dishwasher, etc.).',
    not_for: 'The Hue lights, which are "lights".',
    examples: ['how do I descale the coffee machine', 'what boiler do we have', 'dishwasher shows error E24'],
  },
  [ROUTE_CHAT]: {
    what: 'Anything else: general conversation, questions, jokes, advice, or a request none of the other options covers.',
    examples: ['tell me a joke', 'what is the capital of France', 'thanks!'],
  },
};

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {typeof fetch} [opts.fetch]
 * @param {string} [opts.url]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.minProbability] below this, the message goes to chat
 * @param {string[]} [opts.agents] agent keys to offer (chat is always offered)
 * @param {() => Record<string, object>} [opts.extraQuestions] speculative agent-specific questions
 *   asked in the same request (answers come back on `answers` whatever the route)
 * @param {{ info: Function; warn: Function }} opts.logger
 * @returns {(text: string) => Promise<{ agent: string; probability: number; answers: Record<string, any> } | null>}
 *   null when Jev could not be reached (caller falls back to the keyword gates)
 */
export function createJevRouter(opts) {
  const {
    apiKey,
    fetch: fetchImpl = globalThis.fetch,
    url = DEFAULT_URL,
    model = 'jev-latest',
    timeoutMs = 3000,
    minProbability = 0.5,
    agents = Object.keys(ROUTE_CRITERIA),
    extraQuestions = () => ({}),
    logger,
  } = opts;

  const criteria = Object.fromEntries(
    Object.entries(ROUTE_CRITERIA).filter(([key]) => key === ROUTE_CHAT || agents.includes(key)),
  );

  return async function routeIntent(text) {
    const started = Date.now();
    let body;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          state: { message: text },
          questions: {
            ...extraQuestions(),
            route: {
              type: 'choice',
              instructions:
                'A user sent `message` to their personal WhatsApp assistant. Which assistant feature should handle it?',
              criteria,
            },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, ms: Date.now() - started }, 'Jev routing failed, using keyword gates');
        return null;
      }
      body = await res.json();
    } catch (err) {
      logger.warn({ err: err?.message || err, ms: Date.now() - started }, 'Jev routing failed, using keyword gates');
      return null;
    }

    const answer = body?.answers?.route;
    const choice = answer?.choice;
    if (typeof choice !== 'string' || !(choice in criteria)) {
      logger.warn({ answer }, 'Jev routing returned an unexpected answer, using keyword gates');
      return null;
    }
    const probability = Number(answer.probabilities?.[choice] ?? 0);
    const agent = probability >= minProbability ? choice : ROUTE_CHAT;
    logger.info({ choice, probability, agent, ms: Date.now() - started }, 'Jev route');
    return { agent, probability, answers: body.answers };
  };
}
