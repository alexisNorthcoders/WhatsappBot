import dotenv from 'dotenv';
import OpenAI from 'openai';
import {
  switchOffAllLights,
  listAllLights,
  getLightsByRoom,
  switchLightByName,
  setLightBrightnessByName,
  setLightColorTemperatureByName,
  setLightColorByName,
  getLightInfoByName,
  refreshLightCache,
  getCacheStatus,
  getCachedLights,
} from '../../hue/api.js';
import { openaiChatTokenOpts } from '../../models/models.js';
import { logAgentInvocation, addCompletionUsage } from './agentUsageLog.js';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LIGHTS_AGENT_MODEL = process.env.LIGHTS_AGENT_MODEL || 'gpt-5-nano';
const MAX_AGENT_TURNS = 15;

/** Same preset colors as whatsapp/commands/lights.js */
const COLOR_MAP = {
  red: [0, 254, 254],
  green: [25500, 254, 254],
  blue: [46920, 254, 254],
  yellow: [12750, 254, 254],
  orange: [6375, 254, 254],
  purple: [56100, 254, 254],
  pink: [56100, 100, 254],
  white: [0, 0, 254],
  warm: [0, 0, 254],
  cool: [0, 0, 254],
};

const KEYWORD_PATTERN =
  /\b(light|lights|lamp|lamps|hue|dim|darker|brighter|brightness|illumina)\b|\bturn\s+(the\s+)?(lights?|lamps?|it)\b|\bswitch\s+(the\s+)?(lights?|lamps?|it)\b|\ball\s+(the\s+)?lights?\s+(off|on)\b|\b(lights?|lamps?)\s+(off|on)\b/i;

export const LIGHTS_AGENT_SKIP = 'SKIP';

export function shouldTryLightsAgent(text) {
  if (process.env.LIGHTS_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (KEYWORD_PATTERN.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  const lights = getCachedLights();
  for (const L of lights) {
    if (L.name && lower.includes(L.name.toLowerCase())) return true;
    if (L.room && L.room !== 'Unknown Room' && lower.includes(L.room.toLowerCase())) return true;
  }
  return false;
}

function formatLightSnapshot() {
  const lights = getCachedLights();
  if (!lights.length) {
    return '(cache empty — use refresh_cache or list tools after refresh)';
  }
  return lights
    .map(
      (L) =>
        `- "${L.name}" | room: ${L.room} | ${L.state}`
    )
    .join('\n');
}

function buildSystemPrompt() {
  return `You control Philips Hue lights in this home via tools only.

Current lights (names must match closely; fuzzy match is applied on the bridge side):
${formatLightSnapshot()}

Rules:
- Use tools to perform actions or fetch data. Prefer calling list tools if a light name is ambiguous.
- Brightness is always 0–100 (percent).
- Color temperature scale is 1–10 where 1 is warmest and 10 is coolest (same as the Hue helper).
- For set_color, use a preset name (red, green, blue, yellow, orange, purple, pink, white, warm, cool) OR three integers as hue,sat,bri for HSB mode.
- If the user message is clearly NOT about home lighting / Hue / rooms / brightness / lamps, respond with exactly: ${LIGHTS_AGENT_SKIP}
- Otherwise give a short, friendly WhatsApp-style reply after tools succeed (you may call multiple tools). Do not mention "SKIP" to the user unless they asked about it.`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lights_all_off',
      description: 'Turn off all lights (whole home / group 0).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_set_on',
      description: 'Turn on a single light by name (partial name match supported).',
      parameters: {
        type: 'object',
        properties: {
          light_name: { type: 'string', description: 'Light name as shown in the snapshot' },
        },
        required: ['light_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_set_off',
      description: 'Turn off a single light by name (partial name match supported).',
      parameters: {
        type: 'object',
        properties: {
          light_name: { type: 'string' },
        },
        required: ['light_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_list_all',
      description: 'List all lights with room, id, state, type.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_list_room',
      description: 'List lights whose room name contains the given substring (case-insensitive).',
      parameters: {
        type: 'object',
        properties: {
          room_name: { type: 'string' },
        },
        required: ['room_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_set_brightness',
      description: 'Set brightness for one light. brightness_0_100 is percent 0–100.',
      parameters: {
        type: 'object',
        properties: {
          light_name: { type: 'string' },
          brightness_0_100: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['light_name', 'brightness_0_100'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_set_color_temp',
      description: 'Set color temperature 1–10 (1 warmest, 10 coolest) for one light.',
      parameters: {
        type: 'object',
        properties: {
          light_name: { type: 'string' },
          color_temp_1_10: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['light_name', 'color_temp_1_10'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_set_color',
      description:
        'Set color: preset (red, green, blue, yellow, orange, purple, pink, white, warm, cool) OR hsb string "hue,sat,bri" with three integers.',
      parameters: {
        type: 'object',
        properties: {
          light_name: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['light_name', 'color'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_light_info',
      description: 'Get capabilities and current state for one light by name.',
      parameters: {
        type: 'object',
        properties: {
          light_name: { type: 'string' },
        },
        required: ['light_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_refresh_cache',
      description: 'Refresh the Hue light cache from the bridge (use if snapshot seems stale).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lights_cache_status',
      description: 'Show cache last update time, light count, and whether a refresh is in progress.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function miredsFromUserScale1to10(tempValue) {
  return Math.round(153 + ((10 - tempValue) / 9) * (500 - 153));
}

export async function executeLightsTool(name, args) {
  try {
    switch (name) {
      case 'lights_all_off': {
        await switchOffAllLights();
        return 'OK: All lights switched off.';
      }
      case 'lights_set_on': {
        await switchLightByName(args.light_name, true);
        return `OK: Turned on "${args.light_name}".`;
      }
      case 'lights_set_off': {
        await switchLightByName(args.light_name, false);
        return `OK: Turned off "${args.light_name}".`;
      }
      case 'lights_list_all': {
        const lights = await listAllLights();
        if (!lights.length) return 'No lights found (cache may be empty).';
        const lines = lights.map(
          (light) =>
            `• ${light.name} (id ${light.id}) — ${light.room} — ${light.state} — ${light.type}`
        );
        return lines.join('\n');
      }
      case 'lights_list_room': {
        const lights = await getLightsByRoom(args.room_name);
        if (!lights.length) return `No lights in rooms matching "${args.room_name}".`;
        const lines = lights.map(
          (light) => `• ${light.name} — ${light.state} — ${light.type}`
        );
        return `Lights in room match "${args.room_name}":\n${lines.join('\n')}`;
      }
      case 'lights_set_brightness': {
        const v = parseInt(String(args.brightness_0_100), 10);
        if (Number.isNaN(v) || v < 0 || v > 100) {
          return 'Error: brightness_0_100 must be 0–100.';
        }
        const hueBrightness = Math.round((v / 100) * 254);
        await setLightBrightnessByName(args.light_name, hueBrightness);
        return `OK: Set "${args.light_name}" brightness to ${v}%.`;
      }
      case 'lights_set_color_temp': {
        const t = parseInt(String(args.color_temp_1_10), 10);
        if (Number.isNaN(t) || t < 1 || t > 10) {
          return 'Error: color_temp_1_10 must be 1–10.';
        }
        const mireds = miredsFromUserScale1to10(t);
        await setLightColorTemperatureByName(args.light_name, mireds);
        return `OK: Set "${args.light_name}" color temperature to ${t}/10.`;
      }
      case 'lights_set_color': {
        const colorRaw = String(args.color || '').trim();
        const lightName = args.light_name;
        let hue;
        let sat;
        let bri;
        const preset = COLOR_MAP[colorRaw.toLowerCase()];
        if (preset) {
          [hue, sat, bri] = preset;
        } else {
          const parts = colorRaw.split(',').map((p) => parseInt(p.trim(), 10));
          if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
            [hue, sat, bri] = parts;
          } else {
            return `Error: Invalid color "${colorRaw}". Use a preset (red, green, …) or hue,sat,bri.`;
          }
        }
        await setLightColorByName(lightName, hue, sat, bri);
        return `OK: Set "${lightName}" color to ${colorRaw}.`;
      }
      case 'lights_light_info': {
        const info = await getLightInfoByName(args.light_name);
        const briPct =
          info.state.brightness != null
            ? `${Math.round((info.state.brightness / 254) * 100)}%`
            : 'N/A';
        const ctScale =
          info.state.colorTemp != null
            ? `${Math.round(10 - ((info.state.colorTemp - 153) / (500 - 153)) * 9)}/10`
            : 'N/A';
        return [
          `${info.name} (${info.type}, ${info.modelid})`,
          `Color: ${info.capabilities.hasColor}, CT: ${info.capabilities.hasColorTemp}, Bri: ${info.capabilities.hasBrightness}`,
          `On: ${info.state.on}, Brightness: ${briPct}, CT scale: ${ctScale}, mode: ${info.state.colormode || 'N/A'}`,
        ].join('\n');
      }
      case 'lights_refresh_cache': {
        await refreshLightCache();
        const status = getCacheStatus();
        return `OK: Cache refreshed. Lights: ${status.lightCount}, last updated: ${status.lastUpdated}`;
      }
      case 'lights_cache_status': {
        const status = getCacheStatus();
        return `Last updated: ${status.lastUpdated || 'never'}, lights: ${status.lightCount}, updating: ${status.isUpdating}`;
      }
      default:
        return `Error: Unknown tool "${name}".`;
    }
  } catch (e) {
    return `Error: ${e.message || String(e)}`;
  }
}

/**
 * @returns {Promise<string>} Final user-facing text, or LIGHTS_AGENT_SKIP to fall through to other handlers.
 */
export async function runLightsAgent(userMessage) {
  const usage = { prompt: 0, completion: 0, total: 0 };
  const model = LIGHTS_AGENT_MODEL;
  let outcome = 'error';

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userMessage },
    ];

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const completion = await openai.chat.completions.create({
        model: LIGHTS_AGENT_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        ...openaiChatTokenOpts(LIGHTS_AGENT_MODEL, 800),
      });

      addCompletionUsage(completion.usage, usage);

      const choice = completion.choices[0]?.message;
      if (!choice) {
        outcome = 'skip';
        return LIGHTS_AGENT_SKIP;
      }

      if (choice.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: choice.content || null,
          tool_calls: choice.tool_calls,
        });
        for (const tc of choice.tool_calls) {
          const fn = tc.function;
          let args = {};
          try {
            args = fn.arguments ? JSON.parse(fn.arguments) : {};
          } catch {
            args = {};
          }
          const result = await executeLightsTool(fn.name, args);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        }
        continue;
      }

      const text = (choice.content || '').trim();
      if (!text) {
        outcome = 'skip';
        return LIGHTS_AGENT_SKIP;
      }
      if (text.toUpperCase() === LIGHTS_AGENT_SKIP) {
        outcome = 'skip';
        return LIGHTS_AGENT_SKIP;
      }
      outcome = 'answered';
      return text;
    }

    outcome = 'max_turns';
    return 'Too many tool steps — try a simpler request.';
  } catch (e) {
    outcome = 'error';
    throw e;
  } finally {
    await logAgentInvocation({
      agent: 'lights',
      model,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      outcome,
    });
  }
}
