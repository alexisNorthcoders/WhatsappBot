import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lightsJevQuestions, runLightsFromJev } from '../whatsapp/agents/lightsJev.ts';
import type { JevAnswer } from '../whatsapp/agents/lightsJev.ts';

const LIGHTS = [
  { id: '1', name: 'Bedside', room: 'Bedroom', state: 'ON' },
  { id: '2', name: 'Ceiling', room: 'Bedroom', state: 'OFF' },
  { id: '3', name: 'Desk lamp', room: 'Office', state: 'ON' },
];

function fakeHue() {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) =>
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

/** question id → [choice, probability] */
type Picks = Record<string, [string, number]>;

function answers(picks: Picks): Record<string, JevAnswer> {
  return Object.fromEntries(
    Object.entries(picks).map(([id, [choice, p]]) => [id, { type: 'choice', choice, probabilities: { [choice]: p } }]),
  );
}

async function run(text: string, picks: Picks) {
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
    const { reply, calls } = await run('bedroom lights off', {
      lights_action: ['off', 0.95],
      lights_target: ['room:Bedroom', 0.9],
    });
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
    a.lights_target = {
      choice: 'room:Office',
      probabilities: { 'room:Office': 0.4, 'light:3': 0.35, 'room:Bedroom': 0.25 },
    };
    const reply = await runLightsFromJev('desk lamp on', a, { lights: LIGHTS, hue, logUsage: async () => {} });
    assert.equal(reply, 'Turned on the Office lights.');
    assert.deepEqual(calls, [['switchLight', '3', true]]);
  });

  it('lists all lights when asked which are on without a target', async () => {
    const { reply, calls } = await run('which lights are on', {
      lights_action: ['list', 0.9],
      lights_target: ['unclear', 0.4],
    });
    assert.ok(reply);
    assert.match(reply, /Bedside \(Bedroom\): ON/);
    assert.match(reply, /Desk lamp \(Office\): ON/);
    assert.deepEqual(calls, []);
  });

  it('hands over (null) when any answer used is unsure, or the request is not simple', async () => {
    const cases: Picks[] = [
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

describe('runLightsFromJev checks the message backs the answers', () => {
  // the house's Hue setup (bench/router/lights.snapshot.json)
  const HOUSE = [
    ['2', 'Stairs', 'Staircase'],
    ['3', 'Baby', 'Living room'],
    ['4', 'Living Room Right', 'Living room'],
    ['5', 'Office', 'Office'],
    ['6', 'Living Room Left', 'Living room'],
    ['8', 'Hall', 'Living room'],
    ['9', 'Bedroom', 'Bedroom'],
    ['10', 'Garden', 'Garden'],
    ['12', 'Desk', 'Office'],
    ['14', 'Bathroom', 'Bathroom'],
    ['15', 'Children ', 'Kids bedroom'],
  ].map(([id, name, room]) => ({ id, name, room, state: 'OFF' }));

  /** question id → [choice], all fully confident */
  type Says = Record<string, [string]>;

  async function inHouse(text: string, picks: Says) {
    const { hue, calls } = fakeHue();
    const confident = Object.fromEntries(Object.entries(picks).map(([id, [c]]) => [id, [c, 1] as [string, number]]));
    const reply = await runLightsFromJev(text, answers(confident), { lights: HOUSE, hue, logUsage: async () => {} });
    return { reply, calls };
  }

  it('acts when the message names the target and asks for the action', async () => {
    const cases: [string, Says][] = [
      ['make the office lights 30%', { lights_action: ['brightness'], lights_target: ['room:Office'] }],
      [
        'set the baby light to night light level',
        { lights_action: ['brightness'], lights_target: ['light:3'], lights_brightness: ['1'] },
      ],
      [
        'stairs light at half',
        { lights_action: ['brightness'], lights_target: ['room:Staircase'], lights_brightness: ['50'] },
      ],
      [
        'turn the desk lamp up to full',
        { lights_action: ['brightness'], lights_target: ['light:12'], lights_brightness: ['100'] },
      ],
      [
        'kids room light blue please',
        { lights_action: ['colour'], lights_target: ['room:Kids bedroom'], lights_colour: ['blue'] },
      ],
      [
        'can the living room be a cosy warm white',
        { lights_action: ['colour'], lights_target: ['room:Living room'], lights_colour: ['warm'] },
      ],
      [
        'bathroom light cool white',
        { lights_action: ['colour'], lights_target: ['room:Bathroom'], lights_colour: ['cool'] },
      ],
      ['Living Room Left off', { lights_action: ['off'], lights_target: ['light:6'] }],
      ['hall light off please', { lights_action: ['off'], lights_target: ['light:8'] }],
      ['office desk lamp off', { lights_action: ['off'], lights_target: ['light:12'] }],
      ['switch the garden light on', { lights_action: ['on'], lights_target: ['light:10'] }],
      ['turn on the lights', { lights_action: ['on'], lights_target: ['all'] }],
      ['lights out everywhere', { lights_action: ['off'], lights_target: ['all'] }],
      ['kill all the lights', { lights_action: ['off'], lights_target: ['all'] }],
    ];
    for (const [text, picks] of cases) {
      const { reply, calls } = await inHouse(text, picks);
      assert.ok(reply && calls.length, `${text}: ${JSON.stringify(picks)}`);
    }
  });

  it('hands over when the message does not back a confident answer', async () => {
    const cases: [string, Says][] = [
      // no word for the action
      ['thanks, the lights are perfect now', { lights_action: ['off'], lights_target: ['all'] }],
      [
        'nice one, the garden light looks great',
        { lights_action: ['colour'], lights_target: ['room:Garden'], lights_colour: ['white'] },
      ],
      // a question
      ['have I left the bathroom light on?', { lights_action: ['off'], lights_target: ['light:14'] }],
      ['is the bathroom light on?', { lights_action: ['on'], lights_target: ['room:Bathroom'] }],
      // a target the message doesn't name, or names less well than another
      ['make the office lights 30%', { lights_action: ['brightness'], lights_target: ['light:3'] }],
      [
        'set the baby light to night light level',
        { lights_action: ['brightness'], lights_target: ['light:15'], lights_brightness: ['1'] },
      ],
      [
        'bedroom lamp warm white for reading',
        { lights_action: ['colour'], lights_target: ['light:15'], lights_colour: ['warm'] },
      ],
      ['Living Room Left off', { lights_action: ['off'], lights_target: ['room:Living room'] }],
      ['office lights orange', { lights_action: ['colour'], lights_target: ['all'], lights_colour: ['orange'] }],
      // a second, separate target
      ['lights on in the bedroom and the office', { lights_action: ['on'], lights_target: ['room:Bedroom'] }],
      ['turn the desk lamp on and the office light off', { lights_action: ['on'], lights_target: ['light:12'] }],
      // a delay or a time
      ['switch off the garden in 15 minutes', { lights_action: ['off'], lights_target: ['room:Garden'] }],
      [
        'set the living room to 40% in five minutes',
        { lights_action: ['brightness'], lights_target: ['room:Living room'] },
      ],
      ['turn off the bedroom light at 10pm', { lights_action: ['off'], lights_target: ['room:Bedroom'] }],
    ];
    for (const [text, picks] of cases) {
      const { reply, calls } = await inHouse(text, picks);
      assert.equal(reply, null, `${text}: ${JSON.stringify(picks)}`);
      assert.deepEqual(calls, [], text);
    }
  });

  it('lists every light when a list target is one the message does not name', async () => {
    const { reply } = await inHouse('which lights are on right now', {
      lights_action: ['list'],
      lights_target: ['room:Staircase'],
    });
    assert.ok(reply);
    assert.equal(reply.split('\n').length, HOUSE.length);
  });

  it('lists the light the message names', async () => {
    const { reply } = await inHouse('is the staircase light still on', {
      lights_action: ['list'],
      lights_target: ['room:Staircase'],
    });
    assert.equal(reply, '• Stairs (Staircase): OFF');
  });
});
