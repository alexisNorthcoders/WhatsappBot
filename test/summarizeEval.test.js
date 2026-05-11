import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripMarkdownJsonFence,
  validateSummarizeEvalJson,
} from '../eval/summarize/lib/validateModelOutput.js';
import { scoreGoldAgainstOutput } from '../eval/summarize/lib/scoreGold.js';
import { listFixtureGoldPairs } from '../eval/summarize/lib/loadFiles.js';
import { runSummarizeEvalOnce, runSummarizeEvalAll } from '../eval/summarize/lib/runEval.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pangolinFixture = path.join(here, '..', 'eval', 'summarize', 'fixtures', 'pangolin.fixture.json');
const pangolinGold = path.join(here, '..', 'eval', 'summarize', 'gold', 'pangolin.gold.json');

const FIXTURE_TEXT =
  'Alpha evidence about bravo. Charlie and delta appear in one sentence together.';

describe('stripMarkdownJsonFence', () => {
  it('removes a fenced JSON block', () => {
    const inner = '{"bullets":[]}';
    const wrapped = '```json\n' + inner + '\n```';
    assert.equal(stripMarkdownJsonFence(wrapped), inner);
  });
});

describe('validateSummarizeEvalJson', () => {
  it('accepts valid bullets with grounded evidence_quote', () => {
    const raw = JSON.stringify({
      bullets: [
        { text: 't', evidence_quote: 'Alpha evidence' },
        { text: 'u', evidence_quote: 'Charlie and delta' },
      ],
    });
    const v = validateSummarizeEvalJson(raw, FIXTURE_TEXT);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.value.bullets.length, 2);
  });

  it('rejects when evidence_quote is not a substring of fixture text', () => {
    const raw = JSON.stringify({
      bullets: [{ text: 't', evidence_quote: 'not in article' }],
    });
    const v = validateSummarizeEvalJson(raw, FIXTURE_TEXT);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(
        v.errors.some((e) => e.includes('not a substring')),
        JSON.stringify(v.errors),
      );
    }
  });

  it('rejects non-JSON', () => {
    const v = validateSummarizeEvalJson('not json', FIXTURE_TEXT);
    assert.equal(v.ok, false);
  });

  it('rejects bullets missing evidence_quote', () => {
    const raw = JSON.stringify({
      bullets: [{ text: 'only text' }],
    });
    const v = validateSummarizeEvalJson(raw, FIXTURE_TEXT);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.errors.some((e) => e.includes('evidence_quote')), JSON.stringify(v.errors));
    }
  });

  it('rejects malformed bullet entries that are not objects', () => {
    const raw = JSON.stringify({ bullets: ['not an object'] });
    const v = validateSummarizeEvalJson(raw, FIXTURE_TEXT);
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.errors.some((e) => e.includes('must be an object')), JSON.stringify(v.errors));
    }
  });

  it('accepts JSON wrapped in a markdown ```json fence', () => {
    const inner = JSON.stringify({
      bullets: [{ text: 't', evidence_quote: 'Alpha evidence' }],
    });
    const fenced = '```json\n' + inner + '\n```';
    const v = validateSummarizeEvalJson(fenced, FIXTURE_TEXT);
    assert.equal(v.ok, true);
  });
});

describe('scoreGoldAgainstOutput', () => {
  const goldAny = {
    fixtureId: 'x',
    facts: [
      {
        id: 'f1',
        acceptableEvidenceSubstrings: ['Asia', 'Moon'],
      },
    ],
  };

  it('mode any: one matching substring suffices', () => {
    const out = {
      bullets: [{ text: 'a', evidence_quote: 'found in Asia here' }],
    };
    const s = scoreGoldAgainstOutput(out, goldAny);
    assert.equal(s.coveredFacts, 1);
    assert.equal(s.percent, 100);
  });

  it('mode all: requires all substrings on the same evidence_quote', () => {
    const goldAll = {
      fixtureId: 'x',
      facts: [
        {
          id: 'compound',
          mode: 'all',
          acceptableEvidenceSubstrings: ['Charlie', 'delta'],
        },
      ],
    };
    const ok = {
      bullets: [{ text: 'a', evidence_quote: 'Charlie and delta appear in one sentence together.' }],
    };
    const sOk = scoreGoldAgainstOutput(ok, goldAll);
    assert.equal(sOk.coveredFacts, 1);

    const split = {
      bullets: [
        { text: 'a', evidence_quote: 'Charlie is here' },
        { text: 'b', evidence_quote: 'delta elsewhere' },
      ],
    };
    const sBad = scoreGoldAgainstOutput(split, goldAll);
    assert.equal(sBad.coveredFacts, 0);
  });
});

describe('listFixtureGoldPairs', () => {
  it('throws when a fixture file has no matching gold file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ev-fix-'));
    const fixtures = path.join(root, 'fx');
    const golds = path.join(root, 'gd');
    mkdirSync(fixtures);
    mkdirSync(golds);
    writeFileSync(
      path.join(fixtures, 'a.fixture.json'),
      JSON.stringify({ id: 'a', extractedText: 'x' }),
    );
    assert.throws(() => listFixtureGoldPairs(fixtures, golds), /missing gold|inconsistent/);
  });

  it('throws when a gold file has no matching fixture', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ev-gold-'));
    const fixtures = path.join(root, 'fx');
    const golds = path.join(root, 'gd');
    mkdirSync(fixtures);
    mkdirSync(golds);
    writeFileSync(
      path.join(golds, 'orphan.gold.json'),
      JSON.stringify({ fixtureId: 'orphan', facts: [] }),
    );
    assert.throws(() => listFixtureGoldPairs(fixtures, golds), /orphan gold|inconsistent/);
  });

  it('returns sorted pairs when fixture and gold stems match', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ev-pair-'));
    const fixtures = path.join(root, 'fx');
    const golds = path.join(root, 'gd');
    mkdirSync(fixtures);
    mkdirSync(golds);
    writeFileSync(
      path.join(fixtures, 'b.fixture.json'),
      JSON.stringify({ id: 'b', extractedText: 'x' }),
    );
    writeFileSync(
      path.join(fixtures, 'a.fixture.json'),
      JSON.stringify({ id: 'a', extractedText: 'y' }),
    );
    writeFileSync(path.join(golds, 'b.gold.json'), JSON.stringify({ fixtureId: 'b', facts: [] }));
    writeFileSync(path.join(golds, 'a.gold.json'), JSON.stringify({ fixtureId: 'a', facts: [] }));
    const pairs = listFixtureGoldPairs(fixtures, golds);
    assert.deepEqual(
      pairs.map((p) => p.stem),
      ['a', 'b'],
    );
  });
});

describe('runSummarizeEvalOnce (mocked LLM, no network)', () => {
  it('scores gold facts when the model returns valid JSON', async () => {
    const good = JSON.stringify({
      bullets: [
        {
          text: 'Pangolins live in two continents.',
          evidence_quote:
            'Pangolins are scaly mammals found in Asia and Africa. They eat ants and termites',
        },
        {
          text: 'They are threatened by trade.',
          evidence_quote: 'illegal trafficking',
        },
      ],
    });

    /** @type {typeof import('../models/models.js').deepInfraAPI} */
    async function fakeLlm() {
      return good;
    }

    const r = await runSummarizeEvalOnce({
      fixturePath: pangolinFixture,
      goldPath: pangolinGold,
      model: 'test/model',
      temperature: 0,
      deepInfraAPI: fakeLlm,
    });

    assert.equal(r.validation.ok, true);
    assert.ok(r.coverage);
    if (r.coverage) {
      assert.equal(r.coverage.totalFacts, 3);
      assert.equal(r.coverage.coveredFacts, 3);
      assert.equal(r.coverage.percent, 100);
    }
  });

  it('runSummarizeEvalAll aggregates overall fact coverage', async () => {
    const good = JSON.stringify({
      bullets: [
        {
          text: 'Pangolins live in two continents.',
          evidence_quote:
            'Pangolins are scaly mammals found in Asia and Africa. They eat ants and termites',
        },
        {
          text: 'They are threatened by trade.',
          evidence_quote: 'illegal trafficking',
        },
      ],
    });

    /** @type {typeof import('../models/models.js').deepInfraAPI} */
    async function fakeLlm() {
      return good;
    }

    const result = await runSummarizeEvalAll({
      pairs: [
        {
          stem: 'pangolin',
          fixturePath: pangolinFixture,
          goldPath: pangolinGold,
        },
      ],
      model: 'test/model',
      temperature: 0,
      deepInfraAPI: fakeLlm,
    });

    assert.equal(result.overall.totalFacts, 3);
    assert.equal(result.overall.coveredFacts, 3);
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].validation.ok, true);
  });

  it('runSummarizeEvalAll propagates when gold file path does not exist', async () => {
    /** @type {typeof import('../models/models.js').deepInfraAPI} */
    async function fakeLlm() {
      return '{}';
    }
    await assert.rejects(
      runSummarizeEvalAll({
        pairs: [
          {
            stem: 'missing',
            fixturePath: pangolinFixture,
            goldPath: path.join(here, 'nonexistent-dir', 'nope.gold.json'),
          },
        ],
        model: 'test/model',
        deepInfraAPI: fakeLlm,
      }),
      /ENOENT|no such file/i,
    );
  });

  it('runSummarizeEvalOnce throws when gold fixtureId mismatches fixture id', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ev-mismatch-'));
    const badGold = path.join(root, 'wrong.gold.json');
    writeFileSync(
      badGold,
      JSON.stringify({
        fixtureId: 'not-pangolin',
        facts: [],
      }),
    );

    /** @type {typeof import('../models/models.js').deepInfraAPI} */
    async function fakeLlm() {
      return '{}';
    }

    await assert.rejects(
      runSummarizeEvalOnce({
        fixturePath: pangolinFixture,
        goldPath: badGold,
        model: 'm',
        deepInfraAPI: fakeLlm,
      }),
      /does not match fixture id/,
    );
  });
});
