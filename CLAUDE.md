# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js (ESM, ES modules — `"type": "module"`) WhatsApp bot built on Baileys
(`@whiskeysockets/baileys`, an unofficial WhatsApp Web client). It listens on a linked WhatsApp
device and routes inbound messages to commands, "agents" (small NL-triggered assistants), or an
OpenAI-backed chat fallback. A significant part of the codebase is a self-hosted Claude Code CLI
automation pipeline: the bot can spawn `claude` headlessly to work GitHub issues end-to-end
(fetch issue → branch → run agent → commit → open PR → self-review → auto-merge), triggered
either manually from WhatsApp or by a cron-style poller.

The repo also contains several loosely-related side projects (a React chat UI, a Philips Hue
controller, a Joplin notes integration, a Pokémon-playing vision demo, a streaming server) that
share this top-level `package.json`/`node_modules` but are otherwise independent — see
"Side projects" below.

Deployment target is a Raspberry Pi under PM2 (see references to "the Pi" and `pm2 restart` in
logs/messages throughout the agent code — the Claude CLI agent is explicitly instructed never to
restart the PM2 process that spawned it, since the parent is waiting to report the result back).

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
main`. This convention matters here because the Claude CLI automation pipeline (see below)
programmatically replicates the same flow (branch naming, PR-per-issue) when it works issues
unattended.

## Architecture

### Message flow (ports-and-adapters)

`whatsapp.js` owns the Baileys socket lifecycle (auth, QR pairing, reconnect/backoff, logout
handling) and wires up cron-style background jobs on `connection === 'open'`. Baileys is pinned
to 7.x (currently `7.0.0-rc14`). Before the first socket opens, `whatsapp/baileysAuthBackup.js`
copies `.auth/baileys` once to `.auth/baileys-pre-v7-backup` (never overwritten; 7.x migrates
stored sessions to LID format one-way) — restoring that folder plus pinning `6.7.24` is the
rollback path. It delegates all message handling to `whatsapp/orchestration/`, which is a small hexagonal/ports architecture:

- `createBaileysMessageHandler.js` — thin Baileys-specific adapter: dedupes `fromMe`, marks read
  receipts, normalizes the raw message, catches/reports errors back to the sender.
- `normalizeBaileysMessage.js` — maps a raw Baileys `WAMessage` into a plain
  `InboundMessage` (`{ id, chatId, actorId, actorAltId, text, raw, features }`).

**LIDs:** on Baileys 7.x the sender (`actorId`) and chat id (`chatId`) may be a `@lid`
(WhatsApp's privacy id) instead of a phone-number JID. The other form, when WhatsApp sends it,
lives on the message key — `remoteJidAlt` in DMs, `participantAlt` in groups (surfaced as
`actorAltId`). Never assume an inbound id carries a phone number; match on both forms. Anything
keyed by chat id (e.g. per-chat assistant memory in `chatMemory.js`) sees a LID chat as a new
chat. Sending to a phone-number JID still works.
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

### Access control

`whatsapp/whatsAppActorAllowlist.js` gates privileged actions (the `claude` command, `!restart`).
It matches `MY_PHONE`/`SECOND_PHONE` against both `@s.whatsapp.net` and `@c.us` JID forms, and
separately allowlists `@lid` (linked-device) identities via `CLAUDE_AGENT_EXTRA_JIDS` since those
don't carry a matchable phone number. The owner is also recognised from a `@lid` when the
message key's alternate id (`participantAlt` / `remoteJidAlt`, surfaced as `actorAltId`) is an
allowed phone JID, or when the LID was resolved from `MY_PHONE`/`SECOND_PHONE` via the socket's
LID mapping store on connect (`resolveOwnerLids`). Failed
lookups or malformed ids deny. Any code path that can trigger the Claude CLI agent or a
restart must check `isAllowedActor(actorId)` first.

### Claude CLI agent pipeline (the big one)

This is the most complex subsystem, spread across `whatsapp/agents/claude*.js` and
`whatsapp/commands/claude.js`:

- **Entry points**: `claude <instructions>` (freeform, in the default/bot workspace),
  `claude <alias>: <instructions>` or `claude </abs/path> <instructions>` (run in another
  allowlisted repo), `claude issue:<n>` / `claude issue:<alias>:<n>` (fetch a GitHub issue and
  work it end-to-end), `claude joplin:<note>` (use a Joplin note body as the prompt). Parsing
  lives in `whatsapp/commands/claude.js`.
- **Workspace allowlisting** (`whatsapp/claudeWorkspaces.js`): the bot's own repo root is always
  allowed; additional repos come from `CLAUDE_WORKSPACE_MAP` (`alias=/path,alias2=/path2`) or a
  JSON file at `CLAUDE_WORKSPACE_MAP_FILE`. All paths are realpath-canonicalized and checked
  against the allowlist — this is a security boundary (arbitrary absolute paths are rejected
  unless they resolve to an allowlisted root), so treat changes here as security-sensitive.
- **Single-flight lock** (`whatsapp/agents/claudeAgentBusy.js`): only one Claude CLI run at a
  time across the whole process (manual command and cron tracer share the same lock).
- **Process execution** (`whatsapp/agents/claudeCliAgent.js`): spawns `claude -p
  --dangerously-skip-permissions <prompt>` as a child process, queued (serialized) so overlapping
  WhatsApp messages never interleave repo edits. The prompt is prefixed with an explicit
  instruction telling the agent never to restart/kill the PM2 process that spawned it (the parent
  Node process is waiting synchronously to report the result back over WhatsApp). Output is
  tee'd to `logs/claude-agent/<runId>.log` and capped in memory (`MAX_CAPTURE_BYTES`) before being
  chunked back to WhatsApp (4096-char message limit).
- **Pending-run recovery** (`whatsapp/agents/claudeCliPending.js`): a run's identity (sender, log
  path, workspace) is persisted before spawning and cleared only after the completion message is
  successfully delivered. On process restart, `whatsapp.js` checks for a leftover pending run and
  notifies the owner that a previous run was interrupted (e.g. by a PM2 restart) instead of
  silently losing it.
- **Issue pipeline** (`whatsapp/agents/claudeIssuePipeline.js`, `ghIssueForClaude.js`): fetches
  the issue via `gh`, prepares git state (checkout default branch, pull, create/resume an
  `issue/<n>-...`-style branch — `claudePostRun.js`'s `prepareWorkspaceForGithubIssue`), runs the
  CLI agent, then hands off to post-run automation. Resuming an interrupted run re-injects a
  summary of what already changed so the agent doesn't restart from scratch.
- **Post-run automation** (`whatsapp/agents/claudePostRun.js`, the largest file in the repo):
  for `claude issue:<n>` runs only (freeform runs skip this entirely) — detects git activity
  after the agent exits, commits if needed, pushes, opens a PR via `gh`, waits for
  mergeability, and can auto-merge behind a review-verdict gate
  (`claudePostRunDecisionLogic.js` parses `VERDICT: APPROVE` / `VERDICT: REQUEST_CHANGES`,
  `claudePostRunReviewFollowUp.js` runs an autofix pass on `REQUEST_CHANGES` before re-merging).
  Controlled by `CLAUDE_POST_RUN`, `CLAUDE_POST_RUN_PUSH`, `CLAUDE_POST_RUN_PR` env flags. If the
  agent errors out but left uncommitted work, it commits a WIP snapshot so the next attempt can
  resume cleanly rather than losing the work.
- **Cron issue tracer** (`whatsapp/agents/cronIssueTracer.js`): polls open GitHub issues labeled
  `ready-for-agent` (lowest issue number wins) across this repo and one secondary allowlisted
  workspace (`CRON_PLATFORMER_WORKSPACE_ALIAS`, default `platformer`), runs the exact same
  fetch→prep→agent→post-run pipeline unattended, and tracks per-repo "last started issue"
  (`cronLastStartedIssue.js`) so it doesn't hammer the same issue every tick — but a failed run,
  timeout, or empty (no-git-change) run does *not* count as progress, so it will retry rather than
  silently skip a stuck issue. An issue that already has an open agent PR (`claude/issue-<n>-…`
  head) is worked to get that PR merged (the resume prompt has the agent merge the base in on a
  conflict, then post-run re-runs the review / merge gate), but only once per PR state — PR head +
  base tip, persisted in `cron-pr-attempts.json` (`cronPrAttempts.js`). A PR still blocked in the
  same state is parked (owner told once) until either side moves. Runs only when the agent-busy
  lock is free.

- **Observability** (`claudeAgentCli.js`, `whatsapp/agents/claudeRunTelemetry.js`, `claudeStreamParser.js`,
  `claudeAgentCliFormat.js`): the agent is spawned with `--output-format stream-json --verbose`; the parser
  turns the event stream into a readable `logs/claude-agent/<runId>.log`, live state
  (`logs/claude-agent/active/<runId>.json`), a history line per run (`runs.jsonl`: model, tokens,
  cost) and cron tick state (`cron-state.json`) — all under the bot repo regardless of target
  workspace. `npm run claude:status` / `claude:watch` / `claude:history` / `claude:logs` read them from
  a separate process and flag `orphaned`/`stale` runs when the bot process died. `stdout` returned by
  `runClaudeCliAgent` is the final `result` text, unchanged for callers.

When touching this pipeline, the manual (`commands/claude.js`) and cron
(`cronIssueTracer.js`) paths are meant to share the exact same underlying functions
(`runIssueFetchAndGitPrep`, `runClaudeAgentWithPost`) — don't fork the logic between them.

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
