import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lightsJevQuestions, runLightsFromJev } from '../whatsapp/agents/lightsJev.js';

const LIGHTS = [
  { id: '1', name: 'Bedside', room: 'Bedroom', state: 'ON' },
  { id: '2', name: 'Ceiling', room: 'Bedroom', state: 'OFF' },
  { id: '3', name: 'Desk lamp', room: 'Office', state: 'ON' },
];

function fakeHue() {
  const calls = [];
  const rec =
    (name) =>
    async (...args) =>
      calls.push([name, ...args]);
  return {
    calls,
    hue: {
      switchLight: rec('switchLight'),
      switchOffAllLights: rec('switchOffAllLights'),
      setLightBrightness: rec('setLightBrightness'),
      setLightColor: rec('setLightColor'),
      setLightColorTemperature: rec('setLightColorTemperature'),
    },
  };
}

/** @param {Record<string, [string, number]>} picks question id → [choice, probability] */
function answers(picks) {
  return Object.fromEntries(
    Object.entries(picks).map(([id, [choice, p]]) => [id, { type: 'choice', choice, probabilities: { [choice]: p } }]),
  );
}

async function run(text, picks) {
  const { hue, calls } = fakeHue();
  const reply = await runLightsFromJev(text, answers(picks), { lights: LIGHTS, hue, logUsage: async () => {} });
  return { reply, calls };
}

describe('lightsJevQuestions', () => {
  it('offers all, each room, each light and unclear as targets', () => {
    const q = lightsJevQuestions(LIGHTS);
    assert.deepEqual(Object.keys(q.lights_target.criteria), [
      'all',
      'room:Bedroom',
      'room:Office',
      'light:1',
      'light:2',
      'light:3',
      'unclear',
    ]);
    assert.ok('other' in q.lights_action.criteria);
  });

  it('asks nothing when the light cache is empty', () => {
    assert.deepEqual(lightsJevQuestions([]), {});
  });
});

describe('runLightsFromJev', () => {
  it('turns off every light in a room', async () => {
    const { reply, calls } = await run('bedroom lights off', { lights_action: ['off', 0.95], lights_target: ['room:Bedroom', 0.9] });
    assert.equal(reply, 'Turned off the Bedroom lights.');
    assert.deepEqual(calls, [
      ['switchLight', '1', false],
      ['switchLight', '2', false],
    ]);
  });

  it('uses the all-lights group to turn everything off', async () => {
    const { calls } = await run('lights off', { lights_action: ['off', 0.95], lights_target: ['all', 0.9] });
    assert.deepEqual(calls, [['switchOffAllLights']]);
  });

  it("prefers the user's own percentage over Jev's nearest level", async () => {
    const { reply, calls } = await run('desk lamp to 40%', {
      lights_action: ['brightness', 0.9],
      lights_target: ['light:3', 0.9],
      lights_brightness: ['50', 0.8],
    });
    assert.equal(reply, 'Set "Desk lamp" to 40%.');
    assert.deepEqual(calls, [['setLightBrightness', '3', Math.round(0.4 * 254)]]);
  });

  it('uses the Jev brightness level when no number is given', async () => {
    const { calls } = await run('dim the office', {
      lights_action: ['brightness', 0.9],
      lights_target: ['room:Office', 0.9],
      lights_brightness: ['25', 0.8],
    });
    assert.deepEqual(calls, [['setLightBrightness', '3', Math.round(0.25 * 254)]]);
  });

  it('sets warm white as a colour temperature and red as a colour', async () => {
    const warm = await run('make the desk lamp cosy', {
      lights_action: ['colour', 0.9],
      lights_target: ['light:3', 0.9],
      lights_colour: ['warm', 0.8],
    });
    assert.equal(warm.calls[0][0], 'setLightColorTemperature');
    const red = await run('desk lamp red', {
      lights_action: ['colour', 0.9],
      lights_target: ['light:3', 0.9],
      lights_colour: ['red', 0.9],
    });
    assert.deepEqual(red.calls, [['setLightColor', '3', 0, 254, 254]]);
  });

  it('adds up targets that name the same lights (a one-light room and that light)', async () => {
    const { hue, calls } = fakeHue();
    const a = answers({ lights_action: ['on', 0.95] });
    // Office has only the desk lamp: 0.4 + 0.35 clears 0.7 though neither does alone.
    a.lights_target = { choice: 'room:Office', probabilities: { 'room:Office': 0.4, 'light:3': 0.35, 'room:Bedroom': 0.25 } };
    const reply = await runLightsFromJev('desk lamp on', a, { lights: LIGHTS, hue, logUsage: async () => {} });
    assert.equal(reply, 'Turned on the Office lights.');
    assert.deepEqual(calls, [['switchLight', '3', true]]);
  });

  it('lists all lights when asked which are on without a target', async () => {
    const { reply, calls } = await run('which lights are on', { lights_action: ['list', 0.9], lights_target: ['unclear', 0.4] });
    assert.match(reply, /Bedside \(Bedroom\): ON/);
    assert.match(reply, /Desk lamp \(Office\): ON/);
    assert.deepEqual(calls, []);
  });

  it('hands over (null) when any answer used is unsure, or the request is not simple', async () => {
    const cases = [
      { lights_action: ['off', 0.5], lights_target: ['room:Bedroom', 0.9] },
      { lights_action: ['off', 0.9], lights_target: ['room:Bedroom', 0.5] },
      { lights_action: ['other', 0.9], lights_target: ['room:Bedroom', 0.9] },
      { lights_action: ['off', 0.9], lights_target: ['unclear', 0.9] },
      { lights_action: ['off', 0.9], lights_target: ['room:Garage', 0.9] },
      { lights_action: ['colour', 0.9], lights_target: ['light:3', 0.9], lights_colour: ['blue', 0.4] },
      { lights_action: ['brightness', 0.9], lights_target: ['light:3', 0.9] },
    ];
    for (const picks of cases) {
      const { reply, calls } = await run('x', picks);
      assert.equal(reply, null, JSON.stringify(picks));
      assert.deepEqual(calls, []);
    }
  });
});
