import dotenv from 'dotenv';
import OpenAI from 'openai';
import { getWeatherData, openaiChatTokenOpts } from '../../models/models.js';
import { logAgentInvocation, addCompletionUsage } from './agentUsageLog.js';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WEATHER_AGENT_MODEL = process.env.WEATHER_AGENT_MODEL || 'gpt-5-nano';
const MAX_AGENT_TURNS = 15;

const DEFAULT_CITY = process.env.WEATHER_AGENT_DEFAULT_CITY?.trim() || 'Manchester';

export const WEATHER_AGENT_SKIP = 'SKIP';

const KEYWORD_PATTERN =
  /\b(weather|forecast|temperature|rain|snow|sleet|hail|storm|thunder|humid|humidity|wind|windy|cloudy|sunny|overcast|celsius|fahrenheit|°c|°f|degrees)\b|\bwill\s+it\s+rain\b|\bhow\s+hot\b|\bhow\s+cold\b|\bwhat'?s\s+it\s+like\s+outside\b/i;

export function shouldTryWeatherAgent(text) {
  if (process.env.WEATHER_AGENT_ALWAYS === '1') return true;
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return KEYWORD_PATTERN.test(trimmed);
}

function buildSystemPrompt() {
  const defaultLine = DEFAULT_CITY
    ? `If the user does not name a place, call weather_get_forecast with city "${DEFAULT_CITY}".`
    : 'If the user does not name a place, ask them which city they mean (do not guess).';
  return `You answer questions about weather using the weather_get_forecast tool (OpenWeather forecast data).

${defaultLine}

Rules:
- Use the tool to fetch data before answering factual questions about conditions or the forecast.
- If the message is clearly NOT about weather, climate, or outdoor conditions, respond with exactly: ${WEATHER_AGENT_SKIP}
- After the tool succeeds, reply in a short, friendly WhatsApp style. Do not expose SKIP to the user.`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'weather_get_forecast',
      description:
        'Fetch a short-range forecast for a city (geocoding + OpenWeather 5-day/3-hour steps).',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'City name (and optional region/country) for geocoding, e.g. "Paris" or "Manchester, UK".',
          },
        },
        required: ['city'],
      },
    },
  },
];

function formatForecastCompact(cityLabel, forecast) {
  const list = forecast?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return 'No forecast entries in response.';
  }
  const slice = list.slice(0, 8);
  const lines = slice.map((f) => {
    const w = f.weather?.[0]?.description ?? '?';
    const t = f.main?.temp;
    const h = f.main?.humidity;
    const when = f.dt_txt ?? '';
    return `${when}: ${w}, temp ${t}°C, humidity ${h}%`;
  });
  return `Location query: ${cityLabel}\n${lines.join('\n')}`;
}

async function executeWeatherTool(name, args) {
  try {
    if (name !== 'weather_get_forecast') {
      return `Error: Unknown tool "${name}".`;
    }
    let city = String(args.city ?? '').trim();
    if (!city) {
      if (DEFAULT_CITY) city = DEFAULT_CITY;
      else return 'Error: city is required.';
    }
    const data = await getWeatherData(city);
    return formatForecastCompact(city, data);
  } catch (e) {
    return `Error: ${e.message || String(e)}`;
  }
}

export async function runWeatherAgent(userMessage) {
  const usage = { prompt: 0, completion: 0, total: 0 };
  const model = WEATHER_AGENT_MODEL;
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
        model: WEATHER_AGENT_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        ...openaiChatTokenOpts(WEATHER_AGENT_MODEL, 1200),
      });

      addCompletionUsage(completion.usage, usage);

      const choice = completion.choices[0]?.message;
      if (!choice) {
        outcome = 'skip';
        return WEATHER_AGENT_SKIP;
      }

      if (choice.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: choice.content || null,
          tool_calls: choice.tool_calls,
        });
        for (const tc of choice.tool_calls) {
          const fn = tc.function;
          let parsed = {};
          try {
            parsed = fn.arguments ? JSON.parse(fn.arguments) : {};
          } catch {
            parsed = {};
          }
          const result = await executeWeatherTool(fn.name, parsed);
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
        return WEATHER_AGENT_SKIP;
      }
      if (text.toUpperCase() === WEATHER_AGENT_SKIP) {
        outcome = 'skip';
        return WEATHER_AGENT_SKIP;
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
      agent: 'weather',
      model,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      outcome,
    });
  }
}
