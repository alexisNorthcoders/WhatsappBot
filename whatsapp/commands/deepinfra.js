import { deepInfraAPI } from '../../models/models.js';

export default async function deepInfraCommand(sock, sender, text) {
    const prompt = text.replace("Deepinfra ", "");
    const response = await deepInfraAPI(prompt);
    await sock.sendMessage(sender, { text: response });
}
