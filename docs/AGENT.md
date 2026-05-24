# The Tool-Calling Agent

> Deep dive: single-round, allow-list-scoped, bounded agent loop for follow-up queries on jak.ma.
> Code: [`lib/agent-loop.js`](../lib/agent-loop.js), [`lib/tools.js`](../lib/tools.js), [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js#_runAgentPath).

---

## What it is

When a user gets 3 worker recommendations and follows up with `"is the first one good?"` or `"shchhal kayseweh?"` (how much would it cost), jak.ma stops doing retrieve-then-generate. There's nothing new to retrieve — the answer is already in MongoDB. It switches to a **tool-calling agent**: the LLM (Claude Sonnet 4.5) calls one or more of 3 tools, receives the data, then writes a Darija answer.

It's an agent in the strict technical sense: the LLM decides *which* tool to call and *what arguments* to pass; the runtime executes the tool against MongoDB and feeds the result back. The loop is bounded (max 2 LLM round-trips, max 3 tools per round) and the tool surface is small (3 tools, allow-listed at the name layer and at the data layer).

## What it is NOT (honest scope)

- **Not a multi-step planner.** It's a single round of `LLM → tools → LLM → final-text`. Decomposing "renovate my bathroom" into "step 1: call plumber-tool, step 2: call tiler-tool" is handled by a separate deterministic `MULTI_TRADE_PATTERNS` matcher in [`lib/text-classifier.js`](../lib/text-classifier.js), not by the LLM.
- **Not an autonomous external-tool user.** No web search, no calendar, no email. The 3 tools all read from the same MongoDB the rest of the app reads.
- **Not multi-provider mid-loop.** The loop runs entirely on Claude Sonnet 4.5. Mixing Anthropic `tool_use` and Gemini `functionCall` state across iterations is brittle; single-provider keeps the conversation shape sane.
- **Not unbounded.** Hard caps: max 2 iterations, max 3 tool calls per iteration, 1.5s timeout per tool, 5s total agent path budget.

---

## The 3 tools

| Tool | Input | Output | Data source |
|---|---|---|---|
| `lookupWorkerById` | `{ workerId: 24-hex string }` | `{ name, city, zone, description, price_min, price_max, price_unit, rating, rating_count, reviews_count, experience_years, verified, featured, available, phone_last3 }` | `db.collection('workers').findOne({_id, approved})` |
| `getRecentReviews` | `{ workerId, limit?: 1–5 }` | `{ worker_name, reviews: [{reviewer_name, stars, text}], avg_rating, total_reviews }` | embedded `reviews[]` array on the worker doc |
| `estimatePrice` | `{ trade, city, options?: { experience_years, urgency, company } }` | `{ price_min, price_max, price_unit, currency, baseline_n }` | [`scripts/price-engine.js#computePriceRange`](../scripts/price-engine.js) + MongoDB count for `baseline_n` (number of real workers in this trade × city — confidence signal) |

Each tool is defined in [`lib/tools.js`](../lib/tools.js) with three artifacts:
- `anthropicSchema` — Anthropic `/v1/messages` `tools[]` entry
- `geminiSchema` — Gemini `functionDeclarations[]` entry
- `impl(input, ctx)` — async JS function that returns `{...result}` on success or `{ error, message }` on graceful failure (never throws)

The hot path tools both use `executeTool(name, input, ctx)` which adds a 1.5s timeout envelope and turns any exception into a structured error result.

## Safety boundaries

### 1. Allow-list at the data layer

The two lookup tools (`lookupWorkerById`, `getRecentReviews`) refuse worker IDs that aren't in the current conversation's allow-list. The allow-list is built by [`_extractAllowedWorkerIds(messages, workerContext)`](../lib/grounded-retrieval.js) which reads from three sources:

1. `<<WORKERS:id1,id2>>` markers in any prior assistant message text
2. `m.workers_cited[]` sidecar array on prior assistant messages (frontend-provided, more robust than parsing text)
3. `req.body.workerContext` (set when the chat is started fresh on a worker detail page)

Hex-24 only; anything else is dropped. If the allow-list is empty, the agent path doesn't fire at all (the intent detection regex bails on empty allow-list). If the LLM hallucinates an ID, the tool returns `{ error: 'worker_not_in_context' }` and the model can apologize gracefully.

### 2. Allow-list at the tool-name layer

[`lib/agent-loop.js`](../lib/agent-loop.js) has a hard-coded `ALLOWED_NAMES` set: `{ lookupWorkerById, getRecentReviews, estimatePrice }`. If the LLM hallucinates a tool name (`exfiltrateData`, `runShellCommand`, anything), the loop refuses without calling anything and returns an `unknown_tool` error block. Tested in [`tests/agent-loop.test.js`](../tests/agent-loop.test.js).

### 3. Phone-number privacy

`lookupWorkerById` returns `phone_last3` (the last 3 digits) plus a `privacy_note` field that explicitly instructs the LLM never to claim it has the full number. The full phone is only delivered to the user via the existing UI WhatsApp button — the LLM never sees it.

### 4. Timeout caps

Per-tool: 1.5s. Per-iteration LLM call: governed by the `signal` AbortController. Total agent path budget: ~5s. If anything exceeds the budget, the agent loop throws and the grounded-retrieval handler catches it and falls back to the standard chat path with no user-visible failure.

---

## Provider integration

Both Anthropic Claude and Google Gemini support native tool calling. The wrappers in [`server.js`](../server.js) translate their formats into a unified OpenAI-shape so the loop is provider-agnostic.

| Provider | Native format | Wrapper translation |
|---|---|---|
| Anthropic | `tools[]` schema + response `content[]` includes `tool_use` blocks | `_wrapClaudeResponse` extracts `tool_use` → OpenAI `tool_calls[]`, stashes raw blocks under `anthropic_content_blocks` for echo-back |
| Gemini | `functionDeclarations[]` + response `parts[]` includes `functionCall` parts | `_wrapGeminiResponse` extracts `functionCall` → same OpenAI `tool_calls[]` shape |
| HF Darija LoRA | no tool calling | Router auto-skips this tier when `tools` is in opts |

Loop reads `data.choices[0].message.tool_calls` regardless of which provider answered. The Anthropic adapter additionally preserves the raw content blocks because the Anthropic API requires the next user turn to include `tool_result` blocks with matching `tool_use_id`s — the IDs from the original assistant turn must round-trip unchanged.

---

## The loop semantics (with code)

```js
// lib/agent-loop.js — exact semantics (lightly edited for the doc)

async function runAgentLoop({
  messages, tools, callClaude, ctx, onThinking,
  maxIterations = 2,
}) {
  const conversation = [...messages];
  const toolsCalled = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    const isLast = iter === maxIterations - 1;

    // On the final iteration, drop the tools array so the model
    // is forced to produce a user-facing text answer. Guarantees
    // the loop always terminates with text.
    const opts = isLast ? {} : { tools };

    const response = await callClaude(conversation, opts);
    const msg = (await response.json()).choices[0].message;
    const toolCalls = msg.tool_calls || [];

    // Branch 1: no tool calls → final answer
    if (toolCalls.length === 0 || isLast) {
      return { response, iterations: iter + 1, toolsCalled };
    }

    // Branch 2: tool calls present
    // Echo assistant turn back (using raw Anthropic blocks so tool_use_ids match)
    conversation.push({ role: 'assistant', content: msg.anthropic_content_blocks });

    // Execute up to 3 tools, each with 1.5s timeout
    const results = [];
    for (const tc of toolCalls.slice(0, 3)) {
      if (!ALLOWED_NAMES.has(tc.function.name)) {
        results.push({ tool_use_id: tc.id, error: 'unknown_tool' });
        continue;
      }
      onThinking(`🔍 ${tc.function.name}…`);   // SSE thinking event
      const r = await executeTool(tc.function.name, parse(tc.function.arguments), ctx);
      results.push({ tool_use_id: tc.id, ...r });
      toolsCalled.push({ name: tc.function.name, ok: r.ok, latency_ms: r.latency_ms });
      onThinking(`✅ ${tc.function.name} (${r.latency_ms}ms)`);
    }

    // Push tool results as the next user turn
    conversation.push({
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.tool_use_id,
        content: JSON.stringify(r.result || { error: r.error }),
      })),
    });
  }
}
```

Three things worth pointing at:

1. **Last-iteration tool-drop**: On the final iteration we deliberately pass no `tools` array. This forces the model to produce text (since it can't call a tool with nothing to call). Without this guard, a misbehaving model could keep calling tools forever — the cap exists as a hard stop.

2. **`anthropic_content_blocks` echo-back**: Anthropic's tool-use protocol requires the assistant's tool_use blocks to be present verbatim in the next conversation turn (the user turn that contains the matching `tool_result`s). The OpenAI-shape `tool_calls[]` array doesn't carry that fidelity — IDs are there but the surrounding structure isn't. So when we get a response with tool calls, we also stash the raw blocks on `message.anthropic_content_blocks` and push *those* back in instead of synthesizing from the shape.

3. **Defensive `_isHardQuery` skip**: The agent loop runs Sonnet 4.5 directly, not via `callLLM`. This bypasses the multi-provider fallback chain because mixing Anthropic and Gemini tool-call state mid-conversation breaks the shape. If Sonnet is unavailable, the caller catches the error and falls back to the standard grounded chat path with no agent.

---

## Routing: when does the agent path fire?

The agent path is gated by **two signals** that must both be true (in [`lib/grounded-retrieval.js#handleGroundedChat`](../lib/grounded-retrieval.js)):

### Signal 1: allow-list non-empty

`_extractAllowedWorkerIds(messages, workerContext)` returns the set of all worker IDs visible in the conversation. If empty, the agent can't do anything safely (it has no targets for `lookupWorkerById` / `getRecentReviews`) so we skip it.

### Signal 2: follow-up intent regex

`_isFollowupNeedingTools(query, allowedWorkerIds)` matches the query against 4 intent families (regex source in [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js)):

| Family | Trigger examples |
|---|---|
| Anaphoric reference | `the first`, `الأول`, `ديك`, `that one`, `\bhe\b` |
| Price intent | `shchhal`, `how much`, `combien`, `سعر`, `fair price`, `غالي` |
| Opinion / reviews | `reviews`, `is X good`, `تقييم`, `chno gultu`, `مزيان`, `is reliable` |
| Details intent | `tell me more`, `details`, `تفاصيل`, `أكثر`, `tell me about` |

If neither signal fires, the chat goes through the standard grounded path (regex → retrieve → stream). If both fire, the agent branch runs. Errors in the agent branch fall back silently to the grounded path so the user never sees a torn response.

---

## SSE streaming: zero frontend changes

When tools execute, the loop emits `thinking` SSE events the frontend already knows how to render (the existing thinking-pane handler from the regex/LLM classifier stage). Example sequence for `"tell me everything about the first one with reviews"`:

```
data: {"thinking":{"stage":"agent","text":"🔍 كنشوف تفاصيل المعلم (898a0e)…"}}
data: {"thinking":{"stage":"agent","text":"✅ تم الحصول على التفاصيل (226ms)"}}
data: {"thinking":{"stage":"agent","text":"⭐ كنقلب على التقييمات الأخيرة…"}}
data: {"thinking":{"stage":"agent","text":"✅ جبت 3 تقييم (225ms)"}}
data: {"text":"**Climatizone** — بلومبي فطنجة، زونة °36: ..."}
data: {"done":true,"workers":[],"agent":{"iterations":2,"tools_called":["lookupWorkerById","getRecentReviews"]}}
```

The thinking events are buffered server-side until the agent loop produces a valid final answer (`_runAgentPath` commits to streaming only after the final text exists). If the loop fails mid-way, nothing has been written to the client yet, and the grounded-retrieval handler takes over.

---

## Telemetry: every agent call is logged

`eval_logs` MongoDB collection (90-day TTL) gets the following fields per agent-path query:

```js
{
  request_id: '16-hex',
  path: 'agent',                              // vs 'grounded' for non-agent path
  query: '...',
  agent_iterations: 1 | 2,
  tools_called: [
    { name, input_summary, ok, error?, latency_ms }
  ],
  allowedWorkerIds: ['hex24', 'hex24', ...],
  timings: { agent_total, total },
  verifier: { ok, source: 'agent_path' },
}
```

Makes the "I built an agent" claim provable from a single MongoDB aggregation: tool-call success rate, p50 / p99 tool latency, average iterations, etc.

---

## Where this transfers to multimodal / audio work

The mentor's lab works on multimodal audio interaction LLMs (GPT-4o-like architectures). What's transferable from this agent stack:

| Pattern here | Transferable to |
|---|---|
| Bounded loop (max iter + max tools/iter) | Real-time audio agents need hard latency budgets too — same envelope pattern |
| Allow-list at data + name layers | Voice agents accessing personal data (contacts, calendar) need the same defense-in-depth |
| Provider-agnostic OpenAI-shape adapter | Multi-vendor audio models (Whisper, Moshi, NeMo, ...) benefit from a unified caller interface |
| `thinking` SSE events between tool calls | The same pattern works for streaming voice agent reasoning ("listening...", "looking up...", "speaking...") |
| Tool-call telemetry in eval_logs | Audio agent eval needs the same: which tool fired, latency, error rate per category |

What's NOT transferable (honest): nothing here is multimodal in itself. The agent is text-in / text-out. The pattern transfers; the substance doesn't. Treating this as "audio agent experience" would be dishonest.

---

## What I'd build next (if extending this for a multimodal audio agent)

1. **Streaming tool execution** — currently the agent waits for all tools to finish before emitting tokens. For an audio agent, we'd want token-by-token streaming with tool calls interleaved (more like the OpenAI Realtime API's pattern).

2. **Multi-step planning loop** — true ReAct with N iterations, not the bounded single-round here. Necessary for tasks like "schedule a plumber call for tomorrow afternoon" that need decomposition.

3. **Voice tool-call confirmation** — for an audio interface, you can't quietly run a tool that costs money or sends a message. UI / voice confirmation step before destructive tools.

4. **Memory tier** — persistent agent memory across sessions (Redis or vector DB), so a user's preferences carry over.

5. **Audio-specific tools** — `transcribe(audio_url)`, `synthesize(text)`, `detect_voice_activity(audio_stream)`. These would fit cleanly into the existing tool registry pattern.

---

## File map

| File | Role |
|---|---|
| [`lib/tools.js`](../lib/tools.js) | 3 tool schemas + implementations + executeTool envelope |
| [`lib/agent-loop.js`](../lib/agent-loop.js) | The provider-agnostic loop |
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) | `handleGroundedChat` agent-path branch, `_isFollowupNeedingTools`, `_extractAllowedWorkerIds`, `_runAgentPath` |
| [`server.js`](../server.js) | `callClaude` / `callGemini` wrappers with `tools` opt + tool_calls surfacing |
| [`tests/agent-loop.test.js`](../tests/agent-loop.test.js) | 21 tests covering tool schemas, allow-list, intent detection, loop semantics, error wrapping |
