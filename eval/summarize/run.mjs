#!/usr/bin/env node
/**
 * Manual summarize eval runner: offline fixture text + gold facts, optional DeepInfra call.
 *
 * Usage:
 *   node eval/summarize/run.mjs --fixture eval/summarize/fixtures/pangolin.fixture.json \\
 *     --gold eval/summarize/gold/pangolin.gold.json --model deepseek-ai/DeepSeek-V3 --temperature 0.2
 *
 *   node eval/summarize/run.mjs --all --model deepseek-ai/DeepSeek-V3
 *
 * DEEPINFRA_API_KEY is required only when this script calls the live DeepInfra API (pairing and
 * directory checks run without it). Tests mock the API and do not need network or a key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { deepInfraAPI, DEEPINFRA_DEFAULT_CHAT_MODEL } from '../../models/models.js';
import { listFixtureGoldPairs } from './lib/loadFiles.js';
import { runSummarizeEvalOnce, runSummarizeEvalAll } from './lib/runEval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultFixturesDir = path.join(__dirname, 'fixtures');
const defaultGoldsDir = path.join(__dirname, 'gold');

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') {
      out.all = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function printRun(/** @type {any} */ r) {
  console.log(`\n--- fixture: ${r.fixtureId} (${r.stem ?? 'single'}) ---`);
  console.log(`model: ${r.model}  temperature: ${r.temperature ?? 'default'}`);
  if (!r.validation.ok) {
    console.log('validation: FAIL');
    for (const e of r.validation.errors) console.log(`  - ${e}`);
    return;
  }
  console.log('validation: OK (JSON + evidence_quote substrings of fixture text)');
  if (r.coverage) {
    console.log(
      `fact coverage: ${r.coverage.coveredFacts}/${r.coverage.totalFacts} (${r.coverage.percent.toFixed(1)}%)`,
    );
    for (const f of r.coverage.facts) {
      console.log(`  - [${f.covered ? 'x' : ' '}] ${f.id}: ${f.detail}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const all = args.all === true;
  const fixture = typeof args.fixture === 'string' ? args.fixture : null;
  const gold = typeof args.gold === 'string' ? args.gold : null;
  const model =
    typeof args.model === 'string' ? args.model : DEEPINFRA_DEFAULT_CHAT_MODEL;
  const extraFocus = typeof args.extra === 'string' ? args.extra : '';

  let tempOpt = undefined;
  if (typeof args.temperature === 'string') {
    const t = parseFloat(args.temperature);
    if (Number.isFinite(t)) tempOpt = t;
  }

  if (all) {
    const fixturesDir =
      typeof args['fixtures-dir'] === 'string' ? args['fixtures-dir'] : defaultFixturesDir;
    const goldsDir = typeof args['golds-dir'] === 'string' ? args['golds-dir'] : defaultGoldsDir;
    const pairs = listFixtureGoldPairs(path.resolve(fixturesDir), path.resolve(goldsDir));
    if (pairs.length === 0) {
      console.error(`No *.fixture.json files in ${fixturesDir}`);
      process.exitCode = 1;
      return;
    }
    const result = await runSummarizeEvalAll({
      pairs,
      model,
      temperature: tempOpt,
      extraFocus,
      deepInfraAPI,
    });
    for (const r of result.runs) printRun(r);
    console.log('\n=== overall (validated runs only) ===');
    console.log(
      `facts: ${result.overall.coveredFacts}/${result.overall.totalFacts} (${result.overall.percent.toFixed(1)}%)`,
    );
    return;
  }

  if (fixture && gold) {
    const r = await runSummarizeEvalOnce({
      fixturePath: path.resolve(fixture),
      goldPath: path.resolve(gold),
      model,
      temperature: tempOpt,
      extraFocus,
      deepInfraAPI,
    });
    printRun({ ...r, stem: 'single' });
    if (r.validation.ok && r.coverage) {
      console.log('\n=== summary ===');
      console.log(
        `fact coverage: ${r.coverage.coveredFacts}/${r.coverage.totalFacts} (${r.coverage.percent.toFixed(1)}%)`,
      );
    }
    return;
  }

  console.error(
    'Provide --fixture and --gold, or use --all (see eval/summarize/run.mjs header comment).',
  );
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exitCode = 1;
});
