/**
 * Runs every ask in asks.json through the bot's real recommender against a reddit-bot DB copy and
 * writes one JSONL line per ask: the parsed request, the shortlist the picker saw, the picks and
 * the answer, with timings. `judge.ts` scores the file afterwards.
 *
 *   node --env-file=.env bench/books/run.ts --db <copy.sqlite3> --model minipc|haiku-api|<claude model> --label L --out <dir>
 *
 * `haiku-api` is the bot's own `BOOK_LLM=haiku` path (Messages API, needs ANTHROPIC_API_KEY), without
 * the mini PC fallback so failures show; any other non-minipc model goes through `claude -p`.
 *
 * Output holds Reddit excerpts, so --out must be outside the repo. Asks run one at a time: the
 * mini PC gateway has two slots shared with live traffic.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deepInfraAPI } from '../../models/models.ts';
import { createBookRecommender, type Completion } from '../../whatsapp/books/recommendBooks.ts';
import { openSqliteBookCatalog } from '../../whatsapp/books/sqliteBookCatalog.ts';
import type { BookCatalog, Candidate } from '../../whatsapp/books/bookCatalog.ts';
import { claudeCli } from './claudeCli.ts';
import Anthropic from '@anthropic-ai/sdk';
import { haikuComplete } from '../../whatsapp/books/haikuComplete.ts';

export type Ask = { id: string; kind: string; ask: string; note?: string };

export type CallLog = { ms: number; ok: boolean; error?: string; apiMs?: number | null; costUsd?: number | null };

export type RunLine = {
  id: string;
  ask: string;
  ms: number;
  error?: string;
  log?: Record<string, unknown>;
  answer?: string;
  picks: { id: number; title: string; author: string | null }[];
  shortlist: Candidate[];
  calls: CallLog[];
};

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    model: { type: 'string', default: 'minipc' },
    label: { type: 'string' },
    out: { type: 'string' },
    only: { type: 'string' },
    'no-asks': { type: 'boolean' },
  },
});
if (!values.db || !values.out || !values.label) throw new Error('--db, --label and --out are required');
if (path.resolve(values.out).startsWith(path.resolve(import.meta.dirname, '../..'))) {
  throw new Error('--out must be outside the repo: results hold Reddit excerpts');
}

const asks = (JSON.parse(readFileSync(path.join(import.meta.dirname, 'asks.json'), 'utf8')) as Ask[])
  .filter((a) => !values.only || values.only.split(',').includes(a.id));
const model = values.model!;
const file = path.join(values.out, `${values.label}.jsonl`);
mkdirSync(values.out, { recursive: true });
appendFileSync(file, JSON.stringify({ settings: { model, db: values.db, asks: !values['no-asks'], at: new Date().toISOString() } }) + '\n');

let calls: CallLog[] = [];
const anthropic = model === 'haiku-api' ? new Anthropic({ apiKey: requiredKey(), timeout: 20_000, maxRetries: 1 }) : null;
const haikuApi = haikuComplete((p) => anthropic!.messages.create(p));
function requiredKey() {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error('--model haiku-api needs ANTHROPIC_API_KEY');
  return key;
}
async function complete(prompt: string): Promise<Completion> {
  const t = Date.now();
  try {
    if (model === 'minipc') {
      const text = await deepInfraAPI(prompt, undefined, { temperature: 0, json: process.env.BENCH_NO_JSON !== '1' });
      calls.push({ ms: Date.now() - t, ok: true });
      return { text, backend: 'minipc' };
    }
    if (model === 'haiku-api') {
      const reply = await haikuApi(prompt);
      calls.push({ ms: Date.now() - t, ok: true });
      return reply;
    }
    const r = await claudeCli(prompt, model);
    calls.push({ ms: r.wallMs, ok: true, apiMs: r.apiMs, costUsd: r.costUsd });
    return { text: r.text, backend: 'claude' };
  } catch (err) {
    calls.push({ ms: Date.now() - t, ok: false, error: (err as Error).message });
    throw err;
  }
}

/** The real catalog, remembering every Candidate it hands the recommender; `--no-asks` turns ask retrieval off. */
function recording(catalog: BookCatalog, seen: Map<number, Candidate>): BookCatalog {
  const keep = (cs: Candidate[]) => (cs.forEach((c) => seen.set(c.id, c)), cs);
  return {
    ...catalog,
    similarTo: (...a) => keep(catalog.similarTo(...a)),
    popular: (...a) => keep(catalog.popular(...a)),
    answeredFor: (...a) => (values['no-asks'] ? [] : keep(catalog.answeredFor(...a))),
  };
}

const catalog = openSqliteBookCatalog(values.db);
for (const a of asks) {
  calls = [];
  const seen = new Map<number, Candidate>();
  let log: Record<string, unknown> | undefined;
  const recommend = createBookRecommender({
    catalog: recording(catalog, seen),
    complete,
    logger: { info: (o: unknown) => void (log = o as Record<string, unknown>) },
  });
  const started = Date.now();
  const line: RunLine = { id: a.id, ask: a.ask, ms: 0, picks: [], shortlist: [], calls };
  try {
    const r = await recommend(a.ask);
    line.answer = r.kind === 'answer' ? r.text : '(not a request)';
  } catch (err) {
    line.error = (err as Error).message;
  }
  line.ms = Date.now() - started;
  line.log = log;
  const pickIds = Array.isArray(log?.picks) ? (log.picks as number[]) : [];
  line.picks = pickIds.map((id) => seen.get(id)).filter((c) => !!c).map((c) => ({ id: c.id, title: c.title, author: c.author }));
  line.shortlist = [...seen.values()];
  appendFileSync(file, JSON.stringify(line) + '\n');
  console.error(`${a.id}: ${line.error ?? (line.picks.map((p) => p.title).join(' | ') || '(no picks)')} [${line.ms} ms]`);
}
console.error(`wrote ${file}`);
