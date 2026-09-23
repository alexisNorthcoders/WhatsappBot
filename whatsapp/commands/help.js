import { REMINDER_COMMAND_HELP_SNIPPET } from '../reminders/reminderParser.js';

export default async function helpCommand(sock, sender) {
  const helpText = `*WhatsApp Bot — Command Reference*

━━━━━━━━━━━━━━━━━━━━━━
*AI Chat Commands*
━━━━━━━━━━━━━━━━━━━━━━
• *gpt4* [prompt] — GPT-4 response
• *deepinfra* [prompt] — DeepInfra model
• *summarize*|*summarise* <url> [extra] — Optional focus text after the URL. Fetch page, extract article text, short DeepInfra summary
• *wizard* [prompt] — Wizard model
• *recipe* [prompt] — Generate a recipe
• *image* [prompt] — Generate an image (DALL·E)
• *sdxl* [size] [prompt] — Generate an image (SDXL Turbo via DeepInfra; sizes: 256x256, 512x512, 768x768, 1024x1024; default 1024x1024)
• *sdxl+* [changes] — Iterate on the latest SDXL output for this chat (each *sdxl+* becomes the new base — chain refinements). Examples: sdxl+ add sunset lighting · sdxl+ more contrast. Or *sdxl+* filename.png [changes] (assets/generated)
• *sprite* [size] [description] — Pixel-art sprite (sizes: 16x16, 32x32, 48x48, 64x64, 128x128; default 32x32). Example: sprite 64x64 fire dragon
• *sprite+* [changes] — Refine the last sprite using the file saved on the server (no re-upload). Or *sprite+* filename.png [changes] (assets/generated)
• *home* <question> — Ask the home-manuals service about appliances/manuals (e.g. home what model is the oven?); replies with the answer plus Sources

━━━━━━━━━━━━━━━━━━━━━━
*Claude Agent*
━━━━━━━━━━━━━━━━━━━━━━
• *claude* [instructions] — Run the Claude agent on this bot’s repo (default workspace)
• *claude* *alias*: [instructions] — Run in an allowlisted repo (set CLAUDE_WORKSPACE_MAP in .env)
• *claude* */absolute/path/to/repo* [instructions] — Same, using an absolute path from the allowlist
• *claude:history* [n] — List the last n (default 10, max 30) GitHub issue runs by the agent: repo, #issue, title, outcome, time ago
• *claude:status* — Snapshot of the Claude agent: active run (or idle), pauses, last cron tick, last 3 issue runs
• *claude* joplin:[note] — Use a Joplin note as the prompt (workspace stays default unless you use alias/path before joplin)
• *claude* issue:[n] [extra] — Use GitHub issue #n as the prompt (repo: git origin of the selected workspace, else GH_ISSUE_REPO, else alexisNorthcoders/WhatsappBot)
• *claude* issue:[alias]:[n] [extra] — Same, but run in that allowlisted workspace (CLAUDE_WORKSPACE_MAP alias). Repo: CLAUDE_ISSUE_REPO_MAP for that alias, else that workspace’s origin, else GH_ISSUE_REPO / default
• *claude* [your-alias]: issue:[n] — Workspace from your alias; issue repo follows the same rules from that workspace (map → origin → env/default)

━━━━━━━━━━━━━━━━━━━━━━
*Image Commands*
(send an image with a caption)
━━━━━━━━━━━━━━━━━━━━━━
• *Text* — Extract text from image
• *Text high* — High-quality text extraction
• *Help* — Analyse / get help with image content

━━━━━━━━━━━━━━━━━━━━━━
*Smart Agents*
(triggered automatically by keywords)
━━━━━━━━━━━━━━━━━━━━━━
• *Lights* — Control Philips Hue lights (say "turn on/off", "dim", "brightness", light names, room names…)
• *Notes* — Manage Joplin notes (say "save a note", "find my notes", "delete note"…, or "save https://… to Joplin" / "fetch this page to a note")
• *Email* — Send emails via Gmail (say "email [person] about…")
• *Weather* — Ask naturally: e.g. weather, forecast, temperature, rain/snow/storm, wind, humidity, sunny/cloudy, °C/°F, "will it rain", "how hot/cold", "what's it like outside". Name a city if you want; otherwise the bot uses its default city.
• *Home* — Ask naturally about appliances/manuals (e.g. "what boiler do we have?", "how do I descale the coffee machine?")
• *Reminders* — ${REMINDER_COMMAND_HELP_SNIPPET}

━━━━━━━━━━━━━━━━━━━━━━
*Other*
━━━━━━━━━━━━━━━━━━━━━━
• *!help* — This message
• *!clear* — Clear chat memory (resets AI conversation context)
• *!restart* — Restart the bot (pm2 restart 0; same identities as *claude*: MY_PHONE, SECOND_PHONE, CLAUDE_AGENT_EXTRA_JIDS)
• *!sendpoll* — Send a sample poll
• *daniel* — Photo do Daniel
• *Send* — Random fact to both phones

━━━━━━━━━━━━━━━━━━━━━━
*Fallback*
━━━━━━━━━━━━━━━━━━━━━━
Any message that doesn't match a command or agent is handled by the general AI assistant (with chat memory).`;

  await sock.sendMessage(sender, { text: helpText });
}
