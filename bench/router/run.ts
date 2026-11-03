/**
 * Runs the labelled WhatsApp messages through the bot's real router (createJevRouter plus the
 * lights fast-path questions) against TypeSafe Jev or an OpenAI-compatible server. See README.md.
 */
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createJevRouter } from '../../whatsapp/orchestration/jevRouter.ts';
import { lightsJevQuestions } from '../../whatsapp/agents/lightsJev.ts';
import { chatChoiceFetch, timedFetch } from './backends.ts';
import { structuredFetch } from './structured.ts';
import type { ChatBackendOptions, Recorder } from './backends.ts';
import { loadDataset, loadLights } from './dataset.ts';
import type { Row } from './dataset.ts';
import { scoreLights, summarize } from './score.ts';
import type { Phase, ResultRow } from './score.ts';

const here = import.meta.dirname;

const { values: args } = parseArgs({
  options: {
    backend: { type: 'string' },
    url: { type: 'string' },
    model: { type: 'string' },
    'env-file': { type: 'string' },
    'key-var': { type: 'string' },
    dataset: { type: 'string', default: path.join(here, 'dataset.jsonl') },
    lights: {
      type: 'string',
      default: path.join(here, 'lights.snapshot.json'),
    },
    phases: { type: 'string', default: 'warm' },
    reps: { type: 'string', default: '3' },
    sample: { type: 'string', default: '24' },
    limit: { type: 'string' },
    prompt: { type: 'string', default: 'structured' },
    fanout: { type: 'string', default: 'route-first' },
    options: { type: 'string', default: 'keys' },
    'max-tokens': { type: 'string' },
    'timeout-ms': { type: 'string', default: '20000' },
    'min-probability': { type: 'string' },
    'lights-min-probability': { type: 'string', default: '0.7' },
    'extra-body': {
      type: 'string',
      default: '{"chat_template_kwargs":{"enable_thinking":false}}',
    },
    label: { type: 'string' },
    out: { type: 'string' },
  },
});

const DEFAULTS = {
  jev: {
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keyVar: 'TYPESAFE_API_KEY',
    envFile: path.join(homedir(), 'Projects/WhatsappBot/.env'),
  },
  chat: {
    url: 'http://minipc.local:4000/v1',
    model: 'qwen3-30b-a3b',
    keyVar: 'ROUTER_BENCH_GATEWAY_KEY',
    envFile: path.join(here, '.env'),
  },
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const backend = args.backend;
if (backend !== 'jev' && backend !== 'chat') fail('--backend jev|chat is required');
const d = DEFAULTS[backend];
const url = args.url ?? d.url;
const model = args.model ?? d.model;
const phases = args.phases.split(',') as Phase[];
for (const p of phases) if (!['warm', 'uncached'].includes(p)) fail(`unknown phase ${p}`);
if (backend === 'jev' && phases.some((p) => p !== 'warm'))
  fail('the uncached phase needs --backend chat (it turns off llama-server prompt caching)');
if (args.fanout !== 'all' && args.fanout !== 'route-first' && args.fanout !== 'route-only')
  fail('--fanout all|route-first|route-only');
if (args.options !== 'keys' && args.options !== 'letters') fail('--options keys|letters');
if (args.prompt !== 'structured' && args.prompt !== 'per-question') fail('--prompt structured|per-question');
const structured = args.prompt === 'structured';
const reps = Number(args.reps);
const timeoutMs = Number(args['timeout-ms']);
const lightsMin = Number(args['lights-min-probability']);
const minProbability = args['min-probability'] ? Number(args['min-probability']) : undefined;

/** `.env` files here use `NAME = value`, and old commented keys sit beside the live ones. */
function readKey(file: string, name: string) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2');
  }
  fail(`${name} not found in ${file}`);
}
const apiKey = readKey(args['env-file'] ?? d.envFile, args['key-var'] ?? d.keyVar);

const lights = loadLights(args.lights);
let rows = loadDataset(args.dataset, lights);
if (args.limit) rows = rows.slice(0, Number(args.limit));
const questions = lightsJevQuestions(lights);

const chatOpts: ChatBackendOptions = {
  baseUrl: url.replace(/\/$/, ''),
  model,
  apiKey,
  fanout: args.fanout,
  options: args.options,
  maxTokens: Number(args['max-tokens'] ?? (structured ? 96 : args.options === 'letters' ? 1 : 16)),
  extraBody: JSON.parse(args['extra-body']),
};

const label =
  args.label ??
  `${backend}-${model}${backend === 'chat' ? (structured ? '-structured' : `-${args.fanout}-${args.options}`) : ''}`;
const started = new Date();
const outPath =
  args.out ??
  path.join(here, 'results', `${started.toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^\w.-]+/g, '_')}.jsonl`);
mkdirSync(path.dirname(outPath), { recursive: true });
const out = createWriteStream(outPath);
const write = (obj: object) => out.write(JSON.stringify(obj) + '\n');

let commit = '';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: here,
    encoding: 'utf8',
  }).trim();
} catch {}
write({
  type: 'meta',
  label,
  backend,
  url,
  model,
  phases,
  reps,
  sample: Number(args.sample),
  prompt: backend === 'chat' ? args.prompt : 'jev-single-request',
  fanout: backend === 'chat' && !structured ? args.fanout : undefined,
  options: backend === 'chat' && !structured ? args.options : undefined,
  maxTokens: backend === 'chat' ? chatOpts.maxTokens : undefined,
  timeoutMs,
  minProbability: minProbability ?? 'bot default',
  lightsMinProbability: lightsMin,
  extraBody: backend === 'chat' ? chatOpts.extraBody : undefined,
  dataset: path.relative(here, args.dataset),
  rows: rows.length,
  commit,
  started: started.toISOString(),
});

async function runOne(row: Row, phase: Phase, rep: number, backendOpts = chatOpts): Promise<ResultRow> {
  const rec: Recorder = { calls: [] };
  const warnings: string[] = [];
  const route = createJevRouter({
    apiKey,
    url,
    model,
    timeoutMs,
    minProbability,
    fetch:
      backend === 'jev'
        ? timedFetch(rec)
        : structured
          ? structuredFetch(backendOpts, rec, lights)
          : chatChoiceFetch(backendOpts, rec),
    extraQuestions: () => questions,
    logger: {
      info: () => {},
      warn: (obj: unknown, msg?: string) => warnings.push(`${msg}: ${JSON.stringify(obj)}`),
    },
  });
  const t0 = performance.now();
  const result = await route(row.text);
  const wallMs = performance.now() - t0;
  const agent = result?.agent ?? null;
  const answers = result?.answers ?? {};
  const scored = await scoreLights(row, agent, answers, lights, lightsMin);
  return {
    type: 'call',
    phase,
    rep,
    id: row.id,
    text: row.text,
    kind: row.kind,
    expected: row.route,
    agent,
    choice: answers.route?.choice ?? null,
    probability: result?.probability ?? null,
    routeOk: agent === row.route,
    lights: scored.outcome,
    subAnswers: scored.subAnswers,
    answers: Object.fromEntries(
      Object.entries(answers as Record<string, { choice: string; probabilities?: Record<string, number> }>).map(
        ([q, a]) => [q, [a.choice, Number(a.probabilities?.[a.choice] ?? 0)]],
      ),
    ),
    wallMs,
    error: result ? undefined : (warnings[0] ?? 'router returned null'),
    calls: rec.calls,
  };
}

/** Spread across the dataset so a short phase still covers every route. */
function sampleRows(n: number) {
  if (n >= rows.length) return rows;
  return Array.from({ length: n }, (_, i) => rows[Math.floor((i * rows.length) / n)]);
}

const all: ResultRow[] = [];
const record = (r: ResultRow) => {
  all.push(r);
  write(r);
  const mark = r.error ? 'ERR' : r.routeOk ? 'ok ' : 'BAD';
  process.stderr.write(
    `${r.phase} ${r.rep} ${r.id} ${mark} ${Math.round(r.wallMs)}ms ${r.expected}→${r.agent}${r.lights ? ` [${r.lights}]` : ''}\n`,
  );
};

for (const phase of phases) {
  if (phase === 'warm') {
    for (let rep = 1; rep <= reps; rep++) for (const row of rows) record(await runOne(row, 'warm', rep));
  } else {
    const uncached = { ...chatOpts, extraBody: { ...chatOpts.extraBody, cache_prompt: false } };
    for (const row of sampleRows(Number(args.sample))) record(await runOne(row, 'uncached', 1, uncached));
  }
}

out.end();
console.log(`${label}\n${summarize(all)}\n\nresults: ${outPath}`);
