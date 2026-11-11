import { gptImageGenerateResponse } from "../../models/models.ts";
import type { Command } from '../types.ts';

const imageCommand: Command = async (sock, sender, text) => {
    const prompt = text.replace(/^\s*image\s+/i, '');
    const image = await gptImageGenerateResponse(prompt);
    await sock.sendMessage(sender, { image, caption: prompt });
};

export default imageCommand;
