import { gptImageGenerateResponse } from "../../models/models.js";

export default async function imageCommand(sock, sender, text) {
    const prompt = text.replace("Image ", "");
    const url = await gptImageGenerateResponse(prompt);
    await sock.sendMessage(sender, { image: { url }, caption: prompt });
}
