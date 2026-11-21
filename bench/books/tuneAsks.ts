/**
 * Tunes ask retrieval's weights against the 30 bench asks without re-judging every setting:
 *
 * 1. parses each ask with the bot's own parse prompt (cached in <out>/parses.json);
 * 2. retrieves the top 5 past asks under every weight setting of a grid;
 * 3. has an Opus judge rate each retrieved past ask once, 0–2, for whether its answers would
 *    suit the reader (cached in <out>/labels.jsonl, so a rerun only labels what's new);
 * 4. scores every setting offline: nDCG@3 over the bench asks with any relevant past ask, and
 *    the share of its top 3 rated 0. With --settings, it also prints, for each setting, how
 *    the ratings fall by score, to choose how many asks to pool and the score floor.
 *
 *   node bench/books/tuneAsks.ts --db <copy.sqlite3> --out <dir> [--parse-model claude-haiku-5-5]
 *
 * --out must be outside the repo: it holds ask titles and summaries written from Reddit posts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { claudeCli } from './claudeCli.ts';
import type { Ask } from './run.ts';
import { ASK_RETRIEVAL_SQL, ASK_SETTINGS, askParams, type AskWeights, type RankedAsk } from '../../whatsapp/books/askRetrieval.ts';
import { buildParsePrompt, parseRequest, type BookRequest } from '../../whatsapp/books/recommendBooks.ts';
import { openSqliteBookCatalog } from '../../whatsapp/books/sqliteBookCatalog.ts';
import type { AskQuery } from '../../whatsapp/books/bookCatalog.ts';

const JUDGE_MODEL = 'claude-opus-5-5';
const TOP = 5;

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    out: { type: 'string' },
    'parse-model': { type: 'string', default: 'claude-haiku-5-5' },
    'label-only': { type: 'boolean' },
  },
});
if (!values.db || !values.out) throw new Error('--db and --out are required');
if (path.resolve(values.out).startsWith(path.resolve(import.meta.dirname, '../..'))) {
  throw new Error('--out must be outside the repo: labels hold ask titles and summaries');
}
mkdirSync(values.out, { recursive: true });

const asks = JSON.parse(readFileSync(path.join(import.meta.dirname, 'asks.json'), 'utf8')) as Ask[];
const catalog = openSqliteBookCatalog(values.db);
const db = new DatabaseSync(values.db, { readOnly: true });
const retrieve = db.prepare(ASK_RETRIEVAL_SQL);
const describe = db.prepare(`SELECT title, summary, wanted, avoided FROM rec_asks WHERE thread_id = ?`);

const parsesFile = path.join(values.out, 'parses.json');
const parses: Record<string, BookRequest | null> = existsSync(parsesFile) ? JSON.parse(readFileSync(parsesFile, 'utf8')) : {};
const genres = catalog.genres();
const vocabulary = catalog.vocabulary();
for (const a of asks) {
  if (a.id in parses) continue;
  const reply = await claudeCli(buildParsePrompt(a.ask, genres, vocabulary), values['parse-model']!);
  parses[a.id] = parseRequest(reply.text, genres, vocabulary);
  writeFileSync(parsesFile, JSON.stringify(parses, null, 1));
  console.error(`parsed ${a.id}: ${JSON.stringify(parses[a.id])}`);
}

const ids = (names: string[]) => names.flatMap((n) => catalog.find(n)?.id ?? []);
const queries = new Map<string, AskQuery>(asks.flatMap((a) => {
  const r = parses[a.id];
  return r ? [[a.id, { likes: ids(r.anchors), unlikes: ids(r.unlike ?? []), wants: r.tags, avoids: r.avoidTags ?? [], text: a.ask }]] : [];
}));

const grid: AskWeights[] = [];
for (const seed of [0, 1, 2, 3, 4, 6]) for (const tag of [0, 0.5, 1, 2, 3]) for (const text of [0, 0.5, 1, 1.5, 2, 3]) {
  if (seed + tag + text) grid.push({ seed, tag, text });
}
const top = (q: AskQuery, weights: AskWeights, limit = TOP) =>
  retrieve.all(askParams(q, { weights, asks: limit, minScore: 0 })) as RankedAsk[];

type Label = { ask: string; thread: string; rel: number };
const labelsFile = path.join(values.out, 'labels.jsonl');
const labels = new Map<string, number>();
const key = (ask: string, thread: string) => `${ask} ${thread}`;
if (existsSync(labelsFile)) {
  for (const l of readFileSync(labelsFile, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as Label)) labels.set(key(l.ask, l.thread), l.rel);
}

for (const a of asks) {
  const q = queries.get(a.id);
  if (!q) continue;
  const pool = new Set(grid.flatMap((w) => top(q, w).map((r) => r.threadId)));
  const todo = [...pool].filter((t) => !labels.has(key(a.id, t)));
  if (!todo.length) continue;
  const listed = todo.map((t, i) => ({ n: i + 1, ...(describe.get(t) as object) }));
  const prompt = `A reader asked a book-recommendation bot the request below. The bot looks up past r/Fantasy threads where someone asked for something similar, and recommends what Redditors answered there. Rate each past thread for this reader:
2 = asks for essentially what this reader wants: its answers would suit them;
1 = related: some answers would suit them;
0 = a different ask: its answers would mostly not suit them (wrong audience, wrong mood, only shares a book name).

Reply with one JSON object only: {"ratings": [{"n": number, "rel": 0|1|2}]}, one entry per thread.

Request: ${JSON.stringify(a.ask)}${a.note ? `\nWhat the request means: ${a.note}` : ''}
Past threads: ${JSON.stringify(listed)}`;
  const reply = await claudeCli(prompt, JUDGE_MODEL);
  const ratings = (JSON.parse(reply.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { ratings?: { n: number; rel: number }[] }).ratings ?? [];
  for (const r of ratings) {
    const thread = todo[r.n - 1];
    if (!thread || ![0, 1, 2].includes(r.rel)) continue;
    labels.set(key(a.id, thread), r.rel);
    appendFileSync(labelsFile, JSON.stringify({ ask: a.id, thread, rel: r.rel }) + '\n');
  }
  console.error(`labelled ${a.id}: ${ratings.length}/${todo.length} ($${reply.costUsd?.toFixed(3)})`);
}
if (values['label-only']) process.exit(0);

const rel = (ask: string, thread: string) => labels.get(key(ask, thread)) ?? 0;
const dcg = (gains: number[]) => gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);

function evaluate(w: AskWeights) {
  let ndcg = 0;
  let judged = 0;
  let junk = 0;
  let shown = 0;
  for (const [id, q] of queries) {
    const known = [...labels].filter(([k]) => k.startsWith(`${id} `)).map(([, v]) => v).sort((a, b) => b - a);
    const got = top(q, w, 3).map((r) => rel(id, r.threadId));
    shown += got.length;
    junk += got.filter((g) => g === 0).length;
    const ideal = dcg(known.slice(0, 3));
    if (!ideal) continue;
    judged += 1;
    ndcg += dcg(got) / ideal;
  }
  return { ndcg: ndcg / judged, junk: junk / (shown || 1), judged };
}

const results = grid.map((w) => ({ w, ...evaluate(w) })).sort((a, b) => b.ndcg - a.ndcg || a.junk - b.junk);
const fmt = (r: (typeof results)[number]) => `seed ${r.w.seed} tag ${r.w.tag} text ${r.w.text}: nDCG@3 ${r.ndcg.toFixed(3)}, top-3 rated 0 ${(100 * r.junk).toFixed(0)}% (${r.judged} asks)`;
console.log(`labels: ${labels.size}; bench asks with a query: ${queries.size}`);
console.log(`S8 default  ${fmt({ w: ASK_SETTINGS.weights, ...evaluate(ASK_SETTINGS.weights) })}`);
for (const r of results.slice(0, 15)) console.log(`            ${fmt(r)}`);

/** For the best and the default weights: ratings by rank, and by score band, to set how many asks to pool and the floor. */
for (const w of [results[0]!.w, ASK_SETTINGS.weights]) {
  const byRank = Array.from({ length: TOP }, () => [0, 0, 0]);
  const scored: { score: number; rel: number }[] = [];
  for (const [id, q] of queries) top(q, w).forEach((r, i) => {
    byRank[i]![rel(id, r.threadId)]! += 1;
    scored.push({ score: r.score, rel: rel(id, r.threadId) });
  });
  console.log(`\n${JSON.stringify(w)}: ratings 0/1/2 by rank`);
  byRank.forEach((c, i) => console.log(`  rank ${i + 1}: ${c.join('/')}`));
  const bands = [0, 0.5, 1, 1.5, 2, 3, 4, 6, Infinity];
  for (let i = 0; i < bands.length - 1; i++) {
    const inBand = scored.filter((s) => s.score >= bands[i]! && s.score < bands[i + 1]!);
    if (inBand.length) console.log(`  score ${bands[i]}–${bands[i + 1]}: ${[0, 1, 2].map((g) => inBand.filter((s) => s.rel === g).length).join('/')}`);
  }
}
