# Router benchmark

Sends a labelled set of WhatsApp messages through the bot's real router and scores the route and
the lights fast path. Use it to compare TypeSafe Jev with any model behind an OpenAI-compatible
server, such as the models on the mini PC gateway.

The comparison is on outcomes: which agent handles each message, and which Hue calls the lights
fast path makes. Each backend asks the model in whatever way suits it, and its answers are mapped
back to the shape the bot reads. `createJevRouter` (with its 0.5 route cutoff) and
`runLightsFromJev` (with its 0.7 cutoff) then decide the outcome for every backend the same way.
Both prompts are built from the bot's own `ROUTE_CRITERIA` and `lightsJevQuestions`, so they follow
the bot when its options change.

- `--backend jev` sends the bot's own request: one SystemOne call answers all five questions.
- `--backend chat` talks to an OpenAI-compatible server, one request at a time, because the mini
  PC's 2 slots are shared with live traffic. It has two prompt strategies:
  - `--prompt structured` (the default) asks for the route with a llama-server grammar that allows
    only the option keys, so the reply is the bare key in 2 to 5 tokens. After a `lights` route,
    one more call asks for a JSON object under a JSON schema: action and target, plus the level or
    colour only when the action needs one. Non-lights messages cost one request, and lights
    messages cost two.
  - `--prompt per-question` asks each Jev question as its own chat completion, as the first runs
    did. `--fanout` and `--options` only apply to this strategy.

**Probabilities.** llama-server reports each token's logprob from before the grammar applies, so a
token the grammar forces can read as near-impossible. In one test, qwen3-1.7b wanted to stop at
"remind", and the forced "er" scored about −28 each. The structured strategy renormalises each
step over the top alternatives that still lead to a valid key, which gives the probability among the
options, as Jev reports it.

Lights are scored by running the real `runLightsFromJev` against `lights.snapshot.json` with a
fake Hue that records its calls. The recorded calls are compared with those from ideal answers built
from the row's expected sub-answers.

## Run

```bash
node bench/router/run.ts --backend jev --reps 3
node bench/router/run.ts --backend chat --reps 3                        # mini PC gateway, qwen3-30b-a3b, structured
node bench/router/run.ts --backend chat --phases uncached --sample 24   # prompt caching off
node bench/router/run.ts --backend chat --prompt per-question --fanout route-first --reps 3
node bench/router/summarize.ts bench/router/results/*.jsonl
```

Each run writes one JSONL file to `results/` (gitignored). The first line is the run's settings.
After that comes one line per router call with the answers, the score, the wall time, and each HTTP
request's time and llama-server `timings`. The summary prints when the run ends. `summarize.ts`
reprints it and adds a side-by-side table when given several files.

## Comparing models

Point `--url` and `--model` at the model, and give the run a `--label`:

```bash
node bench/router/run.ts --backend chat --model qwen3-4b --reps 3 --label qwen3-4b
node bench/router/run.ts --backend chat --url http://minipc.local:4000/v1 --model qwen3-1.7b --label qwen3-1.7b \
  --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'
node bench/router/summarize.ts bench/router/results/*jev-latest*.jsonl bench/router/results/*qwen3-4b*.jsonl
```

`--extra-body` is merged into every chat request. The default turns Qwen3's thinking off. Change it
for a model whose template takes other settings. Run Jev once and keep its results file as the
baseline. Rerun it only when the dataset or the bot's questions change.

For `--prompt per-question`, `--fanout route-first` asks the lights questions only after a
`lights` route, `--fanout all` asks all five every time, and `--fanout route-only` asks only the
route. `--options keys` (the default) has the model write the option key. `--options letters` letters
the options instead, but on the 20-option light-target question Qwen3-30B often answered the letter
next to the right one: "desk lamp" became the Bathroom light at 0.99.

With thinking on, raise `--max-tokens` so the reasoning fits (1024 is enough for qwen3-1.7b). The
answer is read after `</think>`. At about 25 tok/s on the mini PC, thinking made a qwen3-1.7b route
call take 7.5 s at the median, far over the bot's 3 s Jev timeout.

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

`heldout.jsonl` has the same format and is a held-out set, with ids `h001…`. Tune prompts and
options against `dataset.jsonl` only. Score the held-out set with `--dataset bench/router/heldout.jsonl`
once at the end of each idea, with a `--label` that names the idea. Don't change a held-out label
after seeing a score. `test/routerBench.test.ts` fails if a held-out message is also in the tuning
set.

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
