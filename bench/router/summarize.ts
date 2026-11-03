/** Usage: node bench/router/summarize.ts results/a.jsonl [results/b.jsonl …] */
import { readFileSync } from 'node:fs';
import { summarize } from './score.ts';
import type { ResultRow } from './score.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node bench/router/summarize.ts <results.jsonl>…');
  process.exit(2);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]) : NaN;
};

const table: string[][] = [
  ['run', 'calls', 'err', 'route acc', 'near-miss', 'fast ok/wrong/missed', 'warm p50', 'warm p95', 'uncached p50'],
];
for (const file of files) {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.type === 'meta');
  const rows: ResultRow[] = lines.filter((l) => l.type === 'call');
  console.log(`=== ${meta?.label ?? file} (${file})\n${summarize(rows)}\n`);

  const ok = rows.filter((r) => !r.error);
  const share = (rs: ResultRow[]) =>
    rs.length ? `${((100 * rs.filter((r) => r.routeOk).length) / rs.length).toFixed(1)}%` : '-';
  const count = (o: string) => ok.filter((r) => r.lights === o).length;
  const wall = (phase: string) => ok.filter((r) => r.phase === phase).map((r) => r.wallMs);
  table.push([
    meta?.label ?? file,
    String(rows.length),
    String(rows.length - ok.length),
    share(rows),
    share(rows.filter((r) => r.kind === 'near-miss')),
    `${count('fast-correct')}/${count('fast-wrong')}/${count('missed')}`,
    String(pct(wall('warm'), 0.5)),
    String(pct(wall('warm'), 0.95)),
    String(pct(wall('uncached'), 0.5)),
  ]);
}

if (files.length > 1) {
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const r of table) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
}
