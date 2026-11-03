# Router benchmark

Sends a labelled set of WhatsApp messages through the bot's real router and scores the route and
the lights fast path. Use it to compare TypeSafe Jev with any model behind an OpenAI-compatible
server, such as the models on the mini PC gateway.

Both backends run `createJevRouter` from `whatsapp/orchestration/jevRouter.ts` with the questions
from `lightsJevQuestions`, so they see the same request the bot sends and the same 0.5 route cutoff.
Only the `fetch` differs:

- `--backend jev` uses the real fetch: one SystemOne request answers all five questions.
- `--backend chat` replaces it with an adapter that asks each Choice question as one chat completion.
  The instructions and options go in the system message, which is a fixed prefix that
  llama-server can cache. The message goes in the user turn. Questions go one at a time, because
  the mini PC's 2 slots are shared with live traffic.

With `--options keys` (the default), the model writes the option key, and the answer's probability
is the product of the reply's token probabilities. With `--options letters`, options are lettered,
and the first token's `top_logprobs` give every option a probability. On the 20-option light-target
question, Qwen3-30B often answered the letter next to the right one: "desk lamp" became the
Bathroom light at 0.99. Over 18 target messages it got 14 right with letters, 13 with the options
shuffled (the misses moved with position), and 16 with keys.

Lights are scored by running the real `runLightsFromJev` against `lights.snapshot.json` with a
fake Hue that records its calls. The recorded calls are compared with those from ideal answers built
from the row's expected sub-answers.

## Run

```bash
node bench/router/run.ts --backend jev --reps 3
node bench/router/run.ts --backend chat --fanout route-first --reps 3   # mini PC gateway, qwen3-30b-a3b
node bench/router/run.ts --backend chat --fanout all --reps 1           # all five questions every time
node bench/router/run.ts --backend chat --phases uncached --sample 24   # prompt caching off
node bench/router/run.ts --backend chat --options letters --label qwen3-letters
node bench/router/summarize.ts bench/router/results/*.jsonl
```

Each run writes one JSONL file to `results/` (gitignored). The first line is the run's settings.
After that comes one line per router call with the answers, the score, the wall time, and each HTTP
request's time and llama-server `timings`. The summary prints when the run ends. `summarize.ts`
reprints it and adds a side-by-side table when given several files.

## Comparing models

Point `--url` and `--model` at the model, and give the run a `--label`:

```bash
node bench/router/run.ts --backend chat --model qwen3-4b --fanout route-first --reps 3 --label qwen3-4b
node bench/router/run.ts --backend chat --url http://minipc.local:4000/v1 --model qwen3-1.7b --label qwen3-1.7b \
  --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'
node bench/router/summarize.ts bench/router/results/*jev-latest*.jsonl bench/router/results/*qwen3-4b*.jsonl
```

`--extra-body` is merged into every chat request. The default turns Qwen3's thinking off. Change it
for a model whose template takes other settings. Run Jev once and keep its results file as the
baseline. Rerun it only when the dataset or the bot's questions change.

`--fanout route-first` is the cheaper design for a local model: it asks the lights questions only
after a `lights` route, so most messages cost one request. `--fanout all` asks all five every time,
as the single Jev request does.

## Phases

- `warm` (the default): every message `--reps` times in a row. The first rep of the chat backend
  includes the first read of each prefix.
- `uncached` (chat only): sends `cache_prompt: false`, so every call reads its whole prompt. This
  is the worst case of an evicted prefix. Filling the slots with unrelated prompts didn't force a
  re-read on the mini PC (`cache_n` stayed at the full prefix), so the bench doesn't try that.

## Keys

- Jev reads `TYPESAFE_API_KEY` from `~/Projects/WhatsappBot/.env`.
- The chat backend reads `ROUTER_BENCH_GATEWAY_KEY` from `bench/router/.env` (gitignored). That key
  is the gateway's `bench` caller, so the gateway logs and Grafana show this traffic as `bench`.
  The gateway keeps full prompts and responses for 30 days.

Use `--env-file` and `--key-var` to override either one. Jev calls may be billed. A full Jev run of
3 reps is 354 calls.

## Dataset

`dataset.jsonl` has one message per line: `{ id, text, route, kind, lights? }`. The `kind` is
`core` or `near-miss`. `lights` holds the expected `action` and, where they apply, `target`,
`brightness` and `colour`, using the option keys `lightsJevQuestions` offers. Targets name lights
from `lights.snapshot.json`, and a one-light room and its light count as the same target.
`loadDataset` rejects a row that reuses a `ROUTE_CRITERIA` example, because those are in the prompt.

If the Hue setup changes, refresh the snapshot and check every `light:<id>` and `room:<name>`
target in the dataset. `test/routerBench.test.ts` fails when a target no longer resolves.

## Lights outcomes

| outcome | meaning |
| --- | --- |
| `fast-correct` | The fast path drove Hue exactly as the ideal answers would. |
| `fast-wrong` | It drove Hue differently, or on a message that shouldn't touch the lights. This is the outcome that matters most. |
| `missed` | The ideal answers take the fast path, but these handed over to GPT. Safe, but slower. |
| `handoff-correct` | Both hand over to GPT. |
| `not-routed` | The route wasn't `lights`, so the fast path didn't run. |
