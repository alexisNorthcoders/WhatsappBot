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
- `--no-asks` turns off the shortlist's answers from similar past asks (`answeredFor`), for an
  A/B on one DB copy.
- The asks of kind `added` (cozy like Legends & Lattes, a 10-year-old who loved Percy Jackson,
  dragons unlike Fourth Wing) came after the first 30; compare overall scores on the 30 when
  comparing with older runs.

## Tuning ask retrieval

```bash
node bench/books/tuneAsks.ts --db <scratch>/copy.sqlite3 --out <scratch>/tune
```

It parses each ask (Haiku, cached), retrieves the top 5 past asks under each of 179 weight
settings, has Opus rate every retrieved past ask once (0–2: would its answers suit this reader?),
then ranks the settings by nDCG@3 offline. Ratings are cached in `<out>/labels.jsonl`, so a new
grid or a new DB only rates the asks it hasn't seen. On 2026-11-21 (379 ratings, $0.69 of Opus) the best
setting, seed 3 / tag 2 / text 1.5, scored 0.702 against 0.676 for reddit-bot's 2 / 1 / 1.5; the
two differ on 4 of 33 asks, all wins for the new weights, and most of the grid lies within 0.03.

## Results (2026-11-21): answers from similar asks

Both columns use Haiku 5.5 through `claude -p` and the same DB copy: reddit-bot's full-history
ask index (2,560 asks) with S11's 60 tagged Titles, Dossiers and 114 Membership links grafted on.
`S6` is commit `d9e3905` (no ask retrieval); `S9` is `98b5886`.

| | S6 | S9 |
|---|---|---|
| fit | 3.45 | 3.88 |
| variety | 4.15 | 4.55 |
| grounding | 3.61 | 3.79 |
| overall, 33 asks | 3.74 | 4.07 |
| overall, the first 30 | 3.69 | 4.03 |
| like / like-but | 3.89 / 3.20 | 4.22 / 3.67 |
| open / genre | 4.33 / 3.83 | 4.56 / 3.92 |
| mood / exclusion | 3.20 / 4.00 | 4.00 / 3.33 |
| multi / ambiguous | 3.33 / 4.11 | 4.33 / 4.22 |
| added (cozy, kid, unlike) | 4.22 | 4.44 |
| answers with <3 picks | 7 | 1 |
| median s per ask | 11.0 | 11.1 |

- On the first 30 asks, S9 is better on 17, equal on 9 and worse on 4: open-classic −0.33, genre-cozy −0.67 (Nettle & Bone called cozy), excl-read-list −1.67 and ambig-wot-abbrev −0.33.
- **Judge noise, measured.** Re-judging the same answers moved a run's mean by 0.03–0.08 and an
  ask by 0.09–0.20 on average.
- **Run noise.** Two S9 runs that differed only in the tag fill (fixed between them) had overall
  scores of 4.06 and 4.07, but categories of 3–6 asks moved by up to 0.5. Read per-category
  differences under about 0.5 as noise.
- **The exclusion loss is one ask.** For "I've already read … The First Law", the ask answers
  bring in Best Served Cold, which shares First Law's world but has no Membership link on the
  copy.
- **"Found family" went from 1 to 3.7.** No Title carries the tag at ≥0.6, but past
  found-family asks do.

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

The judge's noise isn't measured here; for scale, S4's similarity judge flipped 2–3 of 25 pairwise verdicts between runs. Treat differences under about 0.2 as ties. The mini PC was unreachable for the final-code
run, so the baseline is the only qwen3-30b-a3b column.
