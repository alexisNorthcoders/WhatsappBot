import { deepInfraAPI } from '../../models/models.ts';
import type { Command, TextSender } from '../types.ts';

const deepInfraCommand: Command<TextSender> = async (sock, sender, text) => {
    const prompt = text.replace("Deepinfra ", "");
    const response = await deepInfraAPI(prompt);
    await sock.sendMessage(sender, { text: response });
};

export default deepInfraCommand;
