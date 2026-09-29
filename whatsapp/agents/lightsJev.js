/**
 * Jev fast path for simple light requests: the routing call also asks which action, which
 * light/room, and which brightness/colour (speculative fan-out, see jevRouter.js). When the
 * route is `lights` and every answer used is confident, code drives the Hue bridge directly
 * and no GPT call is made. Anything else returns null and the GPT lights agent runs as before.
 */
import {
  getCachedLights,
  switchLight,
  switchOffAllLights,
  setLightBrightness,
  setLightColor,
  setLightColorTemperature,
} from '../../hue/api.js';
import { logAgentInvocation } from './agentUsageLog.js';

const PREMISE = 'Assume `message` is a request to the home\'s Philips Hue lights.';

const COLOURS = {
  red: [0, 254, 254],
  green: [25500, 254, 254],
  blue: [46920, 254, 254],
  yellow: [12750, 254, 254],
  orange: [6375, 254, 254],
  purple: [56100, 254, 254],
  pink: [56100, 100, 254],
  white: [0, 0, 254],
};
/** Colour-temperature presets in mireds (153 coolest … 500 warmest). */
const WHITES = { warm: 450, cool: 190 };

/**
 * @param {Array<{ id: string; name: string; room: string }>} [lights]
 * @returns {Record<string, object>} Jev questions, empty when there are no lights to target
 */
export function lightsJevQuestions(lights = getCachedLights()) {
  if (!lights.length) return {};
  const targets = {
    all: { what: 'Every light in the house, including when it just says "the lights" without naming a room or light.', examples: ['lights off', 'turn everything off'] },
  };
  for (const room of roomsOf(lights)) targets[`room:${room}`] = `All the lights in the ${room} room.`;
  for (const L of lights) targets[`light:${L.id}`] = `Only the single light named "${L.name}" (in the ${L.room} room).`;
  targets.unclear = 'Several separate lights or rooms, or no light or room can be identified.';

  return {
    lights_action: {
      type: 'choice',
      instructions: `${PREMISE} What does it want done?`,
      criteria: {
        on: 'Turn lights on.',
        off: 'Turn lights off.',
        brightness: 'Change brightness: dim, brighten, or set a level.',
        colour: 'Change the colour, or make the light a warmer or cooler white.',
        list: 'Report which lights are on or off, or list the lights.',
        other: {
          what: 'Anything else.',
          examples: [
            'turn on the kitchen and dim the bedroom',
            'what colours can the desk lamp do',
            'set the colour temperature to 3',
            'turn the lights off in 10 minutes',
          ],
        },
      },
    },
    lights_target: {
      type: 'choice',
      instructions: `${PREMISE} Which lights does it refer to?`,
      criteria: targets,
    },
    lights_brightness: {
      type: 'choice',
      instructions: `${PREMISE} If it asks for a brightness, which level fits best?`,
      criteria: {
        1: 'Lowest possible, a night light.',
        25: 'Dim, low.',
        50: 'Half brightness.',
        75: 'Fairly bright.',
        100: 'Full brightness, as bright as possible.',
      },
    },
    lights_colour: {
      type: 'choice',
      instructions: `${PREMISE} If it asks for a colour, which one?`,
      criteria: {
        ...Object.fromEntries(Object.keys(COLOURS).map((c) => [c, null])),
        warm: 'Warm white, cosy, yellowish.',
        cool: 'Cool white, daylight, bluish.',
      },
    },
  };
}

/**
 * @param {string} text the user's message
 * @param {Record<string, { choice?: string; probabilities?: Record<string, number> }>} answers Jev answers
 * @param {object} [deps]
 * @param {Array<{ id: string; name: string; room: string; state: string }>} [deps.lights]
 * @param {{ switchLight: Function; switchOffAllLights: Function; setLightBrightness: Function; setLightColor: Function; setLightColorTemperature: Function }} [deps.hue]
 * @param {number} [deps.minProbability] every answer used must reach this, else null
 * @param {{ info: Function }} [deps.logger]
 * @param {typeof logAgentInvocation} [deps.logUsage]
 * @returns {Promise<string | null>} the reply, or null to hand over to the GPT lights agent
 */
export async function runLightsFromJev(text, answers, deps = {}) {
  const {
    lights = getCachedLights(),
    hue = { switchLight, switchOffAllLights, setLightBrightness, setLightColor, setLightColorTemperature },
    minProbability = Number(process.env.LIGHTS_JEV_MIN_PROBABILITY) || 0.7,
    logger,
    logUsage = logAgentInvocation,
  } = deps;

  const confident = (id) => {
    const a = answers?.[id];
    return a && typeof a.choice === 'string' && Number(a.probabilities?.[a.choice] ?? 0) >= minProbability
      ? a.choice
      : null;
  };

  const action = confident('lights_action');
  if (!action || action === 'other') return null;
  let resolved = pickTarget(answers?.lights_target, lights, minProbability);
  if (!resolved && action === 'list') resolved = resolveTarget('all', lights);
  if (!resolved) return null;
  const { target, label, members } = resolved;

  let reply;
  if (action === 'list') {
    reply = members.map((L) => `• ${L.name} (${L.room}): ${L.state}`).join('\n');
  } else if (action === 'off' && target === 'all') {
    await hue.switchOffAllLights();
    reply = 'Turned off all the lights.';
  } else if (action === 'on' || action === 'off') {
    await forEach(members, (L) => hue.switchLight(L.id, action === 'on'));
    reply = `Turned ${action} ${label}.`;
  } else if (action === 'brightness') {
    const pct = explicitPercent(text) ?? Number(confident('lights_brightness'));
    if (!pct) return null;
    await forEach(members, (L) => hue.setLightBrightness(L.id, Math.round((pct / 100) * 254)));
    reply = `Set ${label} to ${pct}%.`;
  } else if (action === 'colour') {
    const colour = confident('lights_colour');
    if (!colour) return null;
    if (colour in WHITES) {
      await forEach(members, (L) => hue.setLightColorTemperature(L.id, WHITES[colour]));
      reply = `Set ${label} to ${colour} white.`;
    } else {
      const [h, s, b] = COLOURS[colour];
      await forEach(members, (L) => hue.setLightColor(L.id, h, s, b));
      reply = `Set ${label} to ${colour}.`;
    }
  } else {
    return null;
  }

  logger?.info({ action, target, lights: members.length }, 'Lights handled by Jev fast path');
  await logUsage({
    agent: 'lights',
    model: 'jev-fast-path',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    outcome: 'answered',
  });
  return reply;
}

function roomsOf(lights) {
  return [...new Set(lights.map((L) => L.room).filter((r) => r && r !== 'Unknown Room'))];
}

/**
 * Targets that name the same lights (a one-light room and that light) share their probability,
 * so Jev splitting between them doesn't read as uncertainty. Returns the confident group.
 */
function pickTarget(answer, lights, minProbability) {
  const groups = new Map();
  for (const [key, p] of Object.entries(answer?.probabilities ?? {})) {
    const resolved = resolveTarget(key, lights);
    if (!resolved) continue;
    const sig = resolved.members.map((L) => L.id).sort().join(',');
    const g = groups.get(sig);
    if (!g) groups.set(sig, { p, best: p, resolved });
    else {
      g.p += p;
      if (p > g.best) Object.assign(g, { best: p, resolved });
    }
  }
  const top = [...groups.values()].sort((a, b) => b.p - a.p)[0];
  return top && top.p >= minProbability ? top.resolved : null;
}

function resolveTarget(target, lights) {
  if (target === 'all') return lights.length ? { target, label: 'all the lights', members: lights } : null;
  if (target.startsWith('room:')) {
    const room = target.slice('room:'.length);
    const members = lights.filter((L) => L.room === room);
    return members.length ? { target, label: `the ${room} lights`, members } : null;
  }
  if (target.startsWith('light:')) {
    const L = lights.find((x) => x.id === target.slice('light:'.length));
    return L ? { target, label: `"${L.name}"`, members: [L] } : null;
  }
  return null;
}

/** "50%", "to 30 percent" → number; the user's own number beats Jev's nearest level. */
function explicitPercent(text) {
  const m = /\b(\d{1,3})\s*(?:%|percent\b)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 100 ? n : null;
}

async function forEach(members, fn) {
  await Promise.all(members.map(fn));
}
