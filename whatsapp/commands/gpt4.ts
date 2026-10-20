import { gPT4generateResponse } from "../../models/models.ts";
import type { Command, TextSender } from '../types.ts';

const gpt4Command: Command<TextSender> = async (sock, sender, text) => {
  const prompt = text.replace(/^gpt4\s*/i, '');
  const response = await gPT4generateResponse(prompt);
  await sock.sendMessage(sender, { text: response });
};

export default gpt4Command;
