import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @param {string} absPath
 * @returns {import('./types.js').SummarizeEvalFixture}
 */
export function loadFixture(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const j = JSON.parse(raw);
  if (j == null || typeof j !== 'object' || typeof /** @type {any} */ (j).id !== 'string') {
    throw new Error(`Invalid fixture (missing id): ${absPath}`);
  }
  if (typeof /** @type {any} */ (j).extractedText !== 'string') {
    throw new Error(`Invalid fixture (extractedText must be string): ${absPath}`);
  }
  return /** @type {import('./types.js').SummarizeEvalFixture} */ (j);
}

/**
 * @param {string} absPath
 * @returns {import('./types.js').SummarizeEvalGold}
 */
export function loadGold(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const j = JSON.parse(raw);
  if (j == null || typeof j !== 'object' || typeof /** @type {any} */ (j).fixtureId !== 'string') {
    throw new Error(`Invalid gold file (missing fixtureId): ${absPath}`);
  }
  const facts = /** @type {any} */ (j).facts;
  if (!Array.isArray(facts)) {
    throw new Error(`Invalid gold file (facts must be array): ${absPath}`);
  }
  return /** @type {import('./types.js').SummarizeEvalGold} */ (j);
}

/**
 * Pair `stem.fixture.json` with `stem.gold.json` under the given roots.
 * @param {string} fixturesDir
 * @param {string} goldsDir
 */
export function listFixtureGoldPairs(fixturesDir, goldsDir) {
  const names = readdirSync(fixturesDir);
  /** @type {Array<{ stem: string; fixturePath: string; goldPath: string }>} */
  const out = [];
  for (const name of names) {
    const m = /^(.+)\.fixture\.json$/.exec(name);
    if (!m) continue;
    const stem = m[1];
    const fixturePath = path.join(fixturesDir, name);
    const goldPath = path.join(goldsDir, `${stem}.gold.json`);
    out.push({ stem, fixturePath, goldPath });
  }
  return out;
}
