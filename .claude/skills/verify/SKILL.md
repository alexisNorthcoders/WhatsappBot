---
name: verify
description: Drive the WhatsApp bot's real message pipeline with a synthetic inbound message and capture the reply, without opening a WhatsApp socket. Use to prove a change to commands, agents (Joplin, lights, reminders, weather), routing, the allowlist or the assistant fallback works against the real services, before or after a deploy.
---

# Verify the WhatsApp bot

The user's surface is a WhatsApp chat: they send text, the bot replies. `drive.ts` feeds messages into the same handler `whatsapp.ts` builds (`createBaileysMessageHandler` → allowlist → normalize → orchestrator → commands, agents, assistant). The Baileys socket is replaced by a recorder, so replies are captured instead of sent. Everything behind the bot is real: OpenAI, DeepInfra, Jev routing, the Hue bridge, the Joplin CLI, Google Calendar and Gmail.

Read `features/README.md` before driving, then the feature file for the behavior you changed.

## Launch

There is nothing to launch. Each `drive.ts` call is its own short-lived process that loads `.env` from the repo root and the Hue light list (as `whatsapp.ts` does at startup), sends its messages, writes evidence and exits.

Never start a second copy of the bot (`npm start`) for verification. It would open a second socket on the same linked device in `.auth/baileys`, and the two would keep disconnecting each other. The live bot is the PM2 app `whatsapp`. Restarting it is a deploy: ask the user first.

## Doctor

```bash
.claude/skills/verify/doctor.sh
```

Read-only. It checks Node 24+, `.env`, `MY_PHONE`, `node_modules`, the Joplin CLI (`JOPLIN_BIN` or `joplin` on PATH), the Hue bridge, agent-runner `/status`, and reports whether the live bot is online. Any `FAIL` exits 1: fix it before driving. A `WARN` means journeys for that service will fail.

## Drive

```bash
node --no-deprecation .claude/skills/verify/drive.ts "<message text>"
node --no-deprecation .claude/skills/verify/drive.ts --as second "<message text>"
node --no-deprecation .claude/skills/verify/drive.ts --as stranger "<message text>"
node --no-deprecation .claude/skills/verify/drive.ts "<first message>" "<second message>"
```

- `--as owner` (default) sends from `MY_PHONE`, `second` from `SECOND_PHONE`, `stranger` from an unlisted number.
- Each run uses a fresh chat `verify-<timestamp>@g.us`, so chat memory and numbered lists never touch the owner's real DM. `--chat <jid>` overrides it.
- Several messages in one call run in order in the same chat and process. Multi-turn journeys ("list reminders" then "cancel 1", a turn then `!clear`) must be one call: chat memory and numbered lists live in the process and are gone in the next call.
- stdout prints each message as `[N] <text>`, its replies as `→ <chat>` followed by the text, or `(no reply sent)`, then the evidence path. Exit code 1 means the harness itself threw.
- The handler catches errors inside a journey and replies `Sorry, there was an error processing your message...`. That reply is a failure, not a pass. Read the log for the cause.
- `claude…` messages are recorded in `forwardedToAgentRunner` and answered with `[verify] not forwarded to agent-runner`. A real forward would start a Claude run. Only `!restart`'s runner check calls the real agent-runner, and only `/status`.
- Images are not supported. The vision routes need a real media download.

## Evidence

Each run writes, under `logs/verify/` (gitignored):

- `<timestamp>.json` with the input (messages, actor, chat), every reply with its turn number and recipient, anything forwarded to agent-runner, the harness error, and the duration;
- `<timestamp>.log`, the bot's pino log at debug level for that run. Routing decisions show as `"Jev route"`, allowlist drops as `"Ignoring message from non-owner sender"`.

Proof standards:

- Drive the user's words, as a user would type them. Don't call agent functions directly.
- Quote the reply and the log line that shows which route handled it. A plausible reply from the assistant fallback is not proof a feature works: check the route (see `features/README.md`).
- For anything that changes a real system (a light, a Joplin note, a calendar event), prove the side effect with a second, read-only drive ("lights status", "list my joplin notes", "list reminders"), then undo it.
- Verifying a deploy also needs the live bot: after the user approves `pm2 restart whatsapp`, check `pm2 logs whatsapp --lines 30 --nostream` for `✅ WhatsApp connected.`

## Cleanup

`drive.ts` leaves no process behind. Undo real side effects as each feature file says. Old evidence can be pruned with

```bash
.claude/skills/verify/cleanup.sh 7
```

which deletes `logs/verify` files older than 7 days and keeps the current run's evidence.
