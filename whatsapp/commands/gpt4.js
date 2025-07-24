const { gPT4generateResponse } = require("../../models/models");

module.exports = async function gpt4Command(sock, sender, text) {
  const prompt = text.replace(/^gpt4\s*/i, '');
  const response = await gPT4generateResponse(prompt);
  await sock.sendMessage(sender, { text: response });
};
