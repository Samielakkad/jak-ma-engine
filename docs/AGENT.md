# The Tool-Calling Agent

Code: [`lib/agent-loop.js`](../lib/agent-loop.js), [`lib/tools.js`](../lib/tools.js), [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js).

## Summary

When a user gets a worker recommendation and then asks a follow-up like *"is the first one good?"* or *"shchhal kayseweh?"* (how much would it cost), jak.ma switches from retrieve-then-generate to a tool-calling agent. The LLM (Claude Sonnet 4.5) calls one or more of three tools, receives data from MongoDB, and writes a Darija answer.

The loop is bounded: at most two LLM round-trips, at most three tool calls per round, 1.5 seconds per tool. The tool surface is small — three tools — and constrained at two layers (a name allowlist and a per-conversation worker-ID allowlist).

## Scope

What this is:
- A single-round agent that converts a follow-up question into one or two LLM calls plus one to three MongoDB-backed tool invocations.
- Provider-agnostic at the input layer (Anthropic and Gemini both supported) but Claude Sonnet 4.5 in production.

What this is not:
- A multi-step planner. The LLM does not decompose tasks. Multi-trade detection (e.g., bathroom renovation → plumber + tiler + electrician + painter) is handled by deterministic regex in [`lib/text-classifier.js`](../lib/text-classifier.js).
- An autonomous tool-discovery system. The three tools are fixed; the LLM picks among them but cannot reach for tools outside the registry.
- Cross-provider mid-conversation. Anthropic's `tool_use` and Gemini's `functionCall` formats differ enough that mixing them in a single loop is error-prone. The loop runs Claude only.

## The three tools

| Tool | Input | Output | Data source |
|---|---|---|---|
| `lookupWorkerById` | `{ workerId: 24-hex }` | name, city, zone, description, price range, rating, experience, last 3 digits of phone | `db.collection('workers').findOne({_id, approved})` |
| `getRecentReviews` | `{ workerId, limit?: 1–5 }` | recent reviews (initials, stars, text), average rating, total count | embedded `reviews[]` on worker doc |
| `estimatePrice` | `{ trade, city, options?: { experience_years, urgency, company } }` | `{ price_min, price_max, price_unit, currency, baseline_n }` | [`scripts/price-engine.js#computePriceRange`](../scripts/price-engine.js) + MongoDB count for `baseline_n` |

Each tool is defined in [`lib/tools.js`](../lib/tools.js) with three artifacts:
- `anthropicSchema` for the Anthropic `/v1/messages` `tools[]` array
- `geminiSchema` for Gemini `functionDeclarations[]`
- `impl(input, ctx)` — async JS that returns `{...result}` on success or `{ error, message }` on graceful failure (never throws)

The shared `executeTool(name, input, ctx)` wraps each call with a 1.5-second timeout and converts exceptions into structured error results.

## Safety boundaries

**1. Worker-ID allowlist.** `lookupWorkerById` and `getRecentReviews` refuse worker IDs not present in the current conversation's allowlist. The allowlist is built by [`_extractAllowedWorkerIds(messages, workerContext)`](../lib/grounded-retrieval.js) from three sources:

1. `<<WORKERS:id1,id2>>` markers in any prior assistant message
2. `m.workers_cited[]` sidecar on prior assistant messages (the frontend populates this from `doneData.workers`, which is more reliable than parsing text)
3. `req.body.workerContext` (set when the chat begins on a worker detail page)

Anything not 24-hex is discarded. If the LLM hallucinates an ID, the tool returns `{ error: 'worker_not_in_context' }` and the model can recover gracefully.

**2. Tool-name allowlist.** [`lib/agent-loop.js`](../lib/agent-loop.js) carries a hard-coded `ALLOWED_NAMES` set: `{ lookupWorkerById, getRecentReviews, estimatePrice }`. Any other tool name in a `tool_use` block is rejected without execution.

**3. Phone privacy.** `lookupWorkerById` returns `phone_last3` only, plus a `privacy_note` field that instructs the LLM not to invent the full number. The full phone is delivered to the user only via the UI's WhatsApp button.

**4. Timeouts.** Per-tool: 1.5s. Per LLM iteration: governed by the `signal` AbortController. Total agent path budget: ~5s. On timeout, the loop throws and `handleGroundedChat` falls back to the standard retrieve-then-generate path.

## Provider integration

Both Anthropic and Gemini support native tool calling. The wrappers in [`server.js`](../server.js) translate their formats into a unified OpenAI shape.

| Provider | Native format | Wrapper translation |
|---|---|---|
| Anthropic | `tools[]` schema; response `content[]` includes `tool_use` blocks | `_wrapClaudeResponse` extracts `tool_use` → OpenAI `tool_calls[]`; stashes raw blocks under `anthropic_content_blocks` for echo-back |
| Gemini | `functionDeclarations[]`; response `parts[]` includes `functionCall` parts | `_wrapGeminiResponse` extracts `functionCall` → same `tool_calls[]` shape |
| HF Darija LoRA | not supported | Router skips this tier when `tools` are present |

The agent loop reads `data.choices[0].message.tool_calls` regardless of which provider answered. The Anthropic wrapper also preserves the raw content blocks because Anthropic's protocol requires the next user turn to include `tool_result` blocks whose `tool_use_id` values match the original assistant turn verbatim.

## Loop semantics

```js
// lib/agent-loop.js — semantics (lightly edited for the doc)

async function runAgentLoop({ messages, tools, callClaude, ctx, onThinking, maxIterations = 2 }) {
  const conversation = [...messages];
  const toolsCalled = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    const isLast = iter === maxIterations - 1;
    const opts = isLast ? {} : { tools };  // last iter forces text output

    const response = await callClaude(conversation, opts);
    const msg = (await response.json()).choices[0].message;
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0 || isLast) {
      return { response, iterations: iter + 1, toolsCalled };
    }

    // Echo assistant turn back (raw Anthropic blocks for ID round-trip)
    conversation.push({ role: 'assistant', content: msg.anthropic_content_blocks });

    // Execute up to 3 tools, each with 1.5s timeout
    const results = [];
    for (const tc of toolCalls.slice(0, 3)) {
      if (!ALLOWED_NAMES.has(tc.function.name)) {
        results.push({ tool_use_id: tc.id, error: 'unknown_tool' });
        continue;
      }
      onThinking(`🔍 ${tc.function.name}…`);
      const r = await executeTool(tc.function.name, parse(tc.function.arguments), ctx);
      results.push({ tool_use_id: tc.id, ...r });
      toolsCalled.push({ name: tc.function.name, ok: r.ok, latency_ms: r.latency_ms });
      onThinking(`✅ ${tc.function.name} (${r.latency_ms}ms)`);
    }

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

Three design notes:

1. **Last-iteration tool drop.** On the final iteration the loop passes no `tools` array, forcing the model to produce text. This guarantees termination — without it, a misbehaving model could keep calling tools indefinitely.

2. **`anthropic_content_blocks` echo-back.** Anthropic's tool-use protocol requires the assistant's `tool_use` blocks to appear verbatim in the next user turn (the one carrying the matching `tool_result`). The OpenAI-shape `tool_calls[]` array doesn't preserve enough structure to round-trip cleanly, so the wrapper stashes the raw blocks and the loop echoes those back.

3. **Direct Claude call, not router.** The loop calls `callClaude` directly rather than `callLLM`, because the router's HF tier doesn't support tool calling and mixing providers mid-loop breaks the conversation shape. If Claude is unavailable, the caller catches the error and falls back to the grounded path.

## Routing: when the agent path fires

The agent path runs when two conditions in [`lib/grounded-retrieval.js#handleGroundedChat`](../lib/grounded-retrieval.js) both hold:

**Condition 1: allowlist non-empty.** `_extractAllowedWorkerIds(messages, workerContext)` returns at least one worker ID. If empty, the agent has no targets and skips.

**Condition 2: follow-up intent.** `_isFollowupNeedingTools(query, allowedWorkerIds)` matches the query against four intent families:

| Family | Examples |
|---|---|
| Anaphoric reference | `the first`, `الأول`, `ديك`, `that one`, `\bhe\b` |
| Price | `shchhal`, `how much`, `combien`, `سعر`, `fair price` |
| Reviews / opinion | `reviews`, `is X good`, `تقييم`, `chno gultu`, `مزيان` |
| Details | `tell me more`, `details`, `تفاصيل`, `أكثر`, `tell me about` |

If neither condition fires, the chat goes through the standard regex → retrieve → stream pipeline. Errors in the agent branch fall back silently to that pipeline.

## SSE streaming

The loop emits `thinking` events between tool calls. The frontend already renders these as a collapsible reasoning pane (the same mechanism the regex/LLM classifier uses). Example sequence for *"tell me everything about the first one with reviews"*:

```
data: {"thinking":{"stage":"agent","text":"🔍 كنشوف تفاصيل المعلم (898a0e)…"}}
data: {"thinking":{"stage":"agent","text":"✅ تم الحصول على التفاصيل (226ms)"}}
data: {"thinking":{"stage":"agent","text":"⭐ كنقلب على التقييمات الأخيرة…"}}
data: {"thinking":{"stage":"agent","text":"✅ جبت 3 تقييم (225ms)"}}
data: {"text":"**Climatizone** — بلومبي فطنجة، زونة °36: ..."}
data: {"done":true,"agent":{"iterations":2,"tools_called":["lookupWorkerById","getRecentReviews"]}}
```

The thinking events are buffered server-side until the loop produces a valid final answer. If the loop fails partway through, nothing has been written to the client and the grounded path takes over.

## Telemetry

Every agent-path query writes a record to MongoDB's `eval_logs` collection (90-day TTL):

```js
{
  request_id: '<16-hex>',
  path: 'agent',
  query: '...',
  agent_iterations: 1 | 2,
  tools_called: [{ name, input_summary, ok, error?, latency_ms }],
  allowedWorkerIds: [...],
  timings: { agent_total, total },
  verifier: { ok, source: 'agent_path' },
}
```

Tool-call success rate, per-tool p50 latency, and average iterations are reachable from a single MongoDB aggregation.

## Patterns for audio agents

What transfers to a multimodal audio LLM stack:

| Pattern in this work | Audio analog |
|---|---|
| Bounded loop (max iterations + max tools per iteration) | Real-time audio agents need hard latency budgets; same envelope pattern |
| Allowlist at data + name layers | Voice agents accessing personal data (contacts, calendar) need the same defense in depth |
| Provider-agnostic OpenAI-shape adapter | Multi-vendor audio (Whisper, Moshi, AssemblyAI, NeMo) benefits from a unified caller interface |
| `thinking` SSE events between tool calls | Streaming voice agent state (`"listening..."`, `"looking up..."`, `"speaking..."`) |
| Tool-call telemetry in eval_logs | Audio agent eval needs the same: which tool fired, latency, error per category |

What does not transfer: nothing in this stack handles audio input or output. Adding real-time voice would require a streaming infrastructure (duplex SSE or WebSocket) and audio-specific tools — separate work, not built here.

## Limitations and future work

Not built:
- Multi-step recursive planning. The loop is a single round of `LLM → tools → LLM → text`.
- External tools (web search, calendar, email). The three tools all read from the same MongoDB the rest of the app reads.
- Persistent agent memory across sessions. Conversation history is the only state.
- Streaming tool execution. The agent waits for all tools to finish before emitting tokens. A multimodal audio agent would want token-by-token streaming interleaved with tool calls.

Next directions if extending:
1. Streaming tool execution (token-level interleaving with tool calls)
2. Multi-step ReAct loop with planned decomposition for project-scale tasks
3. Confirmation step before destructive tools (relevant when adding tools that send messages or initiate payments)
4. Memory tier (Redis or vector DB) for cross-session preferences
5. Audio-specific tools: `transcribe(audio)`, `synthesize(text)`, `detect_voice_activity(stream)` — would fit the existing tool-registry pattern

## File map

| File | Role |
|---|---|
| [`lib/tools.js`](../lib/tools.js) | Three tool schemas + implementations + `executeTool` envelope |
| [`lib/agent-loop.js`](../lib/agent-loop.js) | Provider-agnostic loop |
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) | `handleGroundedChat` agent branch, `_isFollowupNeedingTools`, `_extractAllowedWorkerIds`, `_runAgentPath` |
| [`server.js`](../server.js) | `callClaude` / `callGemini` wrappers with `tools` parameter and `tool_calls` extraction |
| [`tests/agent-loop.test.js`](../tests/agent-loop.test.js) | 21 tests covering tool schemas, allowlist, intent detection, loop semantics, error wrapping |
