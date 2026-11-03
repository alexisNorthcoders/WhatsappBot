import { runLightsFromJev } from '../../whatsapp/agents/lightsJev.ts';
import type { JevAnswer } from '../../whatsapp/agents/lightsJev.ts';
import type { CallRecord } from './backends.ts';
import type { LightsExpectation, Row, SnapshotLight } from './dataset.ts';

/**
 * fast-correct: the fast path drove Hue exactly as the ideal answers would.
 * fast-wrong: it drove Hue, but not as the ideal answers would (or shouldn't have at all).
 * missed: the ideal answers take the fast path but these handed over to GPT (safe, slower).
 * handoff-correct: both hand over to GPT.
 * not-routed: the route wasn't lights, so the fast path never ran.
 */
export type LightsOutcome = 'fast-correct' | 'fast-wrong' | 'missed' | 'handoff-correct' | 'not-routed';

export type Phase = 'warm' | 'uncached';

export type ResultRow = {
  type: 'call';
  phase: Phase;
  rep: number;
  id: string;
  text: string;
  kind: Row['kind'];
  expected: string;
  /** after the bot's minProbability cutoff; null when the router returned null (error/timeout) */
  agent: string | null;
  choice: string | null;
  probability: number | null;
  routeOk: boolean;
  lights: LightsOutcome | null;
  /** lights sub-question id → chose the expected option (target compared by the lights it names) */
  subAnswers?: Record<string, boolean>;
  /** question id → [choice, its probability] */
  answers: Record<string, [string, number]>;
  wallMs: number;
  error?: string;
  calls: CallRecord[];
};

type HueCall = unknown[];

async function simulate(
  text: string,
  answers: Record<string, JevAnswer>,
  lights: SnapshotLight[],
  minProbability: number,
) {
  const calls: HueCall[] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const reply = await runLightsFromJev(text, answers, {
    lights,
    minProbability,
    hue: {
      switchLight: rec('switchLight'),
      switchOffAllLights: rec('switchOffAllLights'),
      setLightBrightness: rec('setLightBrightness'),
      setLightColor: rec('setLightColor'),
      setLightColorTemperature: rec('setLightColorTemperature'),
    },
    logUsage: async () => {},
  });
  calls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // the reply's wording names whichever equivalent key won (room:Garden vs light:10); only list replies carry data
  return reply === null ? null : JSON.stringify(calls.length ? calls : reply);
}

function idealAnswers(e: LightsExpectation | undefined): Record<string, JevAnswer> {
  const pick = (choice: string | undefined) => (choice ? { choice, probabilities: { [choice]: 1 } } : undefined);
  const out: Record<string, JevAnswer | undefined> = {
    lights_action: pick(e?.action ?? 'other'),
    lights_target: pick(e?.target),
    lights_brightness: pick(e?.brightness),
    lights_colour: pick(e?.colour),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Record<string, JevAnswer>;
}

/** Lights named by a target key, so `room:Bedroom` and its one light `light:9` compare equal. */
function members(target: string, lights: SnapshotLight[]) {
  if (target === 'all') return lights.map((L) => L.id).join(',');
  if (target.startsWith('room:'))
    return lights
      .filter((L) => `room:${L.room}` === target)
      .map((L) => L.id)
      .join(',');
  if (target.startsWith('light:')) return target.slice('light:'.length);
  return target;
}

export async function scoreLights(
  row: Row,
  agent: string | null,
  answers: Record<string, JevAnswer>,
  lights: SnapshotLight[],
  minProbability: number,
): Promise<{
  outcome: LightsOutcome | null;
  subAnswers?: Record<string, boolean>;
}> {
  if (row.route !== 'lights' && agent !== 'lights') return { outcome: null };
  const e = row.lights;
  const subAnswers: Record<string, boolean> = {};
  // route-first never asks the lights questions after another route, so only score answers that came back
  if (e && answers.lights_action) {
    const got = (id: string) => answers[id]?.choice;
    subAnswers.lights_action = got('lights_action') === e.action;
    if (e.target) subAnswers.lights_target = members(got('lights_target') ?? '', lights) === members(e.target, lights);
    if (e.brightness) subAnswers.lights_brightness = got('lights_brightness') === e.brightness;
    if (e.colour) subAnswers.lights_colour = got('lights_colour') === e.colour;
  }
  if (agent !== 'lights') return { outcome: 'not-routed', subAnswers };

  const ideal = await simulate(row.text, idealAnswers(e), lights, minProbability);
  const actual = await simulate(row.text, answers, lights, minProbability);
  const outcome: LightsOutcome =
    actual === null
      ? ideal === null
        ? 'handoff-correct'
        : 'missed'
      : actual === ideal
        ? 'fast-correct'
        : 'fast-wrong';
  return { outcome, subAnswers };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}` : '-');
const median = (xs: number[]) => pct(xs, 0.5);

/** Prints the human summary for one run's rows. */
export function summarize(rows: ResultRow[], botTimeoutMs = 3000): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  const ok = rows.filter((r) => !r.error);

  line(`calls: ${rows.length}, errors: ${rows.length - ok.length}`);
  const errs = new Map<string, number>();
  for (const r of rows) if (r.error) errs.set(r.error, (errs.get(r.error) ?? 0) + 1);
  for (const [e, n] of errs) line(`  ${n} × ${e.slice(0, 120)}`);
  const subCalls = rows.flatMap((r) => r.calls).filter((c) => c.question.startsWith('lights_'));
  const badSub = subCalls.filter((c) => c.error);
  if (subCalls.length) line(`lights sub-question replies that weren't an option: ${badSub.length}/${subCalls.length}`);

  line('\nroute accuracy (all phases, errors count as wrong)');
  const byRoute = new Map<string, ResultRow[]>();
  for (const r of rows) byRoute.set(r.expected, [...(byRoute.get(r.expected) ?? []), r]);
  const acc = (rs: ResultRow[]) =>
    `${rs.filter((r) => r.routeOk).length}/${rs.length} (${((100 * rs.filter((r) => r.routeOk).length) / rs.length).toFixed(1)}%)`;
  line(`  overall    ${acc(rows)}`);
  line(`  core       ${acc(rows.filter((r) => r.kind === 'core'))}`);
  line(`  near-miss  ${acc(rows.filter((r) => r.kind === 'near-miss'))}`);
  for (const [route, rs] of [...byRoute].sort()) line(`  ${route.padEnd(10)} ${acc(rs)}`);

  const flips = new Map<string, Set<string | null>>();
  for (const r of rows) flips.set(r.id, (flips.get(r.id) ?? new Set()).add(r.agent));
  line(
    `  messages whose route varied across calls: ${[...flips.values()].filter((s) => s.size > 1).length}/${flips.size}`,
  );

  line('\nconfusion (expected → got, after the 0.5 cutoff)');
  const conf = new Map<string, number>();
  for (const r of ok)
    if (!r.routeOk) conf.set(`${r.expected} → ${r.agent}`, (conf.get(`${r.expected} → ${r.agent}`) ?? 0) + 1);
  for (const [k, n] of [...conf].sort((a, b) => b[1] - a[1]).slice(0, 15)) line(`  ${String(n).padStart(3)}  ${k}`);
  const wrongTexts = new Map<string, string>();
  for (const r of ok) if (!r.routeOk) wrongTexts.set(r.id, `${r.id} "${r.text}" (${r.expected} → ${r.agent})`);
  for (const t of [...wrongTexts.values()].slice(0, 25)) line(`       ${t}`);

  line('\nlights fast path');
  const outcomes = new Map<string, number>();
  for (const r of ok) if (r.lights) outcomes.set(r.lights, (outcomes.get(r.lights) ?? 0) + 1);
  for (const [k, n] of [...outcomes].sort()) line(`  ${k.padEnd(16)} ${n}`);
  for (const r of ok.filter((r) => r.lights === 'fast-wrong')) line(`    fast-wrong: ${r.id} "${r.text}"`);
  const sub = new Map<string, [number, number]>();
  for (const r of ok)
    for (const [q, good] of Object.entries(r.subAnswers ?? {})) {
      const [g, n] = sub.get(q) ?? [0, 0];
      sub.set(q, [g + (good ? 1 : 0), n + 1]);
    }
  for (const [q, [g, n]] of sub) line(`  ${q.padEnd(18)} ${g}/${n}`);

  line(`\nlatency ms (successful calls; wall = whole router call, route = the route question's own request)`);
  line(
    `  ${'phase'.padEnd(6)} ${'n'.padStart(4)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} ${'p95'.padStart(6)} ${'max'.padStart(6)}  route p50/p95   >${botTimeoutMs}ms  prompt_n/cache_n (route, median)`,
  );
  for (const phase of ['warm', 'uncached'] as const) {
    const rs = ok.filter((r) => r.phase === phase);
    if (!rs.length) continue;
    const wall = rs.map((r) => r.wallMs);
    const routeCalls = rs
      .map((r) => r.calls.find((c) => c.question === 'route' || c.question === '*'))
      .filter((c) => c !== undefined);
    const routeMs = routeCalls.map((c) => c.ms);
    const pn = routeCalls.map((c) => c.timings?.prompt_n).filter((x) => x !== undefined);
    const cn = routeCalls.map((c) => c.timings?.cache_n).filter((x) => x !== undefined);
    line(
      `  ${phase.padEnd(6)} ${String(rs.length).padStart(4)} ${ms(pct(wall, 0.5)).padStart(6)} ${ms(pct(wall, 0.9)).padStart(6)} ${ms(pct(wall, 0.95)).padStart(6)} ${ms(Math.max(...wall)).padStart(6)}  ${`${ms(median(routeMs))}/${ms(pct(routeMs, 0.95))}`.padEnd(14)} ${String(wall.filter((w) => w > botTimeoutMs).length).padStart(7)}  ${pn.length ? `${median(pn)}/${median(cn)}` : 'no timings'}`,
    );
  }
  return out.join('\n');
}
