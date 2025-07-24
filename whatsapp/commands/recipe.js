const { recipeGenerateResponse } = require("../../models/models");

module.exports = async function recipeCommand(sock, sender, text) {
    const prompt = text.replace("Recipe ", "");
    const response = await recipeGenerateResponse(prompt);
    await sock.sendMessage(sender, { text: response });
}