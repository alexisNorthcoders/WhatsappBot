import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, loadLights } from '../bench/router/dataset.ts';
import type { Row } from '../bench/router/dataset.ts';
import { scoreLights } from '../bench/router/score.ts';
import { renderChoicePrompt } from '../bench/router/backends.ts';
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
});
