import OpenAI, { toFile } from 'openai';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, '..', 'assets', 'generated');

/** @returns {Promise<string|null>} absolute filepath or null on failure */
async function saveGeneratedImage(response, prompt) {
  try {
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '');
    const filename = `${timestamp}_${slug}.png`;
    const filepath = path.join(GENERATED_DIR, filename);

    const entry = response.data[0];
    if (entry.b64_json) {
      await fs.writeFile(filepath, Buffer.from(entry.b64_json, 'base64'));
    } else if (entry.url) {
      const res = await fetch(entry.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(filepath, buffer);
    } else {
      return null;
    }
    console.log(`Saved generated image: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error('Failed to save generated image:', err.message);
    return null;
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-5-mini';

const CODE_CHAT_MODEL = process.env.OPENAI_CODE_CHAT_MODEL || 'gpt-5-mini';

/**
 * GPT-5 and o-series chat models use `max_completion_tokens` instead of `max_tokens`.
 * @param {string} model
 * @param {number} max
 */
export function openaiChatTokenOpts(model, max) {
  const m = String(model || '').trim();
  if (/^(gpt-5|o\d)/i.test(m)) {
    return { max_completion_tokens: max };
  }
  return { max_tokens: max };
}

const deepInfra = new OpenAI({
  baseURL: 'https://api.deepinfra.com/v1/openai',
  apiKey: process.env.DEEPINFRA_API_KEY,
});

export async function deepInfraAPI(content, model = "deepseek-ai/DeepSeek-V3") {
  const completion = await deepInfra.chat.completions.create({
    messages: [{ role: "user", content }],
    model,
  });

  console.log(completion.usage.prompt_tokens, completion.usage.completion_tokens);

  return completion.choices[0].message.content
}

export async function getGeocoding(city) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const geocodeURL = `http://api.openweathermap.org/geo/1.0/direct?q=${city}&limit=1&appid=${apiKey}`;
  try {
    const response = await fetch(geocodeURL);
    const geocode = await response.json();
    return geocode;
  } catch (error) {
    console.log("Error fetching weather data:", error);
    throw error;
  }

}
export async function getWeatherData(city) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  try {
    const geocode = await getGeocoding(city);
    if (!Array.isArray(geocode) || geocode.length === 0) {
      throw new Error(`No location found for "${city}"`);
    }
    const { lat, lon } = geocode[0];
    const weatherURL = `http://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&APPID=${apiKey}`;
    const response = await fetch(weatherURL);
    const weatherData = await response.json();
    return weatherData;
  } catch (error) {
    console.log("Error fetching weather data:", error);
    throw error;
  }
}
const CHAT_HISTORY_API_CAP = parseInt(process.env.CHAT_MEMORY_MAX_MESSAGES || '10', 10);
const CHAT_HISTORY_CONTENT_CAP = parseInt(process.env.CHAT_MEMORY_MAX_CONTENT || '4000', 10);

/**
 * GPT-5 / o-series models use internal reasoning tokens that count toward the same
 * `max_completion_tokens` budget as visible text. Too low a limit often yields
 * empty `message.content` (reasoning exhausts the budget first).
 *
 * @param {string} model
 * @returns {number}
 */
function assistantMaxCompletionTokens(model) {
  const fromEnv = parseInt(process.env.OPENAI_ASSISTANT_MAX_COMPLETION_TOKENS || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  const m = String(model || '').trim();
  return /^(gpt-5|o\d)/i.test(m) ? 8192 : 1000;
}

/**
 * @param {string} userMessage
 * @param {{ role: string, content: string }[]} [priorMessages] prior user/assistant turns only (no system)
 */
export async function assistantgenerateResponse(userMessage, priorMessages = []) {
  try {
    const maxPrior = Math.max(0, CHAT_HISTORY_API_CAP - 1);
    const valid = Array.isArray(priorMessages)
      ? priorMessages
          .filter(
            (m) =>
              m &&
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string'
          )
          .map((m) => ({
            role: m.role,
            content: String(m.content).slice(0, CHAT_HISTORY_CONTENT_CAP),
          }))
      : [];
    const history = maxPrior ? valid.slice(-maxPrior) : [];

    const completion = await openai.chat.completions.create({
      model: DEFAULT_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. You are inside a whatsapp conversation. You have many capabilities. You can tell the weather, recipes, tell jokes and so on.',
        },
        ...history,
        { role: 'user', content: String(userMessage).slice(0, CHAT_HISTORY_CONTENT_CAP) },
      ],
      ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, assistantMaxCompletionTokens(DEFAULT_CHAT_MODEL)),
    });

    const raw = completion.choices[0]?.message?.content;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      console.error('assistantgenerateResponse: empty assistant content', {
        model: DEFAULT_CHAT_MODEL,
        finish_reason: completion.choices[0]?.finish_reason,
        usage: completion.usage,
      });
      return (
        'Sorry — the model returned no visible text (often the output limit was reached by internal reasoning before the reply). ' +
        'On the Pi, set OPENAI_ASSISTANT_MAX_COMPLETION_TOKENS higher (e.g. 16384) or use a non-reasoning chat model for OPENAI_CHAT_MODEL.'
      );
    }
    return text;
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
export async function gPT4generateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: DEFAULT_CHAT_MODEL,
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You will always give your responses summarized in bullet points unless asked otherwise." },
        { "role": "user", "content": userMessage }],
      ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, 1000),

    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
export async function codeResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: CODE_CHAT_MODEL,
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You are a senior software engineer. You will respond just with typescript code unless asked otherwise." },
        { "role": "user", "content": userMessage }],
      ...openaiChatTokenOpts(CODE_CHAT_MODEL, 1000),

    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
export async function dallegenerateResponse(userMessage) {
  try {
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt: userMessage,
      n: 1,
      size: "1024x1024",
      quality: "standard"
    });
    await saveGeneratedImage(response, userMessage);
    imageUrl = response.data[0].url;

    return imageUrl;
  } catch (error) {
    console.error('Error generating Dall-e response:', error);
    throw new Error('Error generating response');
  }
}
export function convertToBase64(file) {
  let fileData = fs.readFileSync(file);
  return new Buffer.from(fileData).toString("base64");

}
export async function visionQuality(base64) {
  const response = await openai.chat.completions.create({
    model: DEFAULT_CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Scan the image and extract the text." },
          {
            type: "image_url",
            image_url: {
              "url": `data:image/jpeg;base64,${base64}`,
              "detail": "high"
            },
          },
        ],
      },
    ],
    ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, 10000),
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
export async function vision(base64) {
  const response = await openai.chat.completions.create({
    model: DEFAULT_CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Scan the image and extract the text." },
          {
            type: "image_url",
            image_url: {
              "url": `data:image/jpeg;base64,${base64}`,
              "detail": "low"
            },
          },
        ],
      },
    ],
    ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, 1500),
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
export async function visionHelp(base64) {
  const response = await openai.chat.completions.create({
    model: DEFAULT_CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "The image will be coding exercise in python. Help me solve it. Only give me the code." },
          {
            type: "image_url",
            image_url: {
              "url": `data:image/jpeg;base64,${base64}`,
              "detail": "high"
            },
          },
        ],
      },
    ],
    ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, 1500),
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
const VALID_SPRITE_SIZES = ['16x16', '32x32', '48x48', '64x64', '128x128'];

function buildPixelArtPromptText(userMessage, size = '32x32') {
  return [
    `Create a ${size} pixel art game sprite of: ${userMessage}.`,
    `Style rules: clean pixel art, limited retro color palette,`,
    `hard-edged pixels with NO anti-aliasing or blur,`,
    `transparent background, centered on canvas,`,
    `suitable for a 2D game sprite sheet.`,
  ].join(' ');
}

/**
 * @returns {Promise<{ buffer: Buffer, filepath: string|null }>}
 */
export async function pixelArtGenerateResponse(userMessage, size = '32x32') {
  try {
    const pixelArtPrompt = buildPixelArtPromptText(userMessage, size);

    const response = await openai.images.generate({
      model: 'gpt-image-1.5',
      prompt: pixelArtPrompt,
      n: 1,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
    });

    const filepath = await saveGeneratedImage(response, `sprite_${size}_${userMessage}`);
    const buffer = Buffer.from(response.data[0].b64_json, 'base64');
    return { buffer, filepath };
  } catch (error) {
    console.error('Error generating pixel art sprite:', error);
    throw new Error('Error generating pixel art sprite');
  }
}

async function spriteRefinePromptFromImageFile(absPath, editInstruction, size) {
  const b64 = (await fs.readFile(absPath)).toString('base64');
  const response = await openai.chat.completions.create({
    model: DEFAULT_CHAT_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `This image is a ${size}-style pixel art game sprite. The user wants this refinement: ${editInstruction}\n\nWrite ONE concise English phrase (max 400 characters) describing the full sprite as it should look after the change — suitable as the sole subject for generating a new matching pixel art sprite. No quotes, no markdown.`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${b64}`,
              detail: 'high',
            },
          },
        ],
      },
    ],
    ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, 400),
  });
  return response.choices[0].message.content.trim().slice(0, 400);
}

/**
 * Edit an on-disk sprite via images.edit; on API failure, vision-led regenerate.
 * @param {string} resolvedPath absolute path under assets/generated
 * @param {string} editInstruction user request
 * @param {string} [size]
 * @returns {Promise<{ buffer: Buffer, filepath: string|null }>}
 */
export async function pixelArtEditFromFile(resolvedPath, editInstruction, size = '32x32') {
  const buf = await fs.readFile(resolvedPath);
  if (buf.length > 4 * 1024 * 1024) {
    throw new Error('Image file too large for edit API (max 4MB).');
  }

  const stylePrefix =
    'Pixel art game sprite: hard edges, retro palette, no anti-aliasing, transparent background. Apply this change: ';
  const prompt = (stylePrefix + editInstruction).slice(0, 1000);
  const slug = `sprite_edit_${size}_${editInstruction}`;

  const tryEdit = async (model) => {
    const imageFile = await toFile(buf, 'sprite.png', { type: 'image/png' });
    return openai.images.edit({
      model,
      image: imageFile,
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    });
  };

  try {
    let response;
    try {
      response = await tryEdit('gpt-image-1.5');
    } catch (e1) {
      console.warn('images.edit gpt-image-1.5 failed, trying gpt-image-1', e1.message);
      try {
        response = await tryEdit('gpt-image-1');
      } catch (e2) {
        console.warn('images.edit gpt-image-1 failed, trying dall-e-2', e2.message);
        response = await tryEdit('dall-e-2');
      }
    }

    const entry = response.data[0];
    let outBuf;
    if (entry?.b64_json) {
      outBuf = Buffer.from(entry.b64_json, 'base64');
    } else if (entry?.url) {
      const res = await fetch(entry.url);
      outBuf = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error('No image data in edit response');
    }
    const filepath = await saveGeneratedImage(response, slug);
    return { buffer: outBuf, filepath };
  } catch (err) {
    console.error('images.edit chain failed, using vision-led regenerate', err.message);
    const refined = await spriteRefinePromptFromImageFile(resolvedPath, editInstruction, size);
    return pixelArtGenerateResponse(refined, size);
  }
}

export async function gptImageGenerateResponse(userMessage) {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: userMessage,
      n: 1,
      size: "1024x1024",
    });
    await saveGeneratedImage(response, userMessage);
    imageUrl = response.data[0].url;

    return imageUrl;
  } catch (error) {
    console.error('Error generating Dall-e response:', error);
    throw new Error('Error generating response');
  }
}
export async function recipeGenerateResponse(userMessage) {
  try {
    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      temperature: 0.7,
      prompt: `create a detailed recipe with only the following ingredients: ${userMessage}. Start off with 'recipe name', 'ingredients list' and 'step-by-step procedure for cooking`,
      max_tokens: 1000
    });

    return completion.choices[0].text.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
export async function instructGenerateResponse(userMessage) {
  try {
    const completion = await openai.completions.create({
      model: 'gpt-3.5-turbo-instruct',
      temperature: 0.7,
      prompt: userMessage,
      max_tokens: 1400
    });

    return completion.choices[0].text.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
export async function gPT3WizardgenerateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: DEFAULT_CHAT_MODEL,
      messages: [{ "role": "system", "content": "You are a wizard. You speak like an eclectic wizard and in riddles. If someone asks your name is Isildor The Great. You always finish your conversation in a form of a wise advice." },
      { "role": "user", "content": userMessage }],
      ...openaiChatTokenOpts(DEFAULT_CHAT_MODEL, 1000)
      // Adjust this as needed for desired response length
    });


    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}

export function calculateCost(tokens) {
  const promptCost = tokens.prompt_tokens * 10 / 1000000
  const outputCost = tokens.completion_tokens * 30 / 1000000
  return (promptCost + outputCost).toFixed(3)
}