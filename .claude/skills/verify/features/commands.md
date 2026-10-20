# Commands

The owner types a command word and gets a fixed reply or a single-purpose tool, without going through the AI agents.

## Sub-features

- `help` lists every command, agent and the fallback.
- `clear` empties the chat's assistant memory.
- `registry` runs a registered first-word command (`help`, `recipe`, `summarize`, `image`, `sdxl`, `sprite`, `wizard`, `gpt4`, `deepinfra`, `daniel`, `home`).

## How to get to it (user POV)

- Send `!help` or `help`.
- Send `!clear`.
- Send a message whose first word is a registered command, such as `recipe pancakes`.

## Driving it with drive.ts

Preconditions:

- Baseline only. `help` and `!clear` need no external service.

- **Help.** Run `drive "!help"`. The reply contains `*!help* — This message` and a `*Fallback*` section. The log has no `"Jev route"` line.
- **Clear, empty chat.** Run `drive "!clear"`. The reply is `Chat memory was already empty.`
- **Clear after a turn.** Run `drive "say hi in three words" "!clear" "!clear"`. Turn 2 replies `Chat memory cleared (2 messages removed).` and turn 3 `Chat memory was already empty.`
- **Registered command.** Run `drive "recipe pancakes"`. The log has `"Executing command: recipe"` and `"Command completed: recipe"`, and one reply is a recipe.

## Gotchas

- Chat memory lives in the process when `CHAT_MEMORY_BACKEND` is unset (the Pi's setting), so a turn and its `!clear` must be in the same `drive` call.
- `image`, `sdxl` and `sprite` reply with images. The evidence shows them as `<N bytes>`.
