import { gPT4generateResponse } from "../../models/models.js";

export default async function gpt4Command(sock, sender, text) {
  const prompt = text.replace(/^gpt4\s*/i, '');
  const response = await gPT4generateResponse(prompt);
  await sock.sendMessage(sender, { text: response });
}
