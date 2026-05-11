import { buildSummarizeEvalPrompt } from './buildEvalPrompt.js';
import { truncateExtractedText } from './maxInputChars.js';
import { validateSummarizeEvalJson } from './validateModelOutput.js';
import { scoreGoldAgainstOutput } from './scoreGold.js';
import { loadFixture, loadGold } from './loadFiles.js';

/**
 * @param {{
 *   fixturePath: string;
 *   goldPath: string;
 *   model: string;
 *   temperature?: number;
 *   extraFocus?: string;
 *   deepInfraAPI: typeof import('../../../models/models.js').deepInfraAPI;
 *   signal?: AbortSignal;
 * }} opts
 */
export async function runSummarizeEvalOnce(opts) {
  const fixture = loadFixture(opts.fixturePath);
  const gold = loadGold(opts.goldPath);

  if (gold.fixtureId !== fixture.id) {
    throw new Error(
      `Gold fixtureId "${gold.fixtureId}" does not match fixture id "${fixture.id}"`,
    );
  }

  const forModel = truncateExtractedText(fixture.extractedText);
  const prompt = buildSummarizeEvalPrompt(forModel, opts.extraFocus ?? '');

  const raw = await opts.deepInfraAPI(prompt, opts.model, {
    temperature: opts.temperature,
    signal: opts.signal,
  });

  const rawString = typeof raw === 'string' ? raw : String(raw ?? '');
  const validation = validateSummarizeEvalJson(rawString, fixture.extractedText);

  if (!validation.ok) {
    return {
      fixtureId: fixture.id,
      model: opts.model,
      temperature: opts.temperature ?? null,
      rawModelOutput: rawString,
      validation,
      coverage: null,
    };
  }

  const coverage = scoreGoldAgainstOutput(validation.value, gold);

  return {
    fixtureId: fixture.id,
    model: opts.model,
    temperature: opts.temperature ?? null,
    rawModelOutput: rawString,
    validation,
    coverage,
  };
}

/**
 * @param {{
 *   pairs: Array<{ stem: string; fixturePath: string; goldPath: string }>;
 *   model: string;
 *   temperature?: number;
 *   extraFocus?: string;
 *   deepInfraAPI: typeof import('../../../models/models.js').deepInfraAPI;
 *   signal?: AbortSignal;
 * }} opts
 */
export async function runSummarizeEvalAll(opts) {
  /** @type {Awaited<ReturnType<typeof runSummarizeEvalOnce>>[]} */
  const runs = [];

  let totalFacts = 0;
  let coveredFacts = 0;

  for (const p of opts.pairs) {
    const one = await runSummarizeEvalOnce({
      fixturePath: p.fixturePath,
      goldPath: p.goldPath,
      model: opts.model,
      temperature: opts.temperature,
      extraFocus: opts.extraFocus,
      deepInfraAPI: opts.deepInfraAPI,
      signal: opts.signal,
    });

    runs.push({
      ...one,
      stem: p.stem,
    });

    if (one.coverage) {
      totalFacts += one.coverage.totalFacts;
      coveredFacts += one.coverage.coveredFacts;
    }
  }

  const overallPercent = totalFacts === 0 ? 100 : (coveredFacts / totalFacts) * 100;

  return {
    runs,
    overall: {
      totalFacts,
      coveredFacts,
      percent: overallPercent,
    },
  };
}
