const { gptImageGenerateResponse } = require("../../models/models");

module.exports = async function imageCommand(sock, sender, text) {
    const prompt = text.replace("Image ", "");
    const url = await gptImageGenerateResponse(prompt);
    await sock.sendMessage(sender, { image: { url }, caption: prompt });
};
