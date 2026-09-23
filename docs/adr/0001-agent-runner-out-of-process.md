---
status: accepted
---

# Move the Claude agent pipeline out of the bot into a separate `agent-runner` repo and process

The Claude CLI pipeline (freeform runs, `issue:<n>` runs, post-run, cron tracer) lived inside the
WhatsApp bot only because it started life as the `claude` command. That coupling means a
`pm2 restart whatsapp` kills an in-flight agent run, and an issue run on WhatsappBot leaves the
bot's own live checkout half-edited, so any restart mid-run can load broken code and crash-loop.
We move the whole pipeline into a standalone repo and PM2 app, `agent-runner`
(`alexisNorthcoders/agent-runner`). The bot becomes a thin front end: it checks
`isAllowedActor` and forwards any `claude…` message verbatim to the runner.

## Decisions

- **Integration**: bot → runner is plain localhost HTTP (`POST /command {text, replyTo}`,
  `GET /status`), bound to `127.0.0.1`, no shared secret. Runner → bot is a Redis Stream outbox
  (`agent-runner:outbox`); the bot keeps its own read cursor in Redis. The runner never knows about
  WhatsApp: `replyTo` is opaque, and cron messages go to a logical `owner`.
- **No backlog flood**: messages produced while the bot was down are not replayed. On reconnect the
  bot sends one "you missed N agent messages" line; `claude:missed` lists them on demand. Live
  messages are coalesced, never sent back to back (WhatsApp throttling).
- **Runner owns everything else**: command parsing (including `joplin:<note>`), the workspace
  allowlist, single-flight lock, pause flag, pending-run recovery, cron state, telemetry/logs and
  status CLIs. Runner state lives in Redis, so the bot and other services can query it.
- **Workspaces**: freeform runs work from `~/Projects` (general Pi control). Issue runs keep
  branching in place in the target repo, as before. We rejected a separate clone/worktree:
  a worktree can't check out `main` while the live checkout has it, and a full clone per repo
  adds dependency-install work to fix a problem the restart guard below already covers.
- **Restart safety**: the bot's `!restart` refuses while any run is active. The runner restarts only
  via `safe-restart` (refuse if busy → pause cron → `pm2 restart` → wait for `/status` → resume),
  also exposed as `claude:restart` and mandated in the runner's agent instructions. On startup the
  runner reports interrupted runs and WIP-commits leftover work. `claude:stop` kills a stuck run.
- **No queue**: a request while busy is rejected ("busy, try later"), and if the runner is down the
  bot says so. There is no hidden queue.
- **Agent-neutral naming, Claude-only implementation**: the repo and modules use neutral names
  behind one `AgentBackend` seam. User-facing commands stay `claude*`. No second backend is built.

## Consequences

- Merged WhatsappBot changes are no longer pulled into a runner-owned checkout. Deploying the bot
  is a manual `git pull && pm2 restart whatsapp`.
- A PM2 auto-restart after a crash, while an issue run is editing WhatsappBot, can still load
  half-edited code. We accept that edge case.
- Rollout is behind `AGENT_RUNNER_URL`. When it's set, the bot delegates and its in-process cron
  is off. The in-process pipeline is deleted once the runner has been stable for a while.
  Existing cron state (`cron-last-started-issue`, `cron-pr-attempts.json`, `runs.jsonl`) is not
  migrated.
- Out of scope: reminders, the Reddit digest, the `index` app, a request queue, an LLM summary
  for missed messages, and a second agent backend.
