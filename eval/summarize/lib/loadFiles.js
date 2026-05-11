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
 * Every `*.fixture.json` must have a same-stem `*.gold.json`, and vice versa.
 * @param {string} fixturesDir
 * @param {string} goldsDir
 * @throws {Error} when directories are unreadable or the fixture/gold sets disagree
 */
export function listFixtureGoldPairs(fixturesDir, goldsDir) {
  let fixtureNames;
  let goldNames;
  try {
    fixtureNames = readdirSync(fixturesDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot read fixtures directory ${fixturesDir}: ${msg}`);
  }
  try {
    goldNames = readdirSync(goldsDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot read gold directory ${goldsDir}: ${msg}`);
  }

  /** @type {Map<string, string>} stem -> fixture filename */
  const fixtureByStem = new Map();
  for (const name of fixtureNames) {
    const m = /^(.+)\.fixture\.json$/.exec(name);
    if (!m) continue;
    fixtureByStem.set(m[1], name);
  }

  /** @type {Set<string>} */
  const goldStems = new Set();
  for (const name of goldNames) {
    const m = /^(.+)\.gold\.json$/.exec(name);
    if (!m) continue;
    goldStems.add(m[1]);
  }

  /** @type {string[]} */
  const problems = [];
  for (const stem of fixtureByStem.keys()) {
    if (!goldStems.has(stem)) {
      problems.push(
        `missing gold: "${stem}.fixture.json" in ${fixturesDir} has no matching "${stem}.gold.json" in ${goldsDir}`,
      );
    }
  }
  for (const stem of goldStems) {
    if (!fixtureByStem.has(stem)) {
      problems.push(
        `orphan gold: "${stem}.gold.json" in ${goldsDir} has no matching "${stem}.fixture.json" in ${fixturesDir}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Fixture/gold pairing is inconsistent (${problems.length} issue(s)):\n- ${problems.join('\n- ')}`,
    );
  }

  /** @type {Array<{ stem: string; fixturePath: string; goldPath: string }>} */
  const out = [];
  for (const [stem, name] of fixtureByStem) {
    const fixturePath = path.join(fixturesDir, name);
    const goldPath = path.join(goldsDir, `${stem}.gold.json`);
    out.push({ stem, fixturePath, goldPath });
  }

  out.sort((a, b) => a.stem.localeCompare(b.stem));
  return out;
}
