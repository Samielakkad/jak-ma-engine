# Multi-Provider LLM Routing

Code: [`server.js`](../server.js) — `callLLM`, `callClaude`, `callGemini`, `callHF`.

## The problem

Most LLM apps fall into one of two patterns:

1. **Single provider**: pick one vendor, build around it, fail when they rate-limit or your card declines.
2. **Shotgun fallback**: try OpenAI / Anthropic / Gemini in some order until something responds. Solves uptime, contributes nothing on cost, latency, or per-query quality.

jak.ma's router does neither. It picks the right model per query based on observable signals, and falls back across providers when the chosen one fails. The library code using the router doesn't know which vendor answered — every wrapper returns the same OpenAI-shaped envelope.

## Components

| Layer | Role |
|---|---|
| `callLLM(messages, opts)` | The router. Picks a provider+model, builds a fallback chain, returns the first success. |
| `callClaude` / `callGemini` / `callHF` | Provider wrappers. Take OpenAI-shape input, hit the native API, return OpenAI-shape output. |
| `_wrapClaudeResponse` / `_wrapGeminiResponse` | Translation: native response → OpenAI shape (text + `tool_calls[]`). |
| `_wrapClaudeStream` / `_wrapGeminiStream` | Streaming translation: native SSE → OpenAI-format SSE chunks on a `PassThrough`. |
| `_isHardQuery` | Signal evaluator. Reads `opts.routing`, returns boolean. |

All in [`server.js`](../server.js).

## Routing decision

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
              * HF is skipped if stream:true, jsonMode:true, or tools[] passed
                                      ▼
            Walk chain; return first success; log every failure
```

### Hard-query signals

Any one signal → Claude Sonnet 4.5:

| Signal | Source | Rationale |
|---|---|---|
| `hasImage` | request body has a base64 image | Vision tasks need stronger spatial reasoning |
| `multiTrade` | `MULTI_TRADE_PATTERNS` matched (renovation queries) | Multi-step planning; Sonnet handles project decomposition better |
| `lowConfidence` | Pass-1 classifier confidence < 0.7 | Classifier was unsure — bring stronger reasoning |
| `longHistory` | conversation history > 5 turns | Sustained context matters more than per-call cost |

`_isHardQuery` is a pure function over `opts.routing` (~4 lines). The signals are populated by [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) before each Pass-2 call. They are observable from jak.ma's own state — no LLM call needed to evaluate them. The routing decision itself is free.

## Fallback chain

For any intent `(provider, model)`, the chain is built:

```js
if (intent.provider === 'gemini') {
  if (GEMINI_API_KEY)    chain.push(gemini(intent.model));
  if (ANTHROPIC_API_KEY) chain.push(claude(CLAUDE_MODEL_DEFAULT));   // Haiku 4-5
} else {
  if (ANTHROPIC_API_KEY) chain.push(claude(intent.model));
  if (GEMINI_API_KEY)    chain.push(gemini(GEMINI_MODEL_DEFAULT));   // Flash 3
}

// HF tertiary tier — only for plain-text completion
if (_isHFConfigured() && !opts.stream && !opts.jsonMode && !opts.tools) {
  chain.push(hfDarijaLora);
}
```

The HF tier is only invoked for low-stakes plain-text completion. It's a last-ditch safety net so the chatbot never returns 503 even during a multi-vendor outage. The Darija LoRA produces a coherent Darija response — not for tool calling, JSON output, or real-time streaming.

```js
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

Every fallback is logged. Combined with `eval_logs` (which records `path` and per-call provider metadata), questions like "how often did we degrade to Sonnet because Gemini failed?" become a single MongoDB aggregation.

## OpenAI-shape adapter

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

Streaming wrappers expose `body` as a Node `PassThrough` emitting OpenAI-style SSE chunks:

```
data: {"choices":[{"delta":{"content":"..."}}]}\n\n
data: [DONE]\n\n
```

Caller code is provider-agnostic:

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

This abstraction is what makes [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) provider-agnostic. Swapping the default model only requires changing `GEMINI_MODEL_DEFAULT` in `server.js`.

## Per-provider translation

### Anthropic (`callClaude`)

| Direction | Translation |
|---|---|
| Input: `messages` | `system:` messages extracted into top-level `system` field (Anthropic does not accept `role: 'system'` in `messages[]`) |
| Input: `content: [{ type:'image_url', image_url:{ url:'data:...' } }]` | → `{ type:'image', source:{ type:'base64', media_type, data } }` |
| Input: `tools` | Pass-through; caller provides Anthropic-shape schemas |
| Output: text blocks in `content[]` | Concatenated → `message.content` |
| Output: `tool_use` blocks | Extracted → `message.tool_calls[]`; raw blocks stashed under `message.anthropic_content_blocks` for next-turn echo-back |
| Stream: `content_block_delta` SSE | Translated to OpenAI `delta.content` chunks |
| Stream: `message_stop` | Translated to `data: [DONE]` |

### Google Gemini (`callGemini`)

| Direction | Translation |
|---|---|
| Input: `messages` with `role: 'assistant'` | → `role: 'model'` |
| Input: `content: [{ type:'image_url', image_url:{ url:'data:...' } }]` | → `{ inlineData:{ mimeType, data } }` or `{ fileData:{ fileUri } }` |
| Input: `jsonMode` | → `generationConfig.responseMimeType = 'application/json'` |
| Input: `tools` | Wrapped as `[{ functionDeclarations: tools }]` |
| Output: text parts | Concatenated → `message.content` |
| Output: `functionCall` parts | Extracted → `message.tool_calls[]` |
| Stream: candidate SSE | Tokens extracted, emitted as OpenAI deltas |

### HuggingFace Space (`callHF`)

| Direction | Translation |
|---|---|
| Endpoint | Gradio 4.x two-step: `POST /gradio_api/call/generate` returns `event_id`; `GET /gradio_api/call/generate/{event_id}` streams the result |
| Input | Extracts last user-text message (single string — the LoRA has no system prompt, no multimodal, no tools, no history) |
| Output | Last `event: complete` data block → OpenAI shape with synthetic `finish_reason: 'stop'` |
| Tools / JSON / streaming | Not supported; router skips this tier |
| Cold start | 20–60s on HF Spaces free tier; configurable via `HF_FALLBACK_TIMEOUT_MS` (default 15s) |

## Model selection economics

Pricing as of May 2026 (vendor pricing pages + [Artificial Analysis](https://artificialanalysis.ai/)):

| Model | $/MTok in | $/MTok out | Cache hit $/MTok | Arabic Global-MMLU-Lite | p50 TTFT |
|---|---|---|---|---|---|
| **gemini-3-flash** | $0.50 | $3.00 | ~$0.05 | 92 | not yet published |
| **claude-sonnet-4-5** | $3.00 | $15.00 | $0.30 | ~88 | ~1.1s |
| claude-haiku-4-5 | $1.00 | $5.00 | $0.10 | ~83 | 0.85s |
| gemini-2.5-flash-lite | $0.10 | $0.40 | $0.01 | ~78 | 1.83s |
| grok-4-fast | $0.20 | $0.50 | $0.05 | no public data | 0.60s |

Per-query cost on jak.ma's workload (40% Pass-1 hit, 100% Pass-2, 1300-token cached system prompt, 150-token output):

| Path | Cost |
|---|---|
| Gemini Flash default | $0.00090 |
| Sonnet hard-query | $0.00345 |
| Agent path (Sonnet + tools, ~10% of queries) | $0.005 |
| HF LoRA fallback (~0.5% of queries) | $0 commercial |

Blended: ~$0.0016/query with agent path included, ~$0.001/query without.

Why Gemini Flash beats Haiku 4-5 for the default:
- Higher Arabic Global-MMLU-Lite (92 vs ~83)
- Half the price ($0.50/$3 vs $1/$5)
- Atlasia Darija Chatbot Arena historically ranks the Gemini family top-3 for Maghrebi Arabic
- Anthropic's Opus 4.5 system card acknowledges Darija coverage is "improving but limited"

Why Sonnet 4-5 wins for hard queries:
- Tool-calling reliability better than Gemini Flash on multi-step reasoning
- Vision quality holds up better on ambiguous inputs
- 10% × extra $0.003 = $0.0003 blended overhead

## Cross-provider fallback in action

Healthy state:
```
(no warnings — gemini-3-flash answered first try, 920ms)
```

Degraded state:
```
[router] gemini failed (529): Overloaded
[router] degraded to claude after primary failed: Anthropic API 529: Overloaded
[router] claude failed (529): Overloaded
[router] degraded to hf-darija-lora after secondary failed
[hf] cold start, waiting for model... (estimated 22s)
```

The user sees a slower response but still gets an answer. The chatbot never 503s on a transient vendor outage.

## Why HF Space is a fallback, not the primary

The Qwen2.5-1.5B Darija LoRA at https://huggingface.co/spaces/samielakkad1/jakma-darija-chat is not the default. Trade-offs:

| Pro | Con |
|---|---|
| Free (HF Spaces free tier) | Cold start 20–60s on free tier |
| Strong on Darija (53k Darija samples fine-tuned) | Small model — limited reasoning |
| Sovereign (no commercial API dependency) | No tools, no JSON mode, no real streaming (Gradio fire-and-poll) |
| Real production value as a safety net | Single-turn only — no system prompt, no history |

It serves as a last-resort fallback so the chat never returns an error during a multi-vendor outage. In steady state, the LoRA is reached on less than 0.5% of queries.

## Limitations

- No load balancing within a provider. We don't round-robin across regions or fall back through `gemini-2.5-pro` if `gemini-3-flash` is overloaded — we go straight to Claude. Acceptable at current scale; would matter at higher QPS.
- No per-session budgeting. A query that's unusually expensive (long history + image + multi-trade) is not capped.
- No live A/B testing in the router. Comparing Gemini vs Sonnet for a specific query class requires manual evaluation through the test suite — no shadow-traffic infrastructure.
- No semantic caching. Same query asked twice does the work twice. [`lib/semantic-cache.js`](../lib/semantic-cache.js) is scaffolded but not wired in.

## Patterns for audio routing

The router pattern transfers directly to multimodal audio stacks:

| This work | Audio analog |
|---|---|
| OpenAI-shape adapter wrapping Anthropic + Gemini + HF | Same pattern for Whisper + AssemblyAI + Deepgram + self-hosted ASR |
| Signal-driven routing (`hasImage → Sonnet`) | Signal-driven ASR routing (`noisy input → premium ASR, clean → cheap ASR`) |
| Cross-provider SSE stream translation | OpenAI Realtime / ElevenLabs / self-hosted XTTS have different chunk formats |
| `HF_FALLBACK_TIMEOUT_MS` for slow-but-free fallback | Same envelope for self-hosted audio models with cold starts |
| `eval_logs` per-call provider metadata | Critical for debugging which voice request went through which provider |

What does not transfer: this implementation does not handle audio. Voice models have different latency profiles (real-time matters more), different failure modes (transcription confidence, not JSON parse errors), and different cost models (per-second, not per-token).

## File map

| File | Role |
|---|---|
| [`server.js`](../server.js) `callLLM` | Router |
| [`server.js`](../server.js) `callClaude` + `_wrapClaudeResponse` + `_wrapClaudeStream` | Anthropic wrapper |
| [`server.js`](../server.js) `callGemini` + `_wrapGeminiResponse` + `_wrapGeminiStream` | Gemini wrapper |
| [`server.js`](../server.js) `callHF` | HuggingFace wrapper |
| [`server.js`](../server.js) `_isHardQuery` | Routing signal evaluator |
| [`/api/health`](https://www.jak.ma/api/health) | Reports `claude_configured`, `gemini_configured`, `hf_darija_fallback`, `llm_routing` |
