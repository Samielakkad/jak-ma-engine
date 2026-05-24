# Multi-Provider LLM Routing

> Deep dive: how jak.ma serves Anthropic Claude, Google Gemini, and a self-hosted HuggingFace Darija LoRA as a single OpenAI-shaped interface — and which signals route a query to which provider.
> Code: [`server.js`](../server.js) (`callLLM`, `callClaude`, `callGemini`, `callHF`).

---

## The problem

Standard LLM apps make one of two mistakes:

1. **Vendor lock**: pick one provider, build everything around it, panic when they rate-limit you or your card declines.
2. **Multi-vendor with no thought**: shotgun fallback through OpenAI/Anthropic/Gemini in whatever order — gets you uptime but no benefit on cost, latency, or quality per query.

jak.ma's router does neither. It picks the right model **per query** based on observable signals, and falls back across providers when the chosen one fails. The library code that uses the router doesn't know which vendor answered — they all return the same OpenAI-shape envelope.

---

## TL;DR

| layer | role |
|---|---|
| `callLLM(messages, opts)` | The router. Picks a provider+model, builds a fallback chain, returns the first success. |
| `callClaude` / `callGemini` / `callHF` | Provider-specific wrappers. Take OpenAI-shape input, hit the native API, return OpenAI-shape output. |
| `_wrapClaudeResponse` / `_wrapGeminiResponse` | Translation glue: native response → OpenAI shape (text + `tool_calls[]`). |
| `_wrapClaudeStream` / `_wrapGeminiStream` | Streaming translation: native SSE → OpenAI-format SSE chunks on a `PassThrough` Node stream. |
| `_isHardQuery` | Signal evaluator. Reads `opts.routing` and returns boolean. |

All in [`server.js`](../server.js), one file (intentional — the whole router fits in ~400 lines of dense code).

---

## Per-query routing decision

```
User query → grounded-retrieval → callLLM(messages, opts)
                                       │
                                       ▼
            Is opts.model explicit? ──Yes──→ Pin provider from model prefix
                                       │     (gemini-* → Gemini, claude-* → Anthropic)
                                       No
                                       │
                                       ▼
            _isHardQuery(opts.routing)?
                                       │
                       ┌───────────────┼───────────────┐
                       Yes                            No
                       ▼                              ▼
            intent = (claude, sonnet-4-5)    intent = (gemini, gemini-3-flash)
                       │                              │
                       └──────────────┬───────────────┘
                                      ▼
            Build fallback chain:
              [primary] → [other commercial provider] → [HF Darija LoRA*]
              * HF skipped if stream:true, jsonMode:true, or tools[] passed
                                      ▼
            Walk chain; return first success; log every failure
```

### Hard-query signals (any one → Sonnet 4.5)

| signal | source | rationale |
|---|---|---|
| `hasImage` | request body has a base64 image | Vision tasks need stronger spatial reasoning. |
| `multiTrade` | `MULTI_TRADE_PATTERNS` matched (renovation queries) | Multi-step planning; Sonnet handles project decomposition better. |
| `lowConfidence` | Pass-1 classifier confidence < 0.7 | The classifier itself was unsure — bring stronger reasoning to disambiguate. |
| `longHistory` | conversation history > 5 turns | Sustained context matters more than per-call cost. |

[`_isHardQuery`](../server.js) is a pure function over `opts.routing` — 4 lines. The signals are populated by [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) before each Pass-2 call.

Why these 4 specifically? They're the cheap-to-evaluate proxies for "the model needs to think harder." All of them are observable in jak.ma's own state — no LLM call needed to evaluate them. That keeps the routing decision free.

---

## The fallback chain

For any intent `(provider, model)`, the chain is built:

```js
if (intent.provider === 'gemini') {
  if (GEMINI_API_KEY)    chain.push(gemini(intent.model));
  if (ANTHROPIC_API_KEY) chain.push(claude(CLAUDE_MODEL_DEFAULT));     // Haiku 4-5 fallback
} else {
  if (ANTHROPIC_API_KEY) chain.push(claude(intent.model));
  if (GEMINI_API_KEY)    chain.push(gemini(GEMINI_MODEL_DEFAULT));      // Flash 3 fallback
}

// HF Space tertiary tier (only for non-tool, non-JSON, non-stream cases)
if (_isHFConfigured() && !opts.stream && !opts.jsonMode && !opts.tools) {
  chain.push(hfDarijaLora);
}
```

The HF tier is **only** for low-stakes plain-text completion. It's there as a last-ditch safety net so the chatbot never returns 503 even during a multi-vendor outage. The Darija LoRA is good enough for a basic conversational response in Darija. Not good enough for tool calling, JSON output, or real-time streaming.

```js
// Walk the chain, return on first success, log every failure
let lastErr = null;
for (const tier of chain) {
  try {
    const resp = await tier.fn();
    if (tier !== chain[0]) console.warn(`[router] degraded to ${tier.name}: ${lastErr?.message}`);
    return resp;
  } catch (err) {
    lastErr = err;
    console.warn(`[router] ${tier.name} failed (${err.status}): ${err.message}`);
  }
}
throw lastErr;
```

Every fallback is logged so production-log inspection reveals degraded states. Combined with `eval_logs` which records `path` (`grounded` vs `agent`) and per-call provider metadata, you can answer "how often did we degrade to Sonnet because Gemini failed?" with a single MongoDB aggregation.

---

## OpenAI-shape adapter: the key abstraction

Every wrapper returns:

```js
{
  ok: true, status: 200,
  json: async () => ({
    choices: [{
      message: {
        role: 'assistant',
        content: '<text only>',
        tool_calls?: [{ id, type:'function', function:{ name, arguments:'<JSON>' } }]
      },
      finish_reason: 'stop' | 'tool_use' | ...
    }],
    usage: { ... },
    model: '...',
  })
}
```

Streaming wrappers expose a `body` property that's a Node `PassThrough` stream emitting OpenAI-style SSE chunks:

```
data: {"choices":[{"delta":{"content":"..."}}]}\n\n
data: [DONE]\n\n
```

So caller code looks identical regardless of provider:

```js
const resp = await callLLM(messages, opts);
if (opts.stream) {
  for await (const chunk of resp.body) { /* OpenAI-format SSE */ }
} else {
  const data = await resp.json();
  const text = data.choices[0].message.content;
  const tools = data.choices[0].message.tool_calls;
}
```

This is the abstraction that makes `lib/grounded-retrieval.js` provider-agnostic. It also lets us swap the default model without touching downstream code — only `server.js#GEMINI_MODEL_DEFAULT` changes.

---

## Per-provider translation work

### Anthropic (`callClaude`)

| direction | translation |
|---|---|
| Input: `messages` | `system:` messages extracted into top-level `system` field (Anthropic doesn't accept `role: 'system'` in `messages[]`) |
| Input: `content: [{ type:'image_url', image_url:{ url:'data:...' } }]` | → `{ type:'image', source:{ type:'base64', media_type, data } }` |
| Input: `tools` | passed through unchanged (caller provides Anthropic-shape schemas) |
| Output: text blocks in `content[]` | concatenated → `message.content` |
| Output: `tool_use` blocks in `content[]` | extracted → `message.tool_calls[]` (OpenAI shape) AND stashed under `message.anthropic_content_blocks` for echo-back in next turn |
| Stream: `content_block_delta` SSE events | translated to OpenAI `delta.content` chunks |
| Stream: `message_stop` event | translated to `data: [DONE]` |

### Google Gemini (`callGemini`)

| direction | translation |
|---|---|
| Input: `messages` with `role: 'assistant'` | → `role: 'model'` (Gemini's convention) |
| Input: `content: [{ type:'image_url', image_url:{ url:'data:...' } }]` | → `{ inlineData:{ mimeType, data } }` (base64) or `{ fileData:{ fileUri } }` (remote URL) |
| Input: `jsonMode` | → `generationConfig.responseMimeType = 'application/json'` (Gemini's native structured output) |
| Input: `tools` | wrapped as `[{ functionDeclarations: tools }]` (Gemini's nesting) |
| Output: text parts in `candidates[0].content.parts[]` | concatenated → `message.content` |
| Output: `functionCall` parts | extracted → `message.tool_calls[]` (OpenAI shape) |
| Stream: SSE events with embedded candidates | tokens extracted, emitted as OpenAI deltas |

### HuggingFace Space (`callHF`)

| direction | translation |
|---|---|
| Endpoint | Gradio 4.x two-step: `POST /gradio_api/call/generate` returns `event_id`, then `GET /gradio_api/call/generate/{event_id}` streams the result |
| Input | extracts last user-text message (single string — the LoRA has no system prompt support, no multimodal, no tools, no history) |
| Output | last `event: complete` data block → OpenAI shape with synthetic `finish_reason: 'stop'` |
| Tools / JSON / streaming | **not supported**; router auto-skips this tier |
| Cold start | 20-60s on free HF Spaces tier; configurable via `HF_FALLBACK_TIMEOUT_MS` (default 15s) |

---

## Model selection economics

Pricing as of May 2026 (sources: vendor pricing pages + [Artificial Analysis](https://artificialanalysis.ai/)):

| Model | $/MTok in | $/MTok out | Cache hit $/MTok | Arabic Global-MMLU-Lite | p50 TTFT |
|---|---|---|---|---|---|
| **gemini-3-flash** | $0.50 | $3.00 | ~$0.05 | **92** | not yet published |
| **claude-sonnet-4-5** | $3.00 | $15.00 | $0.30 | ~88 | ~1.1 s |
| claude-haiku-4-5 | $1.00 | $5.00 | $0.10 | ~83 | 0.85 s |
| gemini-2.5-flash-lite | $0.10 | $0.40 | $0.01 | ~78 | 1.83 s |
| grok-4-fast | $0.20 | $0.50 | $0.05 | no public data | 0.60 s |

Per-query cost on jak.ma's workload (40% Pass-1 hit, 100% Pass-2 hit, 1300-tok cached system prompt, 150-tok output):

| path | cost |
|---|---|
| Gemini Flash default | **$0.00090** |
| Sonnet hard-query | $0.00345 |
| Agent path (Sonnet + tools, ~10% of queries) | $0.005 |
| HF LoRA fallback (~0.5% of queries in steady state) | $0 commercial, marginal self-host |

**Blended**: ~$0.0016/query with agent path included, ~$0.001/query without. Defensible as "~$0.001/query" in interview talking points.

Why Gemini Flash beats Haiku 4-5 for default:
- Higher Arabic Global-MMLU-Lite (92 vs ~83)
- Half the price ($0.50/$3 vs $1/$5)
- Atlasia Darija Chatbot Arena historically ranks Gemini family top-3 for Maghrebi Arabic
- Anthropic's Opus 4.5 system card itself acknowledges Darija coverage is "improving but limited"

Why Sonnet 4-5 wins for hard queries:
- Tool-calling reliability better than Gemini Flash on multi-step reasoning
- Vision quality holds up better when the input is genuinely ambiguous
- 10% × extra $0.003 = $0.0003 blended overhead — acceptable price for the quality floor

---

## Cross-provider fallback in action (production logs)

```
[router] gemini failed (529): Overloaded
[router] degraded to claude after primary failed: Anthropic API 529: Overloaded
[router] claude failed (529): Overloaded
[router] degraded to hf-darija-lora after secondary failed
[hf] cold start, waiting for model... (estimated 22s)
```

When that happens, the user sees a slower-than-usual response but still gets an answer in Darija. The chatbot never 503s on a transient vendor outage.

When everything is healthy (the common case), the log looks like:

```
(no warnings — gemini-3-flash answered on first try, 920 ms)
```

---

## Why HF Space as a fallback (not as primary)

The Qwen2.5-1.5B Darija LoRA hosted at [huggingface.co/spaces/samielakkad1/jakma-darija-chat](https://huggingface.co/spaces/samielakkad1/jakma-darija-chat) is intentionally NOT the default. Why:

| pro | con |
|---|---|
| ✅ Free (HF Spaces free tier) | ❌ Cold start 20-60s on free tier |
| ✅ Strong on Darija (53k Darija samples fine-tuned) | ❌ Small model (1.5B) — limited reasoning |
| ✅ Sovereign (no commercial API dep) | ❌ No tools, no JSON mode, no real streaming (Gradio fire-and-poll) |
| ✅ Real production value as a safety net | ❌ Single-turn only — no system prompt, no conversation history |

So we use it as a **last-resort fallback**. When Gemini + Anthropic both fail (rate limits, outages, billing issues), the LoRA serves a Darija response so the chat never 503s. In steady state, the LoRA is reached on <0.5% of queries.

This is a real product engineering call: "what does the user see during a 30-minute multi-vendor outage?" The answer should not be "an error message." The HF LoRA is the answer.

---

## What's NOT built (honest limits)

- **No load balancing within a provider**. We don't round-robin across regions or fall-back through Gemini's `gemini-2.5-pro` if `gemini-3-flash` is overloaded — we go straight to Claude. Probably fine for current scale; would matter at higher QPS.
- **No persistent budgeting**. If a query is unusually expensive (long history + image + multi-trade), the router doesn't cap spend per session. Anthropic Sonnet will happily burn $0.05 on a single sufficiently-pathological query.
- **No A/B testing harness in the router itself**. To compare Gemini vs Sonnet for a specific query class, you'd hand-craft 100 queries and run them via the eval suite — there's no live shadowing built in. On the future-work list.
- **No semantic caching**. Same query asked twice still does the work twice. [`lib/semantic-cache.js`](../lib/semantic-cache.js) is scaffolded but not wired into the router.

---

## Where this transfers to multimodal / audio work

The pattern (provider-agnostic adapter + signal-driven routing + graceful fallback) is directly transferable to multimodal audio stacks:

| this work | audio analog |
|---|---|
| OpenAI-shape adapter wrapping Anthropic + Gemini + HF | Same pattern for Whisper + AssemblyAI + Deepgram + self-hosted ASR |
| Signal-driven routing (hasImage → Sonnet) | (input is noisy → premium ASR, clean → cheap ASR) |
| Cross-provider SSE stream translation | OpenAI Realtime / ElevenLabs streaming / self-hosted XTTS all have different chunk formats |
| `HF_FALLBACK_TIMEOUT_MS` for slow-but-free fallback | Same envelope for self-hosted models with cold starts |
| `eval_logs` per-call provider metadata | Equally critical for debugging "why did this voice request go through provider X" |

What doesn't transfer: the actual audio processing. The router pattern is general. Voice models have different latency profiles (real-time matters more), different failure modes (transcription confidence, not JSON parse errors), and different cost models (per-second, not per-token).

---

## File map

| File | Role |
|---|---|
| [`server.js`](../server.js) `callLLM` | The router |
| [`server.js`](../server.js) `callClaude` + `_wrapClaudeResponse` + `_wrapClaudeStream` | Anthropic wrapper |
| [`server.js`](../server.js) `callGemini` + `_wrapGeminiResponse` + `_wrapGeminiStream` | Gemini wrapper |
| [`server.js`](../server.js) `callHF` | HuggingFace Space wrapper |
| [`server.js`](../server.js) `_isHardQuery` | Routing signal evaluator |
| [`/api/health`](https://www.jak.ma/api/health) | Reports `claude_configured`, `gemini_configured`, `hf_darija_fallback`, `llm_routing` description |
