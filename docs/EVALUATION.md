# Evaluation Methodology

> Deep dive: the eval_logs telemetry pipeline, the 57-test regression suite, the live debug endpoint, and the design philosophy borrowed from Baidu ERNIE + DOPEDCLUB evaluation work.
> Code: [`lib/grounded-retrieval.js#persistEvalLog`](../lib/grounded-retrieval.js), [`tests/`](../tests/), [`server.js`](../server.js) `/api/ai/classify`, `/api/ai/public-stats`, `/api/ai/eval-stats`.

---

## Why evaluation is a first-class subsystem

LLM-powered features are easy to ship and hard to debug. The failure modes are subtle:

- Wrong worker recommended (silent, hard to catch without ground-truth labels)
- Worker IDs hallucinated outside the candidate set (catchable via post-validation)
- Trade misclassified at Pass 1 (catchable if you store the classification)
- Latency degraded because Gemini is overloaded and we fell back to Sonnet (catchable if you store provider metadata)
- Tool call timeout (catchable if you store per-tool latency)
- Refusal rate creeping up because a prompt change made the model more conservative (catchable if you store the refusal flag)

None of these are catchable without **per-call structured telemetry**. So every `/api/ai/chat` request — both grounded and agent paths — writes a record to MongoDB's `eval_logs` collection.

---

## `eval_logs` schema (full)

Written async (fire-and-forget) at the end of every chat request. TTL: 90 days.

```js
{
  // Request identity
  request_id:        '<16-hex>',                  // surfaced in X-Request-Id response header
  ts:                <Date>,
  query:             '<user text>',
  context:           { city, category },          // pre-classification hints from frontend
  hasImage:          boolean,
  historyTurns:      number,

  // Routing path
  path:              'grounded' | 'agent',        // which pipeline served this query
  classification:    {
    trade, city, urgency, budget,
    confidence,                                   // 0.0-1.0
    source,                                       // 'regex' | 'llm' | 'fallback'
  },

  // Retrieval
  candidatesCount:   number,                      // how many workers MongoDB returned
  citedIds:          ['<hex24>', ...],            // worker IDs the model actually cited
  cache_hit:         boolean,                     // semantic_cache hit? (currently always false)

  // Pass-2 output
  rawOutputLen:      number,                      // characters
  verifier:          {
    ok:              boolean,
    score:           number,                      // 0.0-1.0 (1 - violations/8)
    violations:      ['cited_id_not_in_candidates:...', 'implausible_price:...', ...],
    source:          'grounded' | 'agent_path',
  },

  // Agent-only fields (null when path === 'grounded')
  agent_iterations:  number | null,               // 1 | 2
  tools_called:      [
    { name, input_summary, ok, error?, latency_ms }
  ] | null,
  allowedWorkerIds:  ['<hex24>', ...] | null,
  agent_error:       string | null,

  // Timings (ms)
  timings: {
    image?:          number,                      // vision classify, if present
    pass1?:          number,                      // LLM classifier
    retrieval?:      number,                      // MongoDB query
    generation?:     number,                      // Pass-2 stream duration
    verification?:   number,                      // post-output validator
    agent_total?:    number,                      // agent-path only
    total:           number,                      // end-to-end
  },

  // Error (only present on exception)
  error?:            string,
}
```

That schema is enforced by [`persistEvalLog`](../lib/grounded-retrieval.js). It writes asynchronously and silently — log persistence failures never block the response (the user already got their answer). Errors during write are logged to console but don't crash the request.

---

## What you can answer from eval_logs

Single MongoDB aggregation, per question:

| Question | Aggregation |
|---|---|
| What's p50 / p99 end-to-end latency? | `$group { _id: null, p50: { $percentile: ['$timings.total', 0.5] }, p99: { $percentile: ['$timings.total', 0.99] } }` |
| What's the regex hit rate? | `count(classification.source === 'regex') / count(*)` |
| What's the agent-path adoption rate? | `count(path === 'agent') / count(*)` |
| Which tool fails most often? | `unwind tools_called, group by name, count(!ok)` |
| Average tool latency by name? | `unwind tools_called, group by name, avg(latency_ms)` |
| Refusal rate? | `count(rawOutputLen < 50 AND classification.trade === null) / count(*)` |
| How often does the verifier flag hallucinated worker IDs? | `count(violations contains 'cited_id_not_in_candidates') / count(*)` |
| Cross-provider degradation frequency? | grep Vercel logs for `[router] degraded to ...` and correlate with eval_logs by request_id |

Every CV number is reproducible from a single query. That's the design goal.

---

## The 57-test regression suite

[`tests/text-classifier.test.js`](../tests/text-classifier.test.js) (36 tests) + [`tests/agent-loop.test.js`](../tests/agent-loop.test.js) (21 tests) = 57 unit tests covering:

### Classifier (36)

| group | tests |
|---|---|
| 12 trades × 4-8 input forms each | bottoms-up coverage of every trade in Arabic / Darija / Arabizi / French / English |
| 15 cities × multiple variants | every supported city + key neighborhoods (Maarif, Gueliz, Agdal, etc.) |
| 6 multi-trade phrase families | bathroom / apartment / kitchen / house / roof / generic renovation, all in Darija + romanized |
| Mixed-script queries | `carpenter bois f gueliz` — English + French + Arabic in one query |
| Disambiguation | `meuble` alone (ambiguous) vs `meuble bois` (carpentry) vs `tnaqil meubles` (moving) |
| Off-topic rejection | `bghit tajine` (food), `salam` (greeting), `merci` (thanks) → null |
| Reachability | every entry in `VALID_CATS` maps to itself when queried |

### Agent (21)

| group | tests |
|---|---|
| Tool registry shape | Anthropic + Gemini schemas, 3 tools, valid `required` arrays |
| Tool implementations | rejects invalid hex IDs, refuses non-allow-list workers, returns last-3 phone only, computes Casa-plumber-urgent-10yr range |
| Disambiguation | unknown trade returns valid-options list |
| Intent detection | 4 families × multiple variants = price/reviews/details/anaphoric correctly fire |
| Negative intent | new search queries, greetings, empty queries → no agent path |
| Allow-list defense | empty allow-list always blocks agent path |
| Loop semantics | tool call → final answer succeeds, terminates early if first call returns text |
| Hallucinated tool name | refuses unknown tool name, loop still terminates with valid answer |
| Error wrapping | `callClaude` failure surfaces with iteration context |

Run all 57: `npm test` (or `node --test tests/`) — passes in ~2 seconds, zero dependencies beyond `mongodb` (which `lib/tools.js` requires).

---

## The `/api/ai/classify` live debug endpoint

Built for **human-in-the-loop evaluation**: when a user reports "the bot didn't understand my query," anyone can paste the exact query into the debug URL and see precisely which classification path resolved it.

```
GET /api/ai/classify?q=ANY_QUERY_HERE
POST /api/ai/classify   { "query": "..." }
```

Response shape:

```json
{
  "query": "9hraba 6ay7a f maarif",
  "elapsed_ms": 4,
  "resolution": "regex (Pass 0)",
  "trade":  { "value": "طريسيان",   "matched_keyword": "9hraba", "pattern_group": "..." },
  "city":   { "value": "الدار البيضاء", "matched_keyword": "maarif", "pattern_group": "..." },
  "multi_trade": { "cats": null, "matched_phrase": null, "pattern": null },
  "pipeline_note": "Pass 0 regex hit — no LLM call needed."
}
```

**Why this is operationally important**:

1. When a customer complains about a misclassification, an engineer can replay the query in 5 seconds and see which keyword (or which Pass-1 LLM call) produced the wrong answer.
2. Recruiters / mentors can browse the classifier without launching the chat — paste any query and see internals.
3. Keyword-coverage gap analysis: query a list of expected-to-work queries, see which ones return `would_fall_through_to_llm_pass_1` and prioritize regex additions.

Implementation: `detectFromTextDebug` and `detectMultiTradeDebug` are introspection variants of the matching functions, returning `{ value, keyword, pattern_group }` instead of just the matched value. They're in [`lib/text-classifier.js`](../lib/text-classifier.js).

---

## The 5-dimension rubric (inherited from Baidu ERNIE work)

Pre-jak.ma, while at the Baidu ERNIE 4.5 Mentor program and DOPEDCLUB, I built a 5-dimension scoring framework for LLM output quality:

| dimension | what it scores |
|---|---|
| **Factuality** | Are the facts cited in the output present in the retrieved context? |
| **Naturalness** | Does the output sound like fluent Darija (not translated MSA)? |
| **Trade fit** | Does the recommended worker actually match the user's stated need? |
| **Price fairness** | Are the prices in the output within plausible MAD ranges? |
| **Geographic accuracy** | Is the recommended worker actually in the user's city / nearby? |

In jak.ma, this maps to:

| dimension | jak.ma realization |
|---|---|
| Factuality | [`verifyGrounding`](../lib/grounded-retrieval.js): every cited worker ID must be in the retrieved candidate set. Hard fail. |
| Naturalness | Provider routing: `claude-sonnet-4-5` for hard cases; the system prompt requires Darija output and forbids MSA. |
| Trade fit | [`detectMultiTrade`](../lib/text-classifier.js) + retrieval filter on `(category, secondary_categories)` × city. The model can only see workers whose `category` matches the classified trade. |
| Price fairness | [`lib/price-fairness.js`](../lib/price-fairness.js): hard-rule baseline (city × trade × signals via [`scripts/price-engine.js`](../scripts/price-engine.js)) + LLM mid-band evaluator. |
| Geographic | Strict MongoDB filter on `city`. Layered fallback to "same city, any zone" if exact-match retrieval returns < 3 workers. |

5 of these 5 dimensions are coded; the **price-fairness LLM tier is the most-built** (price-fairness.js has 234 lines of judge code with cache invalidation). The other 4 are deterministic gates rather than LLM judges. Honest framing: **"4-dim deterministic verification + 1-dim LLM-judge verification."**

---

## The leaderboard (external models, scaffolded)

[`lib/leaderboard.js`](../lib/leaderboard.js) and [`scripts/leaderboard_score.js`](../scripts/leaderboard_score.js) define a system where **external** models can submit themselves to be benchmarked against the jak.ma test set. Architecture:

1. External submitter POSTs `{ model_name, organization, endpoint, encrypted_api_key, model_id }` to `/api/leaderboard/submit`
2. Nightly cron pulls 50 real queries from `eval_logs`, calls the submitted endpoint, captures responses
3. **Multi-judge scoring**: every response is scored by Grok-3 + GPT-4o-mini + Claude-3-5-haiku judges using the 5-dim rubric
4. Average of the 3 judges' scores per dimension, persisted to `leaderboard_results` collection
5. Public leaderboard at `/api/leaderboard/scores`

This is **scaffolded but not actively serving submissions** in production. The infrastructure is there; the public submission UI isn't. Mostly because the eval-suite needs more curated ground-truth labels before it's defensible as an external benchmark.

---

## What's NOT built (honest limits)

- **No automated regression on production data**. The 57 tests run on hand-crafted cases. A nightly job that replays the last 24 hours of `eval_logs` against the current model would catch regressions earlier — on the future-work list.
- **No A/B testing framework in the router**. To compare model A vs model B for query class C, you'd hand-construct 100 queries and route them through both manually. No shadow-traffic infrastructure.
- **No human-in-the-loop scoring UI**. When the verifier flags a violation, there's no UI for a moderator to label "model was right" / "model was wrong" — that data would feed back into a better Pass-1 LLM prompt or new regex keywords.
- **No statistical significance testing**. We say "this change improves regex hit rate from 30% to 85%" by running both versions on the same fixed test set. We don't run it on enough production traffic with a confidence interval.
- **No structured refusal annotation**. The verifier currently flags hallucinated IDs and implausible prices. It does NOT flag soft refusals like "I'm not sure I can help with that" — those would be a `dimensions: { factuality, naturalness, trade_fit, refusal_signal }` extension.

---

## Where this transfers to multimodal / audio work

Evaluation philosophy is one of the most direct skill transfers from jak.ma to audio AIGC work. Specifically:

| this work | audio analog |
|---|---|
| `eval_logs` with per-call structured telemetry | Every TTS / ASR call needs the same: input audio fingerprint, model used, transcription confidence, alignment score, latency per phase |
| 5-dim rubric (factuality / naturalness / trade-fit / price / geo) | Audio AIGC rubric: intelligibility / naturalness / prosody / accent fidelity / speaker similarity (for cloning) |
| Multi-judge leaderboard for external models | Same architecture works for benchmarking ASR/TTS submissions — replace text judges with audio-quality judges (e.g. MOS predictors like UTMOS, NISQA) |
| `/api/ai/classify` debug endpoint | An equivalent `/api/ai/transcribe-debug` that returns ASR confidence + N-best hypotheses + per-phoneme alignment is the natural extension |
| 57 regression tests | TTS regression tests would mock the audio pipeline (no actual synthesis) and assert: model selected correctly, voice clone parameters correct, output format correct |

What's transferable: the **philosophy** (every model call writes structured telemetry; debug endpoints for human-in-the-loop; rubric-based scoring; multi-judge leaderboards). What's not: this is all text-domain code. The patterns are mentor-relevant; the audio implementation would be net-new work.

---

## File map

| File | Role |
|---|---|
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) | `persistEvalLog`, `verifyGrounding` (deterministic 4-dim verifier) |
| [`lib/price-fairness.js`](../lib/price-fairness.js) | Price-fairness LLM judge (the 5th dimension) |
| [`scripts/price-engine.js`](../scripts/price-engine.js) | Deterministic price-range baseline that feeds the fairness judge |
| [`lib/leaderboard.js`](../lib/leaderboard.js) | External-model submission storage + decryption |
| [`scripts/leaderboard_score.js`](../scripts/leaderboard_score.js) | Nightly multi-judge scoring loop |
| [`tests/text-classifier.test.js`](../tests/text-classifier.test.js) | 36 classifier regression tests |
| [`tests/agent-loop.test.js`](../tests/agent-loop.test.js) | 21 agent stack tests |
| [`server.js`](../server.js) | `/api/ai/classify` (debug), `/api/ai/public-stats`, `/api/ai/eval-stats` (admin) |
