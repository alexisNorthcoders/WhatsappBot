module.exports = async function helpCommand(sock, sender) {
  const helpText = `Try commands:
- Deepinfra [prompt]
- Wizard [prompt]
- Gpt4 [prompt]
- Dalle [prompt]
- Recipe [prompt]
- Weather [city]
- Text (image commands)
- ...`;
  await sock.sendMessage(sender, { text: helpText });
};
