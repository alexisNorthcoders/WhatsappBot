const { deepInfraAPI } = require('../../models/models');

module.exports = async function deepInfraCommand(sock, sender, text) {
    const prompt = text.replace("Deepinfra ", "");
    const response = await deepInfraAPI(prompt);
    await sock.sendMessage(sender, { text: response });
};
