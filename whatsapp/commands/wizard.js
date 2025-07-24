const { gPT3WizardgenerateResponse } = require("../../models/models");

module.exports = async function wizardCommand(sock, sender, text) {
    const prompt = text.replace("Wizard ", "");
    const response = await gPT3WizardgenerateResponse(prompt);
    await sock.sendMessage(sender, { text: response });
};
