# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js (ESM, ES modules — `"type": "module"`) WhatsApp bot built on Baileys
(`@whiskeysockets/baileys`, an unofficial WhatsApp Web client). It listens on a linked WhatsApp
device and routes inbound messages to commands, "agents" (small NL-triggered assistants), or an
OpenAI-backed chat fallback. `claude…` messages are forwarded to agent-runner
(`/home/alexis/Projects/agent-runner`, a separate PM2 process), which runs the Claude Code CLI
headlessly — including working GitHub issues end-to-end and the cron issue tracer. The bot itself
no longer spawns `claude`.

The repo also contains several loosely-related side projects (a React chat UI, a Philips Hue
controller, a Joplin notes integration, a Pokémon-playing vision demo, a streaming server) that
share this top-level `package.json`/`node_modules` but are otherwise independent — see
"Side projects" below.

Deployment target is a Raspberry Pi under PM2 (see references to "the Pi" and `pm2 restart`).

## Commands

```bash
npm start              # node --no-deprecation whatsapp.js — main bot process
npm test               # node --test ./test/**/*.test.js — full test suite (node:test, no framework)
node --test test/foo.test.js          # run a single test file
node --test --test-name-pattern="…" test/foo.test.js   # run a single test by name
npm run eval:summarize -- --all       # offline eval for the `summarize` command against fixtures/gold
npm run start:joplin    # node --no-deprecation test-joplin.js — standalone Joplin integration check
```

There is no lint/typecheck script at the repo root (JSDoc types are used for editor/AI hints
only, not enforced by `tsc`). The `ChatAI/` sub-project has its own `npm run lint` (ESLint) and
`npm run build` (Vite) — run those from inside `ChatAI/`, not the repo root.

Tests are plain `node:test` + `node:assert/strict`, no mocking library — dependencies are
injected as plain objects/functions and tests pass fakes directly (see "Testing" below).

## Contributing workflow

See `CONTRIBUTING.md`. In short: branch off up-to-date `main` per GitHub issue
(`git checkout -b issue/42-short-description`), commit, push, open a PR with `gh pr create --base
main`. agent-runner replicates the same flow (branch, PR-per-issue) when it works issues
unattended.

## Architecture

### Message flow (ports-and-adapters)

`whatsapp.js` owns the Baileys socket lifecycle (auth, QR pairing, reconnect/backoff, logout
handling) and wires up cron-style background jobs on `connection === 'open'`. Baileys is pinned
to 7.x (currently `7.0.0-rc14`). Before the first socket opens, `whatsapp/baileysAuthBackup.js`
copies `.auth/baileys` once to `.auth/baileys-pre-v7-backup` (never overwritten; 7.x migrates
stored sessions to LID format one-way) — restoring that folder plus pinning `6.7.24` is the
rollback path. It delegates all message handling to `whatsapp/orchestration/`, which is a small
hexagonal/ports architecture:

- `createBaileysMessageHandler.js` — thin Baileys-specific adapter: dedupes `fromMe`, marks read
  receipts, normalizes the raw message, catches/reports errors back to the sender.
- `normalizeBaileysMessage.js` — maps a raw Baileys `WAMessage` into a plain
  `InboundMessage` (`{ id, chatId, actorId, actorAltId, text, raw, features }`).
- `createProductionPorts.js` — builds the concrete ports object (real Baileys `sock`, real
  filesystem, real command registry, real agents) that the orchestrator runs against. Swap this
  factory out (see `test/messageOrchestrator.test.js`) to test orchestration logic without a
  socket.
- `createMessageOrchestrator.js` — the actual routing decision tree, in priority order:
  1. button-label side effect (writes `button.txt`, used by the Pokémon-playing Lua script)
  2. inbound image + caption (`Text`/`Text high`/`Help` → vision commands)
  3. `sprite+` / `sdxl+` prefix → iterate-on-last-image commands
  4. first whitespace token matches a registered command (`whatsapp/commands/index.js`)
  5. legacy inline routes (`!help`, `!restart`, `!clear`, `!sendpoll`, `Send`, `Altweather`)
  6. the sequential **agent chain** (see below)
  7. fallback: OpenAI assistant chat with per-chat memory (`whatsapp/chatMemory.js`)
- `agentsTryHandle.js` (`runAgentsChainSequential`) — runs NL-intent agents in a fixed order
  (reminder → lights → weather → joplin → email), each with a `shouldTryX(text)` gate and a
  `SKIP` sentinel string convention: an agent's LLM call can return exactly `LIGHTS_AGENT_SKIP`
  (etc.) to mean "not actually for me," letting the chain fall through to the next agent instead
  of committing to a reply.

When adding a new command or agent, wire it through `commands/index.js` or the agent chain in
`createProductionPorts.js`/`agentsTryHandle.js` — don't special-case it directly in
`whatsapp.js`.

**LIDs:** on Baileys 7.x the sender (`actorId`) and chat id (`chatId`) may be a `@lid`
(WhatsApp's privacy id) instead of a phone-number JID. The other form, when WhatsApp sends it,
lives on the message key — `remoteJidAlt` in DMs, `participantAlt` in groups (surfaced as
`actorAltId`). Never assume an inbound id carries a phone number; match on both forms. Anything
keyed by chat id (e.g. per-chat assistant memory in `chatMemory.js`) sees a LID chat as a new
chat. Sending to a phone-number JID still works.

### Access control

`whatsapp/whatsAppActorAllowlist.js` gates privileged actions (the `claude` command, `!restart`).
It matches `MY_PHONE`/`SECOND_PHONE` against both `@s.whatsapp.net` and `@c.us` JID forms, and
separately allowlists `@lid` (linked-device) identities via `CLAUDE_AGENT_EXTRA_JIDS` since those
don't carry a matchable phone number. The owner is also recognised from a `@lid` when the
message key's alternate id (`participantAlt` / `remoteJidAlt`, surfaced as `actorAltId`) is an
allowed phone JID, or when the LID was resolved from `MY_PHONE`/`SECOND_PHONE` via the socket's
LID mapping store on connect (`resolveOwnerLids`). Failed
lookups or malformed ids deny. Any code path that can reach agent-runner or trigger a
restart must check `isAllowedActor(actorId)` first.

### Claude agent: delegated to agent-runner

Design: `docs/adr/0001-agent-runner-out-of-process.md`. The Claude CLI pipeline (freeform runs,
`joplin:` runs, the GitHub issue pipeline, post-run PR/review/merge, the cron issue tracer,
telemetry and the `agent:*` status CLI) lives in agent-runner, not here. The bot's side is
`whatsapp/agentRunner/`:

- The orchestrator forwards every message whose first token is `claude` or `claude:…` (after
  `isAllowedActor`) to the runner's localhost HTTP API (`AGENT_RUNNER_URL`, default
  `http://127.0.0.1:3790`) and sends back its immediate reply. Nothing `claude…` reaches the
  command registry.
- `!restart` refuses while a runner run is active (a bot restart mid-run can load a half-edited
  checkout); an unreachable runner doesn't block it.
- Run results arrive asynchronously through the runner's Redis Stream outbox
  (`agent-runner:outbox`). The bot drains it with its own cursor in Redis, one merged message per
  recipient per poll; backlog from while the bot was down is summarised as "you missed N" instead
  of replayed, and `claude:missed` (answered in the bot) lists it.

### Other background jobs started from `whatsapp.js`

- `whatsapp/reminders/` — "remind me"/"nudge me" NL parsing (`reminderParser.js`), a local JSON
  store (`reminderStore.js`), and a poller (`reminderScheduler.js`) with an at-most-once delivery
  state machine (`pending → delivering → fired`) that survives restarts and does a catch-up tick
  on reconnect.
- `whatsapp/agents/redditCronDigest.js` — polls a status file written by a *different* project
  (`reddit-bot`) and forwards a daily digest once it's fresh for the current UTC day.

Both are feature-flagged/tunable entirely through env vars documented in `.env.example` — check
there before assuming a default interval/threshold.

### Side projects (independent of the bot's request path)

These share the root `package.json` but are not imported by `whatsapp.js`:

- `ChatAI/` — separate Vite/React app (its own `package.json`, `npm run dev`/`build`/`lint`) that
  talks to this server's OpenAI-proxying routes (see `index.js` for the Express routes it hits:
  `/gpt3`, `/gpt4`, `/dalle`, `/instruct`, `/recipe`, `/weather`, `/whatsapp?:number`).
- `hue/` — Philips Hue bridge client (`HUE_IP`/`HUE_USERNAME`), wired into the WhatsApp agent
  chain via `whatsapp/agents/lightsAgent.js` + `whatsapp/commands/lights.js`.
- `joplin/` — Joplin Data API client, wired in via `whatsapp/agents/joplinAgent.js` +
  `whatsapp/commands/joplin.js`, and reused as a prompt source for `claude joplin:<note>`.
- `codeHelper/`, `simongame/`, `stream.js`/`stream.html` (node-media-server RTMP relay),
  `vision.js`/`pokemon.lua` (GPT-4 Vision plays Pokémon Red by writing button presses to
  `button.txt`, read by the Lua script in an emulator) — standalone demos, not part of the bot's
  runtime message path.

## Testing

- `test/*.test.js` uses `node:test` + `node:assert/strict` directly — no Jest/Mocha/Sinon.
- Because the orchestration layer is ports-based, most tests build a fake `ports` object (see
  `basePorts()` in `test/messageOrchestrator.test.js`) rather than mocking Baileys or `fetch`.
  Prefer that pattern for new orchestration/agent tests over module-level mocking.
- `eval/summarize/` is a separate, non-`node:test` eval harness (`run.mjs`) for scoring the
  `summarize` command's LLM output against hand-authored gold facts; it's exercised inside the
  test suite via `test/summarizeEval.test.js` but can also be run standalone with
  `npm run eval:summarize`.

## Environment configuration

`.env.example` is the source of truth for optional/tunable env vars (cron intervals, disable
flags, file paths for reminders/reddit-digest state, storage limits). When adding a new
env-gated feature, add a commented example there rather than only documenting it in code
comments.

## Agent skills

### Issue tracker

GitHub Issues (alexisNorthcoders/WhatsappBot), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (root `CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.
