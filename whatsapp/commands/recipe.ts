import { recipeGenerateResponse } from "../../models/models.ts";
import type { Command, TextSender } from '../types.ts';

const recipeCommand: Command<TextSender> = async (sock, sender, text) => {
    const prompt = text.replace("Recipe ", "");
    const response = await recipeGenerateResponse(prompt);
    await sock.sendMessage(sender, { text: response });
};

export default recipeCommand;
