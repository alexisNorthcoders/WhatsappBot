# Joplin notes

The owner asks in plain language to list, read, create or edit notes, and the bot works on the `WhatsApp Bot` notebook in Joplin through the Joplin CLI.

## Sub-features

- `joplin-list` lists the notes in `WhatsApp Bot` with short ids.
- `joplin-read` shows one note's content by id or title.
- `joplin-create` creates a note and syncs it.
- `joplin-delete` deletes a note the owner names.

## How to get to it (user POV)

- Send a message that mentions Joplin or notes, such as `list my joplin notebooks`.

## Driving it with drive.ts

Preconditions:

- Doctor reports `OK    joplin CLI: <path>`.
- The `WhatsApp Bot` notebook exists (the Pi has 3 notes in it as of 2026-10-20).

- **List.** Run `drive "list my joplin notebooks"`. The reply lists the `WhatsApp Bot` notes with 5-character ids, such as `Claude orchestrator — ID 91519`. The log has `"Jev route"` with `"agent":"joplin"` or the joplin agent's lines, and no generic answer about Joplin apps.
- **Read.** Run `drive "show joplin note 91519"` with an id from the list. The reply contains that note's body.
- **Create.** Run `drive "create a joplin note titled verify-<timestamp> saying verification run"`. The reply confirms the note.
- **Create, proof.** Run `drive "list my joplin notebooks"` again. The new title appears.
- **Undo.** Run `drive "delete joplin note <new id>"`, then list again. The title is gone.

## Gotchas

- On the Pi the CLI is installed under Node 22 only. The bot finds it through `JOPLIN_BIN` in `.env` (issue #142). If doctor warns that the CLI is missing, every journey fails with `joplin: not found` in the log.
- A read triggers `joplin sync` at most every 30 seconds. The first drive is slower.
- The agent only touches `WhatsApp Bot`. Notes in other notebooks are out of scope by design, not a failure.
