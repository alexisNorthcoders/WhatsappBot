# Book recommendations

The owner asks for something to read and gets up to three picks from r/Fantasy discussion, read from reddit-bot's SQLite database (`BOOK_DB_PATH`, read-only).

## Sub-features

- `books-like` answers "something like X" with titles discussed alongside X, leaving out X's author.
- `books-open` answers "what should I read next" with the best-liked titles.
- `books-genre` answers "recommend a cozy fantasy" from that genre's titles.
- `books-not-a-request` lets a question about a book ("who wrote X") fall through to chat.

## How to get to it (user POV)

- Send `something like Mistborn but darker`, `what should I read next`, `recommend a cozy fantasy`.

## Driving it with drive.ts

Preconditions:

- `BOOK_DB_PATH` points at reddit-bot's `reddit_bot.sqlite3`. Without it the book agent skips and every message reaches chat.
- The DB has reddit-bot's recommendation read model (`rec_titles`, `rec_mentions`, `rec_names`, `rec_similar` views), which reddit-bot's `initSchema` creates. The catalog reads only those views. On an older DB the log shows `book recommendations off: cannot open BOOK_DB_PATH` with `no such table: rec_titles` (or `rec_similar`), and every message reaches chat.
- `rec_similar` is empty until reddit-bot's `npm run similarity` has run on that DB. Until then `books-like` falls back to the best-liked titles, so turn 1 still answers but without "like X" picks. On a copy, run `SQLITE_PATH=<copy> npm run similarity` in reddit-bot first.

- **All four.** Run `drive "something like Mistborn but darker" "what should I read next" "recommend a cozy fantasy" "who wrote the name of the wind"`. Turns 1 to 3 each reply with a numbered list of up to three titles, each with a reason, `N mentions on r/Fantasy, P% positive` and a reddit link. Turn 1 has no Brandon Sanderson title. Turn 4 is a plain chat answer.
- **Route.** In the log, turns 1 to 3 show `"Jev route"` with `"agent":"books"` and a `"book recommendation"` line with the shortlist size and picks. Turn 4 routes to `chat`.

## Gotchas

- Read-only: nothing to undo.
- Each turn makes two DeepInfra-client calls on `DEEPINFRA_CHAT_MODEL` (the mini PC), about 8 s together. The first turn in a process also spends about 1 s building mention counts.
- `Not enough data: …` means fewer than three titles survived the filters, which is a correct answer for a narrow request, not a failure.
