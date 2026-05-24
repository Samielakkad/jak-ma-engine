# Evaluation Methodology

Code: [`lib/grounded-retrieval.js#persistEvalLog`](../lib/grounded-retrieval.js), [`tests/`](../tests/), [`server.js`](../server.js) — `/api/ai/classify`, `/api/ai/public-stats`, `/api/ai/eval-stats`.

## Why evaluation is a first-class subsystem

LLM features are easy to ship and hard to debug. Common failure modes:

- Wrong worker recommended (silent — hard to catch without ground-truth labels)
- Worker IDs hallucinated outside the candidate set
- Trade misclassified at Pass 1
- Latency degraded because the primary provider is overloaded and we fell back
- Tool call timeout
- Refusal rate creeping up after a prompt change

None of these are catchable without per-call structured telemetry. Every `/api/ai/chat` request — both grounded and agent paths — writes a record to MongoDB's `eval_logs` collection.

## `eval_logs` schema

Written async (fire-and-forget) at the end of every chat request. TTL: 90 days.

```js
{
  // Request identity
  request_id:        '<16-hex>',                  // also returned in X-Request-Id header
  ts:                <Date>,
  query:             '<user text>',
  context:           { city, category },          // pre-classification hints from frontend
  hasImage:          boolean,
  historyTurns:      number,

  // Routing path
  path:              'grounded' | 'agent',
  classification:    {
    trade, city, urgency, budget,
    confidence,                                   // 0.0–1.0
    source,                                       // 'regex' | 'llm' | 'fallback'
  },

  // Retrieval
  candidatesCount:   number,
  citedIds:          ['<hex24>', ...],
  cache_hit:         boolean,

  // Pass-2 output
  rawOutputLen:      number,
  verifier:          {
    ok:              boolean,
    score:           number,                      // 1 - violations/8
    violations:      ['cited_id_not_in_candidates:...', 'implausible_price:...', ...],
    source:          'grounded' | 'agent_path',
  },

  // Agent-only (null when path === 'grounded')
  agent_iterations:  number | null,
  tools_called:      [{ name, input_summary, ok, error?, latency_ms }] | null,
  allowedWorkerIds:  ['<hex24>', ...] | null,
  agent_error:       string | null,

  // Timings (ms)
  timings: {
    image?, pass1?, retrieval?, generation?, verification?, agent_total?,
    total,
  },

  // Set only on exception
  error?:            string,
}
```

[`persistEvalLog`](../lib/grounded-retrieval.js) enforces the schema. It writes asynchronously and silently — failures are logged but never block the response.

## Queries you can run against `eval_logs`

Each question is a single MongoDB aggregation:

| Question | Aggregation |
|---|---|
| p50 / p99 end-to-end latency | `$group { p50: { $percentile: ['$timings.total', 0.5] }, p99: { $percentile: ['$timings.total', 0.99] } }` |
| Regex hit rate | `count(classification.source === 'regex') / count(*)` |
| Agent-path adoption rate | `count(path === 'agent') / count(*)` |
| Which tool fails most often | `unwind tools_called, group by name, count(!ok)` |
| Average tool latency by name | `unwind tools_called, group by name, avg(latency_ms)` |
| Refusal rate | `count(rawOutputLen < 50 AND classification.trade === null) / count(*)` |
| Verifier hallucination rate | `count(violations contains 'cited_id_not_in_candidates') / count(*)` |
| Cross-provider degradation frequency | grep Vercel logs for `[router] degraded to ...` and correlate with eval_logs by request_id |

Every CV-quotable number is reproducible from one query.

## The 57-test regression suite

### Classifier (36 tests in [`tests/text-classifier.test.js`](../tests/text-classifier.test.js))

| Group | Coverage |
|---|---|
| 12 trades × 4–8 input forms each | Arabic / Darija / Arabizi / French / English |
| 15 cities × multiple variants | Every supported city plus neighborhoods (Maarif, Gueliz, Agdal, etc.) |
| 6 multi-trade phrase families | Bathroom / apartment / kitchen / house / roof / generic renovation |
| Mixed-script queries | `carpenter bois f gueliz` — three scripts in one query |
| Disambiguation | `meuble` alone (ambiguous) vs `meuble bois` (carpentry) vs `tnaqil meubles` (moving) |
| Off-topic rejection | `bghit tajine` (food), `salam`, `merci` → null |
| Reachability | Every `VALID_CATS` entry maps to itself |

### Agent (21 tests in [`tests/agent-loop.test.js`](../tests/agent-loop.test.js))

| Group | Coverage |
|---|---|
| Tool registry shape | Anthropic + Gemini schemas, 3 tools, valid `required` arrays |
| Tool implementations | Rejects invalid hex IDs, refuses non-allowlist workers, last-3 phone only, computes Casa-plumber-urgent-10yr range |
| Disambiguation | Unknown trade returns valid-options list |
| Intent detection | 4 families × multiple variants |
| Negative intent | New search queries, greetings, empty queries → no agent path |
| Allowlist defense | Empty allowlist always blocks |
| Loop semantics | Tool call → final answer succeeds; terminates early if first call returns text |
| Hallucinated tool name | Refused; loop still terminates with valid answer |
| Error wrapping | `callClaude` failure surfaces with iteration context |

Run: `npm test` (or `node --test tests/`). All 57 pass in under two seconds.

## `/api/ai/classify` debug endpoint

Built for human-in-the-loop evaluation: when a user reports "the bot did not understand my query," anyone can replay the exact query and see which classification path resolved it.

```
GET /api/ai/classify?q=ANY_QUERY_HERE
POST /api/ai/classify   { "query": "..." }
```

Response:

```json
{
  "query": "9hraba 6ay7a f maarif",
  "elapsed_ms": 4,
  "resolution": "regex (Pass 0)",
  "trade":  { "value": "طريسيان",       "matched_keyword": "9hraba", "pattern_group": "..." },
  "city":   { "value": "الدار البيضاء", "matched_keyword": "maarif", "pattern_group": "..." },
  "multi_trade": { "cats": null, "matched_phrase": null, "pattern": null },
  "pipeline_note": "Pass 0 regex hit — no LLM call needed."
}
```

Operational uses:
1. Customer reports misclassification → engineer replays query in 5s → sees the matching keyword
2. Reviewers can browse classifier behavior without launching the chat
3. Keyword-coverage gap analysis: query expected-to-work strings, see which return `would_fall_through_to_llm_pass_1`

Implementation: `detectFromTextDebug` and `detectMultiTradeDebug` ([`lib/text-classifier.js`](../lib/text-classifier.js)) are introspection variants returning `{ value, keyword, pattern_group }` instead of just the matched value.

## The 5-dimension rubric

A scoring framework I built earlier at the Baidu ERNIE 4.5 Mentor program and DOPEDCLUB:

| Dimension | What it scores |
|---|---|
| **Factuality** | Are the facts cited in the output present in the retrieved context? |
| **Naturalness** | Does the output sound like fluent Darija (not translated MSA)? |
| **Trade fit** | Does the recommended worker match the user's stated need? |
| **Price fairness** | Are the prices in the output within plausible MAD ranges? |
| **Geographic accuracy** | Is the recommended worker in the user's city / nearby? |

In jak.ma:

| Dimension | jak.ma realization |
|---|---|
| Factuality | [`verifyGrounding`](../lib/grounded-retrieval.js): every cited worker ID must be in the retrieved candidate set. Hard fail. |
| Naturalness | Provider routing: Sonnet 4-5 for hard cases; system prompt requires Darija output and forbids MSA. |
| Trade fit | [`detectMultiTrade`](../lib/text-classifier.js) + retrieval filter on `(category, secondary_categories) × city`. The model sees only workers whose category matches. |
| Price fairness | [`lib/price-fairness.js`](../lib/price-fairness.js): hard-rule baseline (city × trade × signals via [`scripts/price-engine.js`](../scripts/price-engine.js)) + LLM mid-band evaluator. |
| Geographic | Strict MongoDB filter on `city`. Layered fallback to "same city, any zone" if exact-match returns fewer than 3 workers. |

Four of the five dimensions are deterministic gates; price-fairness is an LLM judge with cache invalidation. Framing in interview: "4-dim deterministic verification + 1-dim LLM-judge verification."

## The leaderboard (scaffolded)

[`lib/leaderboard.js`](../lib/leaderboard.js) and [`scripts/leaderboard_score.js`](../scripts/leaderboard_score.js) define a system for external models to be benchmarked against jak.ma's test set:

1. Submitter POSTs `{ model_name, organization, endpoint, encrypted_api_key, model_id }` to `/api/leaderboard/submit`
2. Nightly cron pulls 50 real queries from `eval_logs`, calls the submitted endpoint, captures responses
3. Multi-judge scoring: every response scored by Grok-3 + GPT-4o-mini + Claude-3-5-haiku judges using the 5-dim rubric
4. Average of the three judges per dimension, persisted to `leaderboard_results`
5. Public leaderboard at `/api/leaderboard/scores`

This is scaffolded but not actively serving submissions in production — the eval suite needs more curated ground-truth labels before it's defensible as an external benchmark.

## Limitations

Not built:
- No automated regression on production data. The 57 tests run on hand-crafted cases. A nightly job that replays the last 24 hours of `eval_logs` against the current model would catch regressions earlier.
- No A/B framework in the router. Comparing model A vs B for query class C requires hand-constructed eval, not shadow traffic.
- No human-in-the-loop scoring UI. When the verifier flags a violation, there's no moderation interface to label "model was right" / "model was wrong" and feed that back into the prompt or regex.
- No statistical significance testing. Improvement claims compare both versions on the same fixed test set, not on enough production traffic for confidence intervals.
- No refusal annotation in the verifier. It flags hallucinated IDs and implausible prices; it does not flag soft refusals like "I'm not sure I can help with that."

## Patterns for audio evaluation

Evaluation methodology is the most directly transferable skill from jak.ma to audio AIGC work:

| This work | Audio analog |
|---|---|
| `eval_logs` with per-call structured telemetry | Every TTS / ASR call needs input audio fingerprint, model used, transcription confidence, alignment score, per-phase latency |
| 5-dim rubric (factuality / naturalness / trade-fit / price / geo) | Audio AIGC rubric: intelligibility / naturalness / prosody / accent fidelity / speaker similarity |
| Multi-judge leaderboard for external models | Same architecture for benchmarking ASR/TTS submissions — text judges replaced by audio-quality judges (UTMOS, NISQA, etc.) |
| `/api/ai/classify` debug endpoint with matched-keyword introspection | An equivalent `/api/ai/transcribe-debug` returning ASR confidence + N-best hypotheses + per-phoneme alignment |
| 57 regression tests | TTS regression tests would mock audio synthesis and assert model selected, voice clone parameters correct, output format correct |

What transfers: the methodology (per-call structured telemetry, public debug endpoints, rubric-based scoring, multi-judge leaderboards). What does not: this is text-domain code; audio implementation would be new work.

## File map

| File | Role |
|---|---|
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) | `persistEvalLog`, `verifyGrounding` (deterministic 4-dim verifier) |
| [`lib/price-fairness.js`](../lib/price-fairness.js) | Price-fairness LLM judge (5th dimension) |
| [`scripts/price-engine.js`](../scripts/price-engine.js) | Deterministic price-range baseline feeding the fairness judge |
| [`lib/leaderboard.js`](../lib/leaderboard.js) | External-model submission storage + decryption |
| [`scripts/leaderboard_score.js`](../scripts/leaderboard_score.js) | Nightly multi-judge scoring loop |
| [`tests/text-classifier.test.js`](../tests/text-classifier.test.js) | 36 classifier regression tests |
| [`tests/agent-loop.test.js`](../tests/agent-loop.test.js) | 21 agent stack tests |
| [`server.js`](../server.js) | `/api/ai/classify` (debug), `/api/ai/public-stats`, `/api/ai/eval-stats` (admin) |
