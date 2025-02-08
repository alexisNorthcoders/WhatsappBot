import { input, confirm } from "@inquirer/prompts";
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


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
      model: 'gpt-4o',
      temperature: 0.7,
      messages: [
        { "role": "system", "content": "You are a senior software engineer. You will respond just with typescript code unless asked otherwise." },
        { "role": "user", "content": userMessage }],
      max_tokens: 1000

    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating gpt response:', error);
  }
}
run();