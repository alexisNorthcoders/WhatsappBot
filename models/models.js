import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, '..', 'assets', 'generated');

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
    }
    console.log(`Saved generated image: ${filepath}`);
  } catch (err) {
    console.error('Failed to save generated image:', err.message);
  }
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. You are inside a whatsapp conversation. You have many capabilities. You can tell the weather, recipes, tell jokes and so on.',
        },
        ...history,
        { role: 'user', content: String(userMessage).slice(0, CHAT_HISTORY_CONTENT_CAP) },
      ],
      max_tokens: 1000,
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating GPT-3 response:', error);
    throw new Error('Error generating response');
  }
}
export async function gPT4generateResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You will always give your responses summarized in bullet points unless asked otherwise." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000

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
      model: 'o4-mini',
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You are a senior software engineer. You will respond just with typescript code unless asked otherwise." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000

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
    model: "gpt-4o-mini",
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
    max_tokens: 10000,
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
export async function vision(base64) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
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
    max_tokens: 1500,
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
export async function visionHelp(base64) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
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
    max_tokens: 1500,
  });
  console.log(response.usage)
  console.log(`Total cost: $${calculateCost(response.usage)}`)
  return response.choices[0].message.content;
}
const VALID_SPRITE_SIZES = ['16x16', '32x32', '48x48', '64x64', '128x128'];

export async function pixelArtGenerateResponse(userMessage, size = '32x32') {
  try {
    const pixelArtPrompt = [
      `Create a ${size} pixel art game sprite of: ${userMessage}.`,
      `Style rules: clean pixel art, limited retro color palette,`,
      `hard-edged pixels with NO anti-aliasing or blur,`,
      `transparent background, centered on canvas,`,
      `suitable for a 2D game sprite sheet.`,
    ].join(' ');

    const response = await openai.images.generate({
      model: 'gpt-image-1.5',
      prompt: pixelArtPrompt,
      n: 1,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
    });

    await saveGeneratedImage(response, `sprite_${size}_${userMessage}`);
    return Buffer.from(response.data[0].b64_json, 'base64');
  } catch (error) {
    console.error('Error generating pixel art sprite:', error);
    throw new Error('Error generating pixel art sprite');
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
      model: 'gpt-4o-mini',
      messages: [{ "role": "system", "content": "You are a wizard. You speak like an eclectic wizard and in riddles. If someone asks your name is Isildor The Great. You always finish your conversation in a form of a wise advice." },
      { "role": "user", "content": userMessage }],
      max_tokens: 1000
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