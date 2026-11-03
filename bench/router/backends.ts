import type { FetchLike } from '../../whatsapp/types.ts';
import type { JevChoiceQuestion } from '../../whatsapp/agents/lightsJev.ts';

/** One HTTP request the backend made while answering a message. */
export type CallRecord = {
  question: string;
  ms: number;
  status: number | null;
  error?: string;
  /** llama-server `timings`, when the gateway passes them through */
  timings?: {
    prompt_n?: number;
    cache_n?: number;
    predicted_n?: number;
    prompt_ms?: number;
    predicted_ms?: number;
  };
  /** share of the first token's top_logprobs mass that landed on an option letter */
  optionMass?: number;
};

export type Recorder = { calls: CallRecord[] };

type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
};

/** The real fetch, timed. Jev answers every question in the one request. */
export function timedFetch(rec: Recorder): FetchLike {
  return async (url, init) => {
    const started = performance.now();
    try {
      const res = await fetch(url, init);
      rec.calls.push({
        question: '*',
        ms: performance.now() - started,
        status: res.status,
      });
      return res;
    } catch (err) {
      rec.calls.push({
        question: '*',
        ms: performance.now() - started,
        status: null,
        error: (err as Error).message,
      });
      throw err;
    }
  };
}

export type ChatBackendOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * all: every question, like the one Jev request. route-first: lights questions only after a
   * lights route. route-only: just the route, for scoring routing alone when calls are slow.
   */
  fanout: 'all' | 'route-first' | 'route-only';
  /**
   * keys: the model writes the option key; its probability is the product of the reply's token
   * probabilities. letters: options are lettered and the first token's top_logprobs give every
   * option a probability, but on long lists the model often answers the neighbouring letter.
   */
  options: 'keys' | 'letters';
  extraBody: Record<string, unknown>;
  /** reply cap; with thinking on it must also hold the reasoning */
  maxTokens: number;
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A FetchLike that takes the SystemOne body the bot builds and answers each Choice question
 * with one chat completion, so `createJevRouter` runs unchanged against an OpenAI-compatible
 * server. Fixed instructions and options go in the system message (a cacheable prefix), the
 * message last. Questions go one at a time: the mini PC has 2 slots shared with live traffic.
 */
export function chatChoiceFetch(opts: ChatBackendOptions, rec: Recorder): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const message: string = body.state.message;
    const questions = body.questions as Record<string, JevChoiceQuestion>;
    const signal = init?.signal ?? undefined;
    const ask = (id: string) => askChoice(opts, rec, id, questions[id], message, signal);
    const answers: Record<string, ChoiceAnswer> = { route: await ask('route') };
    // a sub-answer that isn't an option is no answer, which the fast path reads as unconfident;
    // the call keeps its error, and only a bad route answer fails the router
    if (opts.fanout === 'all' || (opts.fanout === 'route-first' && answers.route.choice === 'lights'))
      for (const id of Object.keys(questions)) {
        if (id === 'route') continue;
        try {
          answers[id] = await ask(id);
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
}

export function renderChoicePrompt(q: JevChoiceQuestion, options: ChatBackendOptions['options'] = 'keys') {
  const keys = Object.keys(q.criteria);
  if (options === 'letters' && keys.length > LETTERS.length) throw new Error(`too many options (${keys.length})`);
  const lines = keys.map((key, i) => {
    const c = q.criteria[key] as string | null | { what: string; not_for?: string; examples?: string[] };
    let line = options === 'letters' ? `${LETTERS[i]}) ${key}` : `- ${key}`;
    if (typeof c === 'string') line += `: ${c}`;
    else if (c) {
      line += `: ${c.what}`;
      if (c.not_for) line += ` Not for: ${c.not_for}`;
      if (c.examples?.length) line += ` Examples: ${c.examples.map((e) => JSON.stringify(e)).join('; ')}`;
    }
    return line;
  });
  return {
    keys,
    system:
      `${q.instructions}\n\nOptions:\n${lines.join('\n')}\n\n` +
      (options === 'letters'
        ? 'Reply with the letter of the best option only.'
        : `Reply with the key of the best option only, exactly as written before its colon (for example ${keys[0]}).`),
  };
}

async function askChoice(
  opts: ChatBackendOptions,
  rec: Recorder,
  id: string,
  q: JevChoiceQuestion,
  message: string,
  signal: AbortSignal | undefined,
): Promise<ChoiceAnswer> {
  const { keys, system } = renderChoicePrompt(q, opts.options);
  const started = performance.now();
  const record: CallRecord = { question: id, ms: 0, status: null };
  rec.calls.push(record);
  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `message: ${message}` },
        ],
        max_tokens: opts.maxTokens,
        temperature: 0,
        logprobs: true,
        top_logprobs: 20,
        ...opts.extraBody,
      }),
      signal,
    });
    record.status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    record.timings = data.timings;
    const choice = data.choices?.[0];
    if (opts.options === 'keys') {
      const text = String(choice?.message?.content ?? '').trim();
      const key = keys.find((k) => k.toLowerCase() === text.toLowerCase());
      if (!key) {
        const why =
          choice?.finish_reason === 'length' ? `hit max_tokens ${opts.maxTokens}` : 'reply is not an option key';
        throw new Error(`${why}: ${JSON.stringify(text.slice(0, 60))}`);
      }
      // llama-server's logprobs include the <think> tokens; the answer is what follows </think>
      const tokens: { token: string; logprob: number }[] = choice.logprobs?.content ?? [];
      const thinkEnd = tokens.findIndex((t) => t.token === '</think>');
      const logprob = tokens.slice(thinkEnd + 1).reduce((sum: number, t: { logprob: number }) => sum + t.logprob, 0);
      return {
        type: 'choice',
        choice: key,
        probabilities: { [key]: Math.exp(logprob) },
      };
    }
    const mass: Record<string, number> = {};
    let total = 0;
    for (const { token, logprob } of choice?.logprobs?.content?.[0]?.top_logprobs ?? []) {
      const i = LETTERS.indexOf(String(token).trim().toUpperCase());
      if (i < 0 || i >= keys.length) continue;
      const p = Math.exp(logprob);
      mass[keys[i]] = (mass[keys[i]] ?? 0) + p;
      total += p;
    }
    record.optionMass = total;
    if (!total) throw new Error(`no option letter in reply ${JSON.stringify(choice?.message?.content)}`);
    const probabilities = Object.fromEntries(Object.entries(mass).map(([k, p]) => [k, p / total]));
    const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    return { type: 'choice', choice: best, probabilities };
  } catch (err) {
    record.error = (err as Error).message;
    throw err;
  } finally {
    record.ms = performance.now() - started;
  }
}
