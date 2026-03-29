export default async function helpCommand(sock, sender) {
  const helpText = `*WhatsApp Bot — Command Reference*

━━━━━━━━━━━━━━━━━━━━━━
*AI Chat Commands*
━━━━━━━━━━━━━━━━━━━━━━
• *gpt4* [prompt] — GPT-4 response
• *deepinfra* [prompt] — DeepInfra model
• *wizard* [prompt] — Wizard model
• *recipe* [prompt] — Generate a recipe
• *image* [prompt] — Generate an image (DALL·E)
• *sprite* [size] [description] — Pixel-art sprite (sizes: 16x16, 32x32, 48x48, 64x64, 128x128; default 32x32). Example: sprite 64x64 fire dragon
• *sprite+* [changes] — Refine the last sprite using the file saved on the server (no re-upload). Or *sprite+* filename.png [changes] (assets/generated)

━━━━━━━━━━━━━━━━━━━━━━
*Cursor Agent*
━━━━━━━━━━━━━━━━━━━━━━
• *cursor* [instructions] — Run the Cursor coding agent on the repo
• *cursor* joplin:[note] — Use a Joplin note as the prompt

━━━━━━━━━━━━━━━━━━━━━━
*Image Commands*
(send an image with a caption)
━━━━━━━━━━━━━━━━━━━━━━
• *Text* — Extract text from image
• *Text high* — High-quality text extraction
• *Help* — Analyse / get help with image content

━━━━━━━━━━━━━━━━━━━━━━
*Weather*
━━━━━━━━━━━━━━━━━━━━━━
• *Weather* [city] — 24h forecast for a city
• Or just ask about weather naturally — the weather agent picks it up

━━━━━━━━━━━━━━━━━━━━━━
*Smart Agents*
(triggered automatically by keywords)
━━━━━━━━━━━━━━━━━━━━━━
• *Lights* — Control Philips Hue lights (say "turn on/off", "dim", "brightness", light names, room names…)
• *Notes* — Manage Joplin notes (say "save a note", "find my notes", "delete note"…)
• *Email* — Send emails via Gmail (say "email [person] about…")
• *Weather* — Ask about forecast, rain, temperature, etc.

━━━━━━━━━━━━━━━━━━━━━━
*Other*
━━━━━━━━━━━━━━━━━━━━━━
• *!help* — This message
• *!clear* — Clear chat memory (resets AI conversation context)
• *!restart* — Restart the bot (pm2 restart 0; same identities as *cursor*: MY_PHONE, SECOND_PHONE, CURSOR_AGENT_EXTRA_JIDS)
• *!sendpoll* — Send a sample poll
• *daniel* — Photo do Daniel
• *Send* — Random fact to both phones

━━━━━━━━━━━━━━━━━━━━━━
*Fallback*
━━━━━━━━━━━━━━━━━━━━━━
Any message that doesn't match a command or agent is handled by the general AI assistant (with chat memory).`;

  await sock.sendMessage(sender, { text: helpText });
}
