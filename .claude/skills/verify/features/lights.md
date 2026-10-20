# Lights

The owner asks about or controls the Philips Hue lights in plain language: which are on, switch a room or a light on or off, dim, change colour.

## Sub-features

- `lights-list` lists every light with its room and state.
- `lights-switch` turns a named light, a room or all lights on or off.
- `lights-brightness` sets a brightness percentage.

## How to get to it (user POV)

- Send a message about lights, such as `lights status` or `turn off the garden light`.

## Driving it with drive.ts

Preconditions:

- Doctor reports the Hue bridge reachable.

- **List.** Run `drive "lights status"`. The reply is one line per light, such as `• Desk (Office): ON`. The log has `"Jev route"` with `"agent":"lights"`.
- **Switch.** Pick a light that is OFF in the list and that nobody will notice, such as `Garden` in daytime. Run `drive "turn on the garden light"`. The reply is `Turned on Garden.` or similar.
- **Switch, proof.** Run `drive "lights status"`. That light now shows `ON`.
- **Undo.** Run `drive "turn off the garden light"`, then list again. It shows `OFF`.

## Gotchas

- These are real lights in the owner's home. Only switch one when the change needs it, and restore its state immediately.
- A list reply that suggests checking the Hue app is the assistant fallback: the lights agent didn't handle it. Usually the light cache is empty because the bridge was unreachable when `drive.ts` started.
- With `LIGHTS_JEV_DISABLE=1` Jev routing for lights is off and the LLM lights agent handles it instead. Replies differ in wording.
