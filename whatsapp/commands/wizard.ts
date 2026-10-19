import { gPT3WizardgenerateResponse } from "../../models/models.ts";
import type { Command, TextSender } from '../types.ts';

const wizardCommand: Command<TextSender> = async (sock, sender, text) => {
    const prompt = text.replace("Wizard ", "");
    const response = await gPT3WizardgenerateResponse(prompt);
    await sock.sendMessage(sender, { text: response });
};

export default wizardCommand;
