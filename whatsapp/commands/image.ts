import { gptImageGenerateResponse } from "../../models/models.ts";
import type { Command } from '../types.ts';

const imageCommand: Command = async (sock, sender, text) => {
    const prompt = text.replace("Image ", "");
    const url = await gptImageGenerateResponse(prompt);
    await sock.sendMessage(sender, { image: { url }, caption: prompt });
};

export default imageCommand;
