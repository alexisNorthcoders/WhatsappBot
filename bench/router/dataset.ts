import { readFileSync } from 'node:fs';
import { ROUTE_CRITERIA } from '../../whatsapp/orchestration/jevRouter.ts';

export type Route = keyof typeof ROUTE_CRITERIA;

/** Expected lights sub-answers, as the option keys `lightsJevQuestions` offers. */
export type LightsExpectation = {
  action: 'on' | 'off' | 'brightness' | 'colour' | 'list' | 'other';
  target?: string;
  brightness?: '1' | '25' | '50' | '75' | '100';
  colour?: string;
};

export type Row = {
  id: string;
  text: string;
  route: Route;
  kind: 'core' | 'near-miss';
  lights?: LightsExpectation;
};

export type SnapshotLight = {
  id: string;
  name: string;
  room: string;
  state: string;
};

const ROUTES = new Set(Object.keys(ROUTE_CRITERIA));
const PROMPT_EXAMPLES = new Set(Object.values(ROUTE_CRITERIA).flatMap((c) => c.examples.map((e) => e.toLowerCase())));

export function loadLights(path: string): SnapshotLight[] {
  const lights = JSON.parse(readFileSync(path, 'utf8')) as Omit<SnapshotLight, 'state'>[];
  return lights.map((L) => ({ ...L, state: 'OFF' }));
}

/** Throws on a row the scorer can't trust: unknown route, a prompt example reused, an unknown light target. */
export function loadDataset(path: string, lights: SnapshotLight[]): Row[] {
  const targets = new Set([
    'all',
    'unclear',
    ...lights.map((L) => `room:${L.room}`),
    ...lights.map((L) => `light:${L.id}`),
  ]);
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);
  const ids = new Set<string>();
  for (const row of rows) {
    const where = `${path} ${row.id}`;
    if (ids.has(row.id)) throw new Error(`${where}: duplicate id`);
    ids.add(row.id);
    if (!ROUTES.has(row.route)) throw new Error(`${where}: unknown route ${row.route}`);
    if (PROMPT_EXAMPLES.has(row.text.toLowerCase())) throw new Error(`${where}: text is a ROUTE_CRITERIA example`);
    if (row.lights?.target && !targets.has(row.lights.target))
      throw new Error(`${where}: unknown light target ${row.lights.target}`);
    if (row.lights && row.route !== 'lights') throw new Error(`${where}: lights expectation on a ${row.route} row`);
  }
  return rows;
}
