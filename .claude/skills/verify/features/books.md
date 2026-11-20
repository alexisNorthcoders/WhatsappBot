# Book recommendations

The owner asks for something to read and gets up to three picks from r/Fantasy discussion, read from reddit-bot's SQLite database (`BOOK_DB_PATH`, read-only).

## Sub-features

- `books-like` answers "something like X" with titles discussed alongside X, leaving out X's author.
- `books-open` answers "what should I read next" with the best-liked titles.
- `books-genre` answers "recommend a cozy fantasy" from that genre's titles.
- `books-not-a-request` lets a question about a book ("who wrote X") fall through to chat.
- `books-profile` keeps the owner's reading profile: "I've read X", "loved X", "DNF X", "show my reading profile", "forget X from my reading profile", "clear my reading profile". Recommendations then leave out everything on it and anything recommended in the last 30 days, and open asks ("what should I read next") start from the loved titles.
- `books-tags` (needs reddit-bot's `rec_tags`/`rec_vocabulary`): a modifier ("but darker", "standalone", "less romance") becomes Title tags, and tagged candidates rank first. With `rec_dossiers` the picker reasons from the Dossier; with `rec_series_books` a Series and its own Books never both appear, and a picked Series says `Start with *Book 1*.`

## How to get to it (user POV)

- Send `something like Mistborn but darker`, `what should I read next`, `recommend a cozy fantasy`.

## Driving it with drive.ts

Preconditions:

- `BOOK_DB_PATH` points at reddit-bot's `reddit_bot.sqlite3`. Without it the book agent skips and every message reaches chat.
- The DB has reddit-bot's recommendation read model (`rec_titles`, `rec_mentions`, `rec_names`, `rec_similar` views), which reddit-bot's `initSchema` creates. The catalog reads only those views. On an older DB the log shows `book recommendations off: cannot open BOOK_DB_PATH` with `no such table: rec_titles` (or `rec_similar`), and every message reaches chat.
- The read model may also have `rec_tags`, `rec_vocabulary`, `rec_dossiers` and `rec_series_books` (reddit-bot's Title tags, Dossiers and Series Membership). Each is optional: without it, its part of `books-tags` is off and nothing errors.
- The reading profile is a JSON file at `BOOK_PROFILE_FILE` (default `logs/books/profile.json` in the checkout). **Point it at a scratch file when driving** (`BOOK_PROFILE_FILE=<scratch>/profile.json node … drive.ts …`), or the journeys edit the owner's real profile and recent-picks list.
- `rec_similar` is empty until reddit-bot's `npm run similarity` has run on that DB. Until then `books-like` falls back to the best-liked titles, so turn 1 still answers but without "like X" picks. On a copy, run `SQLITE_PATH=<copy> npm run similarity` in reddit-bot first.

- **All four.** Run `drive "something like Mistborn but darker" "what should I read next" "recommend a cozy fantasy" "who wrote the name of the wind"`. Turns 1 to 3 each reply with a numbered list of up to three titles, each with a reason, `N mentions on r/Fantasy, P% positive` and a reddit link. Turn 1 has no Brandon Sanderson title. Turn 4 is a plain chat answer.
- **Profile.** With `BOOK_PROFILE_FILE` on a scratch path, run `drive "loved Piranesi" "I've read Mistborn, The Name of the Wind" "show my reading profile" "what should I read next" "clear my reading profile"` as one call. Turns 1–2 reply `Noted: you … *Title*`; turn 3 lists `*Loved:* Piranesi` and `*Read:* …`; turn 4's log line `"book recommendation"` has `"loved":[<Piranesi id>]` and its picks are none of the shelved titles; turn 5 replies `Cleared…`. The scratch file then holds `{"shelf":[],"recent":[]}`.
- **Tags** (on a DB with `rec_tags`): `drive "something like Mistborn but darker"` logs `"tags":["tone:dark"]` (or `bleak`) in the request.
- **Route.** In the log, turns 1 to 3 show `"Jev route"` with `"agent":"books"` and a `"book recommendation"` line with the shortlist size and picks. Turn 4 routes to `chat`.

## Gotchas

- Recommending is read-only on reddit-bot's DB. The profile journeys write only `BOOK_PROFILE_FILE`; delete the scratch file afterwards.
- The router service (`ROUTER_SERVICE_URL`) may route a bare "loved X" to chat: then the profile reply never comes. The keyword gate and Jev both know the phrasing; check the `"Jev route"` line.
- Each turn makes two DeepInfra-client calls on `DEEPINFRA_CHAT_MODEL` (the mini PC), about 8 s together, both with `response_format: json_object` (without it qwen3-30b-a3b sometimes drops the closing brace and the answer is `Not enough data`). The first turn in a process also spends about 1 s building mention counts.
- `Not enough data: …` means fewer than three titles survived the filters, which is a correct answer for a narrow request, not a failure.
