import { input, confirm } from "@inquirer/prompts";
import OpenAI from 'openai';
import { openaiChatTokenOpts } from '../models/models.js';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CODE_HELPER_MODEL = process.env.OPENAI_CODE_CHAT_MODEL || 'gpt-5-mini';

async function askForPrompt() {
  const answers = await input({ message: 'Insert your prompt: ' });
  await confirm({ message: 'Continue?' });
  return answers;
}

async function run() {
  const promptText = await askForPrompt();
  const response = await codeResponse(promptText);
  console.log(response)

}
async function codeResponse(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: CODE_HELPER_MODEL,
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You are a helper. Keep your answers short and to the point. You are being used in a terminal so keep your answers properly formatted." },
        { "role": "user", "content": userMessage }],
      ...openaiChatTokenOpts(CODE_HELPER_MODEL, 1000),

    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating gpt response:', error);
  }
}
run();
