import { recipeGenerateResponse } from "../../models/models.js";

export default async function recipeCommand(sock, sender, text) {
    const prompt = text.replace("Recipe ", "");
    const response = await recipeGenerateResponse(prompt);
    await sock.sendMessage(sender, { text: response });
}