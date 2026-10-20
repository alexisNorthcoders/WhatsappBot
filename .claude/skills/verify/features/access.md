# Access control

Only the owner (MY_PHONE, SECOND_PHONE and allowlisted LIDs) gets replies. `claude…` messages go to agent-runner, and `!restart` waits while a runner run is active.

## Sub-features

- `access-owner` replies to the owner and SECOND_PHONE.
- `access-stranger` ignores anyone else silently: no reply, no read receipt.
- `access-claude` forwards `claude…` messages to agent-runner.
- `access-restart-guard` refuses `!restart` while agent-runner is busy.

## How to get to it (user POV)

- Send any message from an allowlisted or an unlisted number.
- Send `claude:status` or `claude <prompt>`.
- Send `!restart`.

## Driving it with drive.ts

Preconditions:

- Baseline only.

- **Owner.** Run `drive "!help"`. One reply is sent.
- **Stranger.** Run `drive --as stranger "!help"`. stdout is `(no reply sent)` and the log has `"Ignoring message from non-owner sender"`.
- **Claude forward.** Run `drive "claude:status"`. The reply is `[verify] not forwarded to agent-runner` and the evidence JSON has `forwardedToAgentRunner: [{ "text": "claude:status", ... }]`.
- **Claude, stranger.** Run `drive --as stranger "claude:status"`. No reply, and `forwardedToAgentRunner` is empty.

## Gotchas

- Never drive `!restart` as owner unless agent-runner reports `busy: true`. With an idle runner it really runs `pm2 restart whatsapp`. `--as stranger "!restart"` is safe: it is dropped before routing.
- The real agent-runner is never sent a command by this harness. To prove a runner change, use agent-runner's own checks.
- `@lid` identities aren't driven here: `drive.ts` sends from phone JIDs only.
