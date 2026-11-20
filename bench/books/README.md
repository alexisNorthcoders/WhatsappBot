# Book ask benchmark

Runs 30 owner asks (`asks.json`: like X, like X but Y, open, genre, mood or trope, exclusions,
several anchors, ambiguous names) through the bot's real recommender against a copy of
reddit-bot's database. An Opus judge then scores each answer 1–5 for fit, variety and grounding.

```bash
sqlite3 /home/alexis/Projects/reddit-bot/reddit_bot.sqlite3 "VACUUM INTO '<scratch>/copy.sqlite3'"
node --env-file=.env bench/books/run.ts --db <scratch>/copy.sqlite3 --model minipc --label mine --out <scratch>/bench
node --env-file=.env bench/books/run.ts --db <scratch>/copy.sqlite3 --model claude-haiku-5-5 --label haiku --out <scratch>/bench
node bench/books/judge.ts <scratch>/bench/mine.jsonl <scratch>/bench/haiku.jsonl
```

- `--model minipc` uses `DEEPINFRA_*` from `.env`, exactly as the bot does. `BENCH_NO_JSON=1` turns off
  `response_format: json_object` to reproduce the pre-fix picker.
- Any other `--model` goes through a tool-less `claude -p` (`claudeCli.ts`). The judge uses the same
  path with `claude-opus-5-5`. Both run on the dev machine only: the bot never spawns `claude`.
- `--out` must be outside the repo. Run files hold Reddit excerpts and Dossiers, and this repo is
  public. The judge writes `<run>.judged.jsonl` next to each run and only judges lines that are
  still missing, so a rerun resumes.
- Asks run one at a time, because the mini PC gateway has two slots shared with live traffic.

## Results (2026-11-20)

`sim` is S4's copy: no tags, Dossiers or Membership. `int` is S11's integrated copy, with 60
tagged Titles and 114 Membership links.

| | baseline, mini PC, sim | Haiku, sim | Haiku, int | Haiku, int, after tag fix |
|---|---|---|---|---|
| fit | 3.37 | 3.40 | 3.63 | 3.80 |
| variety | 4.07 | 3.87 | 4.17 | 4.00 |
| grounding | 2.43 | 3.07 | 3.57 | 3.70 |
| overall | 3.29 | 3.44 | 3.79 | 3.83 |
| answers with <3 picks | 2 | 6 | 6 | 5 |
| median s per ask | 14.4 | 11.1 | 9.4 | 9.4 |

The judge's noise is about ±0.15 on the overall mean. The mini PC was unreachable for the final-code
run, so the baseline is the only qwen3-30b-a3b column.
