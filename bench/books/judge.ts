/**
 * Scores run.ts output with an Opus judge (tool-less `claude -p`, dev machine only) and prints a
 * summary table; with several files, one column per file.
 *
 *   node bench/books/judge.ts <run.jsonl>...        # judges lines not yet judged, then summarises
 *   node bench/books/judge.ts --summary-only <run.jsonl>...
 *
 * Verdicts go to <run>.judged.jsonl next to each run file, so a rerun only judges what's missing.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { claudeCli } from './claudeCli.ts';
import type { Ask, RunLine } from './run.ts';
import { communityLine } from '../../whatsapp/books/recommendBooks.ts';

const JUDGE_MODEL = 'claude-opus-5-5';
const DIMENSIONS = ['fit', 'variety', 'grounding'] as const;
type Verdict = { id: string; fit: number; variety: number; grounding: number; why: string };

const asks = new Map(
  (JSON.parse(readFileSync(path.join(import.meta.dirname, 'asks.json'), 'utf8')) as Ask[]).map((a) => [a.id, a]),
);

export function buildJudgePrompt(line: RunLine, ask: Ask) {
  const picked = new Set(line.picks.map((p) => p.id));
  const evidence = line.shortlist
    .filter((c) => picked.has(c.id))
    .map((c) => ({ title: c.title, author: c.author, kind: c.kind, mentions: c.mentions, positive: c.positive, negative: c.negative, what_redditors_said: c.excerpts, dossier: c.dossier, answered_in_similar_asks: c.answered ? communityLine(c.answered) : undefined }));
  return `You grade a fantasy book recommender. A reader sent the request below; the bot replied with up to three picks drawn from r/Fantasy discussion. Score the reply 1-5 on each dimension, using your own knowledge of the books:

- fit: do the picks suit THIS request, including every modifier ("but darker", "standalone", "less romance") and exclusion? Picks the reader named or obviously already knows, or by an excluded author, cost heavily. A reply with no picks scores 1 unless the request is truly unanswerable.
- variety: are the picks distinct from each other (not the same author, not a Series plus its own Book, not three near-identical choices)? One pick scores at most 2; no picks scores 1.
- grounding: are the stated reasons accurate about the books and supported by the evidence shown (what Redditors said, the dossier)? Invented or wrong claims cost heavily. No picks scores 1.

Reply with one JSON object only: {"fit": n, "variety": n, "grounding": n, "why": "one or two sentences"}

Request: ${JSON.stringify(ask.ask)}${ask.note ? `\nWhat the request means: ${ask.note}` : ''}
Reply: ${JSON.stringify(line.answer ?? `(error: ${line.error})`)}
Evidence the bot had for its picks: ${JSON.stringify(evidence)}`;
}

function parseVerdict(id: string, raw: string): Verdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const ok = DIMENSIONS.every((d) => Number.isInteger(j[d]) && j[d] >= 1 && j[d] <= 5);
    return ok ? { id, fit: j.fit, variety: j.variety, grounding: j.grounding, why: String(j.why ?? '') } : null;
  } catch {
    return null;
  }
}

const readJsonl = <T>(file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [];

const { values, positionals: files } = parseArgs({ options: { 'summary-only': { type: 'boolean' } }, allowPositionals: true });
const judgedFile = (f: string) => f.replace(/\.jsonl$/, '.judged.jsonl');

for (const file of files) {
  if (values['summary-only']) break;
  const done = new Set(readJsonl<Verdict>(judgedFile(file)).map((v) => v.id));
  for (const line of readJsonl<RunLine & { settings?: unknown }>(file)) {
    if (line.settings || done.has(line.id)) continue;
    const ask = asks.get(line.id);
    if (!ask) continue;
    try {
      const r = await claudeCli(buildJudgePrompt(line, ask), JUDGE_MODEL);
      const v = parseVerdict(line.id, r.text);
      if (!v) throw new Error(`unparseable verdict: ${r.text.slice(0, 200)}`);
      appendFileSync(judgedFile(file), JSON.stringify(v) + '\n');
      console.error(`${path.basename(file)} ${line.id}: ${v.fit}/${v.variety}/${v.grounding} ${v.why}`);
    } catch (err) {
      console.error(`${path.basename(file)} ${line.id}: judge failed: ${(err as Error).message}`);
    }
  }
}

/** Mean of the numbers, to one decimal. */
const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '–');

const columns = files.map((file) => {
  const runs = readJsonl<RunLine & { settings?: unknown }>(file).filter((l) => !l.settings);
  const verdicts = new Map(readJsonl<Verdict>(judgedFile(file)).map((v) => [v.id, v]));
  return { name: path.basename(file, '.jsonl'), runs, verdicts };
});
const kinds = [...new Set([...asks.values()].map((a) => a.kind))];
const rows: [string, (c: (typeof columns)[number]) => string][] = [
  ['asks judged', (c) => `${c.verdicts.size}/${c.runs.length}`],
  ...DIMENSIONS.map((d) => [d, (c: (typeof columns)[number]) => mean([...c.verdicts.values()].map((v) => v[d]))] as [string, (c: (typeof columns)[number]) => string]),
  ['overall', (c) => mean([...c.verdicts.values()].map((v) => (v.fit + v.variety + v.grounding) / 3))],
  ...kinds.map((k) => [`  ${k} (overall)`, (c: (typeof columns)[number]) =>
    mean([...c.verdicts.values()].filter((v) => asks.get(v.id)?.kind === k).map((v) => (v.fit + v.variety + v.grounding) / 3))] as [string, (c: (typeof columns)[number]) => string]),
  ['answers with <3 picks', (c) => String(c.runs.filter((r) => r.picks.length < 3).length)],
  ['errors', (c) => String(c.runs.filter((r) => r.error).length)],
  ['median ms per ask', (c) => String(c.runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(c.runs.length / 2)] ?? '–')],
  ['model calls failed', (c) => String(c.runs.flatMap((r) => r.calls).filter((x) => !x.ok).length)],
];
console.log(`| | ${columns.map((c) => c.name).join(' | ')} |\n|---|${columns.map(() => '---').join('|')}|`);
for (const [label, f] of rows) console.log(`| ${label} | ${columns.map(f).join(' | ')} |`);
