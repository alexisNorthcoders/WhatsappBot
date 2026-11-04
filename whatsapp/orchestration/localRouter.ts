/**
 * Answers the router's questions with a small local model behind an OpenAI-compatible server
 * (llama-server via the mini PC gateway) instead of Jev. It is a FetchLike for createJevRouter:
 * it reads the SystemOne body the router builds and replies with SystemOne-shaped answers, so the
 * route and lights fast path decide exactly as they do for Jev. bench/router scores it.
 */
import type { FetchLike } from '../types.ts';
import type { JevChoiceQuestion } from '../agents/lightsJev.ts';

/** One request to the model while answering a message. */
export type LocalRouterCall = {
  question: string;
  ms: number;
  status: number | null;
  error?: string;
  /** llama-server `timings`, when the gateway passes them through */
  timings?: { prompt_n?: number; cache_n?: number; predicted_n?: number; prompt_ms?: number; predicted_ms?: number };
};

export type LocalRouterOptions = {
  /** e.g. http://minipc.local:4000/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** merged into every request; Qwen3's thinking is off by default */
  extraBody?: Record<string, unknown>;
  /** cap for the lights JSON reply */
  maxTokens?: number;
  /** the Hue lights, read when a lights route needs target names */
  lights: () => { id: string; name: string; room: string }[];
  /** sees each request, filled in when it ends */
  onCall?: (call: LocalRouterCall) => void;
  fetch?: FetchLike;
};

const DEFAULT_EXTRA_BODY = { chat_template_kwargs: { enable_thinking: false } };

type Criterion = string | null | { what: string; not_for?: string; examples?: string[] };
type Token = { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] };
type Reply = { content: string; tokens: Token[] };
/** a llama-server GBNF grammar, or an OpenAI-style JSON schema */
type Constraint = { grammar: string } | { schema: object };

/** JSON field → the bot's question id it answers. */
const LIGHTS_FIELDS = {
  action: 'lights_action',
  target: 'lights_target',
  brightness: 'lights_brightness',
  colour: 'lights_colour',
} as const;
type LightsField = keyof typeof LIGHTS_FIELDS;
/** filled for every lights message; the rest only when the action needs them */
const REQUIRED: LightsField[] = ['action', 'target'];

function describe(key: string, c: Criterion) {
  if (typeof c === 'string') return `  - ${key}: ${c}`;
  if (!c) return `  - ${key}`;
  let line = `  - ${key}: ${c.what}`;
  if (c.not_for) line += ` Not for: ${c.not_for}`;
  if (c.examples?.length) line += ` Examples: ${c.examples.map((e) => JSON.stringify(e)).join('; ')}`;
  return line;
}

const options = (q: JevChoiceQuestion) =>
  Object.entries(q.criteria)
    .map(([k, c]) => describe(k, c as Criterion))
    .join('\n');

/** The route alone, constrained by a grammar to the bare option key: two to five tokens. */
export function renderRoutePrompt(route: JevChoiceQuestion) {
  const keys = Object.keys(route.criteria);
  return {
    system: `${route.instructions}\n\nOptions:\n${options(route)}\n\nReply with the option key only.`,
    constraint: { grammar: `root ::= ${keys.map((k) => JSON.stringify(k)).join(' | ')}` },
    keys,
  };
}

/**
 * The lights questions as one JSON object, built from the bot's own criteria. Action and target
 * are always filled; brightness and colour only when the action needs them, so the model writes
 * no more than the fast path reads.
 */
export function renderLightsPrompt(questions: Record<string, JevChoiceQuestion>) {
  const fields = (Object.keys(LIGHTS_FIELDS) as LightsField[]).filter((f) => questions[LIGHTS_FIELDS[f]]);
  const keysOf = (f: LightsField) => Object.keys(questions[LIGHTS_FIELDS[f]].criteria);
  const premise = questions.lights_action.instructions.match(/^Assume [^.]*\./)?.[0] ?? '';
  const text = fields
    .map((f) => {
      const q = questions[LIGHTS_FIELDS[f]];
      const when = REQUIRED.includes(f) ? '' : ` Include only when action is "${f}".`;
      return `${f}: ${q.instructions.replace(/^Assume [^.]*\.\s*/, '')}${when}\n${options(q)}`;
    })
    .join('\n\n');
  // one variant per action that needs an extra field ("brightness" → level), one for the rest,
  // so the grammar stops the model writing fields the fast path won't read
  const required = REQUIRED.filter((f) => fields.includes(f));
  const extras = fields.filter((f) => !REQUIRED.includes(f) && keysOf('action').includes(f));
  const variant = (actions: string[], extra?: LightsField) => {
    const props: LightsField[] = extra ? [...required, extra] : required;
    return {
      type: 'object',
      properties: Object.fromEntries(props.map((f) => [f, { enum: f === 'action' ? actions : keysOf(f) }])),
      required: props,
      additionalProperties: false,
    };
  };
  const plain = keysOf('action').filter((a) => !extras.includes(a as LightsField));
  return {
    system: `${premise} Answer with a JSON object with these fields.\n\n${text}\n\nReply with JSON only.`,
    constraint: { schema: { anyOf: [variant(plain), ...extras.map((f) => variant([f], f))] } },
    keysOf,
  };
}

/**
 * Renames the bot's target options (`room:<room>`, `light:<id>`) to the bare names a message
 * uses, because the model wants to write "Garden", not a `room:` prefix the grammar forces on it.
 * A room with one light is one option, under the room's name in title case (the model writes
 * "Living Room" when the lights are called "Living Room Left"). A light named like its room is
 * "<name> light". Names that would still clash keep the bot's keys. `toBotKey` maps an answer back.
 */
export function nameLightTargets(
  questions: Record<string, JevChoiceQuestion>,
  lights: { id: string; name: string; room: string }[],
) {
  const target = questions.lights_target;
  if (!target) return { questions, toBotKey: (key: string) => key };
  const inRoom = (room: string) => lights.filter((L) => L.room === room);
  // bot key → the name to offer, or null to drop the option (a one-light room's light)
  const wanted = new Map<string, string | null>();
  for (const L of lights) {
    const name = L.name.trim();
    if (inRoom(L.room).length === 1) wanted.set(`light:${L.id}`, null);
    else wanted.set(`light:${L.id}`, name.toLowerCase() === L.room.toLowerCase() ? `${name} light` : name);
  }
  const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  for (const room of new Set(lights.map((L) => L.room))) wanted.set(`room:${room}`, titleCase(room));

  const uses = new Map<string, number>();
  const bump = (k: string) => uses.set(k.toLowerCase(), (uses.get(k.toLowerCase()) ?? 0) + 1);
  for (const key of Object.keys(target.criteria)) bump(wanted.get(key) ?? key);
  const promptKey = (key: string) => {
    const name = wanted.get(key) ?? key;
    return uses.get(name.toLowerCase()) === 1 ? name : key;
  };

  const criteria: Record<string, unknown> = {};
  const toBot = new Map<string, string>();
  for (const [key, c] of Object.entries(target.criteria)) {
    if (wanted.get(key) === null) continue;
    const only = key.startsWith('room:') ? inRoom(key.slice(5)) : [];
    criteria[promptKey(key)] =
      only.length === 1 ? `The light named "${only[0].name.trim()}", the only light in the ${key.slice(5)} room.` : c;
    toBot.set(promptKey(key), key);
  }
  return {
    questions: { ...questions, lights_target: { ...target, criteria } as JevChoiceQuestion },
    toBotKey: (key: string) => toBot.get(key) ?? key,
  };
}

/**
 * The probability the model gives `content[start, end)` among the allowed `keys`. llama-server
 * reports logprobs from before the grammar, so a forced token can read as near-impossible. Each
 * step that writes the value is renormalised over the top alternatives that still lead to a key;
 * `close` is what must follow a finished key ('"' in JSON, end of reply for a bare key).
 */
export function choiceProbability(
  tokens: Token[],
  content: string,
  [start, end]: [number, number],
  keys: string[],
  close: '"' | 'end',
) {
  const answer = tokens.slice(tokens.findIndex((t) => t.token === '</think>') + 1);
  const offset = answer
    .map((t) => t.token)
    .join('')
    .indexOf(content);
  const after = close === 'end' ? 0 : close.length;
  const allowed = (value: string, eos: boolean) =>
    close === 'end'
      ? eos
        ? keys.includes(value)
        : keys.some((k) => k.startsWith(value))
      : !eos && keys.some((k) => (k + close).startsWith(value) || value.startsWith(k + close));

  let pos = -offset;
  let probability = 1;
  for (const t of answer) {
    const a = pos;
    const b = pos + t.token.length;
    pos = b;
    const writesValue = t.token ? b > start && a < end + after : close === 'end' && a === end;
    if (!writesValue) continue;
    const before = a < start ? content.slice(a, start) : '';
    const sofar = content.slice(start, Math.max(start, a));
    const ok = (alt: string) => alt.startsWith(before) && allowed(sofar + alt.slice(before.length), alt === '');
    const alts = (t.top_logprobs ?? []).filter((x) => ok(x.token));
    if (!alts.some((x) => x.token === t.token)) alts.push(t);
    // a token that reaches the value's close: what follows the close ('",' or '"\n') is the
    // schema's business, so alternatives that close the same value are the same answer
    const cut = end + after - a;
    const closes = after > 0 && cut <= t.token.length;
    const same = closes ? alts.filter((x) => x.token.slice(0, cut) === t.token.slice(0, cut)) : [t];
    const total = alts.reduce((s, x) => s + Math.exp(x.logprob), 0);
    probability *= total ? same.reduce((s, x) => s + Math.exp(x.logprob), 0) / total : 0;
  }
  return probability;
}

/** Where the string value of `field` sits in a JSON reply. */
export function valueSpan(content: string, field: string): [number, number] | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  return [start, content.indexOf('"', start)];
}

/**
 * A FetchLike that answers the bot's SystemOne body with constrained chat completions: the route
 * (a grammar over the keys), then the lights object (a JSON schema) only after a lights route.
 * The replies are mapped back to the answers the bot reads, so createJevRouter and
 * runLightsFromJev decide the outcome as they do for Jev.
 */
export function createLocalRouterFetch(opts: LocalRouterOptions): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const questions = body.questions as Record<string, JevChoiceQuestion>;
    const message = String(body.state.message);
    const signal = init?.signal ?? undefined;
    const pick = (value: string, prob: number) => ({ type: 'choice', choice: value, probabilities: { [value]: prob } });

    const routePrompt = renderRoutePrompt(questions.route);
    const routeReply = await complete(opts, 'route', routePrompt, message, 16, signal);
    const route = routeReply.content;
    const answers: Record<string, unknown> = {
      route: pick(route, choiceProbability(routeReply.tokens, route, [0, route.length], routePrompt.keys, 'end')),
    };

    if (route === 'lights' && questions.lights_action) {
      const { questions: named, toBotKey } = nameLightTargets(questions, opts.lights());
      const lightsPrompt = renderLightsPrompt(named);
      try {
        const reply = await complete(opts, 'lights', lightsPrompt, message, opts.maxTokens ?? 96, signal);
        const parsed = JSON.parse(reply.content) as Partial<Record<LightsField, string>>;
        for (const [f, id] of Object.entries(LIGHTS_FIELDS) as [LightsField, string][]) {
          const span = valueSpan(reply.content, f);
          const value = parsed[f];
          if (typeof value === 'string' && span)
            answers[id] = pick(
              f === 'target' ? toBotKey(value) : value,
              choiceProbability(reply.tokens, reply.content, span, lightsPrompt.keysOf(f), '"'),
            );
        }
      } catch (err) {
        // no lights answers reads as unconfident: the fast path hands over to GPT
        if (signal?.aborted) throw err;
      }
    }
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
}

async function complete(
  opts: LocalRouterOptions,
  question: string,
  prompt: { system: string; constraint: Constraint },
  message: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
): Promise<Reply> {
  const started = performance.now();
  const record: LocalRouterCall = { question, ms: 0, status: null };
  opts.onCall?.(record);
  try {
    const constraint =
      'grammar' in prompt.constraint
        ? { grammar: prompt.constraint.grammar }
        : {
            response_format: {
              type: 'json_schema',
              json_schema: { name: question, strict: true, schema: prompt.constraint.schema },
            },
          };
    const res = await (opts.fetch ?? globalThis.fetch)(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: `message: ${message}` },
        ],
        max_tokens: maxTokens,
        temperature: 0,
        logprobs: true,
        top_logprobs: 20,
        ...constraint,
        ...(opts.extraBody ?? DEFAULT_EXTRA_BODY),
      }),
      signal,
    });
    record.status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    record.timings = data.timings;
    const choice = data.choices?.[0];
    const content = String(choice?.message?.content ?? '').trim();
    if ('schema' in prompt.constraint) {
      try {
        JSON.parse(content);
      } catch {
        throw new Error(`reply is not JSON (${choice?.finish_reason}): ${JSON.stringify(content.slice(0, 80))}`);
      }
    }
    return { content, tokens: choice.logprobs?.content ?? [] };
  } catch (err) {
    record.error = (err as Error).message;
    throw err;
  } finally {
    record.ms = performance.now() - started;
  }
}
