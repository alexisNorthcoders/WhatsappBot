import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, loadLights } from '../bench/router/dataset.ts';
import type { Row } from '../bench/router/dataset.ts';
import { scoreLights } from '../bench/router/score.ts';
import { renderChoicePrompt } from '../bench/router/backends.ts';
import { choiceProbability, renderLightsPrompt, renderRoutePrompt, valueSpan } from '../bench/router/structured.ts';
import { createJevRouter } from '../whatsapp/orchestration/jevRouter.ts';
import { lightsJevQuestions } from '../whatsapp/agents/lightsJev.ts';

const bench = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bench/router');
const LIGHTS = [
  { id: '9', name: 'Bedroom', room: 'Bedroom', state: 'OFF' },
  { id: '5', name: 'Office', room: 'Office', state: 'OFF' },
  { id: '12', name: 'Desk', room: 'Office', state: 'OFF' },
];
const pick = (choice: string, p = 1) => ({ choice, probabilities: { [choice]: p } });
const row = (lights: Row['lights'], route: Row['route'] = 'lights'): Row => ({
  id: 't',
  text: 'x',
  route,
  kind: 'core',
  lights,
});

describe('router bench scoring', () => {
  it('counts a single light and its one-light room as the same target', async () => {
    const r = await scoreLights(
      row({ action: 'off', target: 'room:Bedroom' }),
      'lights',
      { lights_action: pick('off'), lights_target: pick('light:9') },
      LIGHTS,
      0.7,
    );
    assert.deepEqual(r, { outcome: 'fast-correct', subAnswers: { lights_action: true, lights_target: true } });
  });

  it('marks the fast path firing on a non-lights message as fast-wrong', async () => {
    const r = await scoreLights(
      row(undefined, 'home'),
      'lights',
      { lights_action: pick('on'), lights_target: pick('all') },
      LIGHTS,
      0.7,
    );
    assert.equal(r.outcome, 'fast-wrong');
  });

  it('marks an unconfident answer that hands over to GPT as missed', async () => {
    const r = await scoreLights(
      row({ action: 'on', target: 'room:Office' }),
      'lights',
      { lights_action: pick('on'), lights_target: pick('room:Office', 0.4) },
      LIGHTS,
      0.7,
    );
    assert.equal(r.outcome, 'missed');
  });

  it('gives every lights question an option letter', () => {
    for (const q of Object.values(lightsJevQuestions(LIGHTS)))
      assert.ok(renderChoicePrompt(q, 'letters').keys.length <= 26);
  });

  it('loads the committed dataset against the committed light snapshot', () => {
    const rows = loadDataset(path.join(bench, 'dataset.jsonl'), loadLights(path.join(bench, 'lights.snapshot.json')));
    assert.ok(rows.length >= 100);
  });

  it('keeps the held-out set apart from the tuning set', () => {
    const lights = loadLights(path.join(bench, 'lights.snapshot.json'));
    const normalise = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9%@.:/ ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const tuning = new Set(loadDataset(path.join(bench, 'dataset.jsonl'), lights).map((r) => normalise(r.text)));
    const heldout = loadDataset(path.join(bench, 'heldout.jsonl'), lights);
    assert.ok(heldout.length >= 50);
    assert.deepEqual(
      heldout.filter((r) => tuning.has(normalise(r.text))).map((r) => r.id),
      [],
    );
  });

  it('scores a grammar-forced key among the allowed options, not by its raw logprob', () => {
    // qwen3-1.7b on "haircut Saturday 10am": it wanted to stop at "remind"; the grammar forced "e", "r"
    const t = (token: string, logprob: number, top: [string, number][]) => ({
      token,
      logprob,
      top_logprobs: top.map(([token, logprob]) => ({ token, logprob })),
    });
    const tokens = [
      t('rem', -0.022, [
        ['rem', -0.022],
        ['reminder', -3.84],
        ['chat', -11.91],
      ]),
      t('ind', -0.001, [
        ['ind', -0.001],
        ['inder', -7.79],
      ]),
      t('e', -28, [
        ['', -0.02],
        [':', -3.75],
        [' me', -7.97],
      ]),
      t('r', -28, [
        ['', -0.01],
        [':', -4.73],
      ]),
      t('', 0, [
        ['', 0],
        ['</think>', -10.95],
      ]),
    ];
    const p = choiceProbability(tokens, 'reminder', [0, 8], ['reminder', 'lights', 'chat'], 'end');
    assert.ok(p > 0.95 && p < 1, `reminder ${p}`);
  });

  it('separates a JSON value from a key it prefixes ("1" vs "100")', () => {
    const content = '{"level":"1"}';
    const t = (token: string, logprob: number, top: [string, number][] = []) => ({
      token,
      logprob,
      top_logprobs: top.map(([token, logprob]) => ({ token, logprob })),
    });
    const tokens = [
      t('{"', 0),
      t('level', 0),
      t('":"', 0),
      t('1', 0),
      t('"}', Math.log(0.6), [
        ['"}', Math.log(0.6)],
        ['00', Math.log(0.4)],
      ]),
    ];
    const p = choiceProbability(tokens, content, valueSpan(content, 'level')!, ['1', '100'], '"');
    assert.ok(Math.abs(p - 0.6) < 1e-9, `level ${p}`);
  });

  it('constrains the replies to the options the bot asks', async () => {
    let body: any;
    const route = createJevRouter({
      apiKey: 'k',
      extraQuestions: () => lightsJevQuestions(LIGHTS),
      fetch: async (_u, init) => {
        body = JSON.parse(String(init?.body));
        return { ok: false, status: 500, json: async () => ({}) };
      },
      logger: { info: () => {}, warn: () => {} },
    });
    await route('lights off');
    assert.match(renderRoutePrompt(body.questions.route).constraint.grammar, /\| "notes" \|/);
    const { schema } = renderLightsPrompt(body.questions).constraint as { schema: any };
    const [plain, brightness, colour] = schema.anyOf;
    assert.deepEqual(plain.required, ['action', 'target'], 'on/off/list/other write no level or colour');
    assert.deepEqual(plain.properties.action.enum, ['on', 'off', 'list', 'other']);
    assert.ok(plain.properties.target.enum.includes('room:Office'));
    assert.deepEqual(brightness.required, ['action', 'target', 'brightness']);
    assert.deepEqual(colour.properties.action.enum, ['colour']);
  });
});
