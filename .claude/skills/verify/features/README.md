# WhatsApp bot verification map

This directory is the maintained source for verifying what the bot does for its owner in WhatsApp. Read this index first, then use the matching feature file as the recipe.

## Baseline preconditions

- `.claude/skills/verify/doctor.sh` exits 0.
- Commands run from the repo root as `node --no-deprecation .claude/skills/verify/drive.ts "<text>"`, written below as `drive "<text>"`.
- The live bot (PM2 `whatsapp`) keeps running. Never drive with `npm start`.

## Driving conventions

- Every message goes through the real handler, in the bot's routing order: registered command, legacy `!` routes, agent chain (reminder, lights, weather, joplin, email, home, books, with Jev routing first when `TYPESAFE_API_KEY` is set), then the assistant fallback.
- Find the route in the run's `.log`. `"Executing command: <name>"` is a registered command. `"Jev route"` names the agent Jev chose. If an agent returns its `SKIP` sentinel or `null`, the reply comes from the assistant fallback. A generic AI answer to a feature request means the feature failed.
- Agent replies are LLM-written. Assert on facts (names, counts, ids, states), not wording.
- Turns that depend on each other go in one `drive` call, as separate quoted arguments.
- Restore any real state you change. Never remove evidence in `logs/verify/`.

## Proof and skip reporting

- Quote the reply, the route log line and the evidence path for each journey.
- Mutation proof includes a read-only second drive showing the new state, and the undo.
- Report an unreachable journey with the command tried and the unmet precondition (for example doctor's Hue `WARN`).
- Don't report a journey as verified through a different entry point.

## Do not drive without the user asking

- Email ("email X about Y"): the email agent sends real mail from Gmail.
- `!restart` as owner: runs `pm2 restart whatsapp` on the live bot.
- `Send`: harmless here (replies are recorded), but it spends two DeepInfra calls.

## Features

- [Commands](./commands.md) covers `!help`, `!clear` and the registered commands.
- [Joplin notes](./joplin.md) covers listing, reading and creating notes in the `WhatsApp Bot` notebook.
- [Lights](./lights.md) covers the Hue status list and switching lights.
- [Reminders](./reminders.md) covers calendar lists, creating a reminder and cancelling it.
- [Access control](./access.md) covers the owner allowlist, `claude…` forwarding and the `!restart` runner guard.
