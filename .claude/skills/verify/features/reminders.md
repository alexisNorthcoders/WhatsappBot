# Reminders

The owner and SECOND_PHONE create reminders, list what's coming up and cancel items, all stored as events on the owner's Google Calendar.

## Sub-features

- `reminders-agenda` answers "what's on tomorrow / this week" with a numbered list.
- `reminders-list` answers "list reminders" with a numbered list.
- `reminders-create` creates a calendar event with an alert from plain language.
- `reminders-cancel` deletes item N of the last list shown in that chat.
- `reminders-second-phone` records SECOND_PHONE as the creator.

## How to get to it (user POV)

- Send `what's on tomorrow`, `list reminders`, `remind me to <thing> <when>`, then `cancel <N>`.

## Driving it with drive.ts

Preconditions:

- `GOOGLE_CALENDAR_*` credentials are set in `.env`. Without them only reminder help works.

- **Agenda.** Run `drive "what's on tomorrow"`. The reply is a numbered list, or `Nothing on tomorrow.`
- **Create.** Run `drive "remind me to verify-<timestamp> tomorrow at 7am"`. The reply confirms the reminder with its time.
- **Create, proof, undo.** Run `drive "list reminders" "cancel <N>" "list reminders"`, where N is the `verify-<timestamp>` item's number from a `drive "list reminders"` run just before. Turn 1 must show that item at N. If it shows another event there, the cancel hit a real event: report it to the user at once. Turn 2 confirms the cancel, and turn 3 no longer shows the item.
- **Second phone.** Repeat Create with `--as second`. The reply confirms it, and the list shows it.

## Gotchas

- These are real events on the owner's calendar, and the live bot's nudge tick will Nudge the owner's real phone when the alert time arrives. Always cancel what you create, and pick a time far enough ahead.
- "cancel N" uses the list shown earlier in the same chat and process, so the list and the cancel must be in one `drive` call.
