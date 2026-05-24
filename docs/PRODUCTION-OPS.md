# Production Operations

How jak.ma runs in production. Code: [`server.js`](../server.js), [`vercel.json`](../vercel.json), [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js).

## Topology

```
[ User browser ]
       │
       ▼
[ jak.ma DNS → Vercel Edge Network ]
       │
       ▼
[ Vercel Serverless Function (Node 24.x on iad1) ]
       │
       ├──→ Anthropic API (Claude Sonnet 4-5, Haiku 4-5)
       ├──→ Google Gemini API (gemini-3-flash)
       ├──→ HuggingFace Space (Qwen2.5-1.5B Darija LoRA)
       ├──→ Twilio API (SMS OTP for worker registration)
       └──→ MongoDB Atlas (workers, eval_logs, semantic_cache, price_fairness_cache)
```

One serverless function handles all routes — no microservices, no Docker. Vercel's free tier runs this for $0/month at current scale.

Function timeout: 30s (`vercel.json#functions.maxDuration`). Per-pass budgets in [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) sum to 25s, leaving 5s of headroom.

Cold start: ~600 ms (warm: ~150 ms). Mongo connection pooled across invocations via a module-level singleton in `connectDB()`. LLM API clients are stateless `fetch()` — no connection reuse needed.

## `vercel.json`

```json
{
  "version": 2,
  "builds": [{
    "src": "server.js",
    "use": "@vercel/node",
    "config": { "maxDuration": 30 }
  }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

Every request goes through `server.js`. No static asset routing — Express serves `public/` directly. Single-binary deploy.

## MongoDB Atlas

### Collections and indexes

| Collection | Purpose | Key indexes |
|---|---|---|
| `workers` | Worker catalog (production only — not in this public repo) | `{category:1, city:1, approved:1, available:1}` · `{secondary_categories:1, city:1}` · `{category:1, featured:-1, verified:-1, rating:-1}` · `{name:'text', description:'text', tags:'text', zone:'text'}` |
| `eval_logs` | Per-request telemetry (90-day TTL) | `{ts:1}` TTL |
| `semantic_cache` | Pass-2 output reuse for identical queries (1-hour TTL) | `{key:1}` unique · `{ts:1}` TTL |
| `price_fairness_cache` | Worker price-fairness verdicts (24-hour TTL) | `{cache_key:1}` unique · `{ts:1}` TTL |
| `leaderboard_submissions` | External-model submissions (scaffolded) | — |
| `leaderboard_results` | Nightly judge scores | — |

Indexes are created idempotently in `ensureIndexes()` and `ensureTTLIndexes()` on cold start. MongoDB no-ops if the index already exists, so cold start adds no measurable latency.

### TTL strategy

| Collection | TTL | Rationale |
|---|---|---|
| `eval_logs` | 90 days | Long enough for monthly aggregation, short enough to bound collection size |
| `semantic_cache` | 1 hour | Marketplace state shifts fast; stale responses would point to unavailable workers |
| `price_fairness_cache` | 24 hours | Price ranges are day-to-day stable; refresh daily catches new workers in each trade × city pair |

## SSE streaming

All chat endpoints stream via SSE. Wire format:

```
data: {"thinking":{"stage":"classify","trade":"بلومبي","city":"طنجة","source":"regex","elapsed_ms":2}}\n\n
data: {"thinking":{"stage":"retrieve","candidates_count":8,"elapsed_ms":42}}\n\n
data: {"text":"لقيتلك "}\n\n
data: {"text":"8 بلومبيين فطنجة"}\n\n
...
data: {"done":true,"workers":[...],"workersByTrade":{},"verifier":{"ok":true,"score":1}}\n\n
```

Five event types the frontend handles:

| Event | Meaning |
|---|---|
| `{text}` | Token chunk — append to current bubble |
| `{thinking}` | Stage telemetry — render in collapsible reasoning pane |
| `{done, workers, workersByTrade, verifier, agent?}` | Final event — render worker cards, close stream |
| `{error}` | Error string in Darija — replace bubble with error message |
| `data: [DONE]` | Stream-end sentinel from provider (translated in wrapper) |

`streamWrite(res, text)`, `streamEnd(res, payload)`, and `streamThinking(res, stage, data)` helpers live in [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js). All check `res.writableEnded` before writing — closed-stream writes silently no-op.

## Cross-provider SSE translation

Anthropic, Gemini, and OpenAI all stream in different formats. jak.ma's frontend speaks one (OpenAI-style). The wrappers translate.

Anthropic SSE (native):
```
event: message_start
data: {"type":"message_start", ...}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"لقيت"}}

event: message_stop
data: {"type":"message_stop"}
```

Gemini SSE (with `?alt=sse`):
```
data: {"candidates":[{"content":{"parts":[{"text":"لقيت"}]},"finishReason":null}]}
data: {"candidates":[{"finishReason":"STOP"}]}
```

OpenAI shape (frontend reads):
```
data: {"choices":[{"delta":{"content":"لقيت"}}]}
data: [DONE]
```

[`_wrapClaudeStream`](../server.js) and [`_wrapGeminiStream`](../server.js) each set up a Node `PassThrough` stream. They consume the upstream provider's chunks in an async iterator, parse the events, and emit OpenAI-shape chunks on the PassThrough. Callers treat `body` as a normal Node Readable.

This translation is the abstraction that lets [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) work with any provider without knowing the difference.

## Error handling and graceful degradation

Defensive pattern at every layer:

| Layer | Failure | Mitigation |
|---|---|---|
| Vercel cold start | First request slow | Most users get a warm container; 600 ms cold-start budget |
| MongoDB connection | Mongo down | `getWorkers()` falls back to `loadWorkersJSON()` (local file subset) |
| Provider 1 (Gemini) overloaded | 429 / 503 | Router falls through to Anthropic |
| Provider 2 (Anthropic) overloaded | 429 / 503 | Router falls through to HF Darija LoRA |
| Provider 3 (HF LoRA) cold start | 20–60s wait | Configurable timeout; on timeout, canned Darija "try again" message |
| Pass-1 LLM timeout | 4s elapsed | AbortController fires; fall through to clarification message |
| Pass-2 stream interrupted | Network error mid-stream | Frontend renders partial response with retry button |
| Agent tool timeout (1.5s) | DB query slow | Tool returns `{ error: 'timeout' }`; LLM continues with reduced data |
| Agent loop crashes | Any throw | Catch in `handleGroundedChat`, fall back to grounded path |
| eval_logs write fails | Mongo write error | `.catch()` swallows — response was already sent |
| Verifier flags hallucinated ID | Hard violation | Append Darija advisory pointing user to worker cards instead of prose |

Each layer ensures the layer above sees a sensible (if degraded) response, never an exception. If everything below fails, the user sees a canned Darija message instead of a 500.

## Observability

### 1. `eval_logs` MongoDB collection

Per-request telemetry. See [`docs/EVALUATION.md`](./EVALUATION.md) for the full schema. Queryable via MongoDB aggregations for p50/p99, regex hit rate, tool success rate.

### 2. Vercel function logs

Every `console.log` / `console.warn` from the function appears in the Vercel dashboard. Notable warn lines:

- `[router] degraded to claude after primary failed: ...` — Gemini failed, Anthropic took over
- `[router] gemini failed (429): rate limited` — specific provider failure
- `[classify] LLM call failed → fallback: ...` — Pass-1 LLM threw
- `[agent] failed, falling back to grounded: ...` — agent loop threw

All grep-able for incident triage.

### 3. `/api/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "grounded_retrieval": true,
  "claude_configured": true,
  "gemini_configured": true,
  "hf_darija_fallback": "https://samielakkad1-jakma-darija-chat.hf.space",
  "llm_routing": "multi-provider (gemini-3-flash default → claude-sonnet-4-5 hard → HF Darija LoRA fallback)",
  "twilio_configured": false,
  "db": "ok",
  "worker_count": 1996,
  "slm": { "ok": false, "configured": false }
}
```

Used by deployment smoke tests and uptime monitors. 200 if app is up, 503 if DB unreachable.

### 4. `/api/ai/classify`

Human-in-the-loop classifier introspection. See [`docs/EVALUATION.md`](./EVALUATION.md).

### 5. `X-Request-Id` response header

Every `/api/ai/chat` response includes a 16-hex request ID in the response headers. Same ID is logged to `eval_logs`. Users reporting a problem quote the ID; engineers pull the full telemetry for that exact request.

## Privacy decisions

| Decision | Rationale |
|---|---|
| Worker phone numbers are public on listings, but agent tools return only `phone_last3` | LLM never gets the full number; user contacts via the UI's WhatsApp button. Defense against prompt-injection extraction. |
| Worker IDs allowlisted per conversation | Prevents agent tools from enumerating arbitrary worker records via tool calls |
| Reviewer initials, not full names | Reviews show `م.ب` instead of full name |
| `eval_logs` keeps queries for 90 days | Long enough for analysis, short enough that data is not perpetual |
| No tracking cookies, no analytics SDK | Vercel Web Analytics (privacy-friendly, no PII); Microsoft Clarity opt-in via cookie banner |
| `data/workers.json` not in the public repo | Real worker contact data lives only in private repo + MongoDB |
| `.env` files always gitignored | API keys, Mongo URI, admin password live only in Vercel env vars; the public repo's admin password fallback is a placeholder string |

## Rate limiting

Built with `express-rate-limit`:

| Route | Limit |
|---|---|
| `/api/ai/chat` | 30/hr per IP |
| `/api/ai/vision`, `/api/ai/smartmsg`, `/api/ai/darija`, `/api/ai/classify` | 30/hr per IP |
| `/api/workers` (registration) | 5/hr per IP |
| `/api/workers/:id/review` | 10/hr per IP |
| `/api/otp/send` | 5/hr per IP |

Chat limits are generous (a typical user runs 5–10 queries in a session). The 5/hr on registration is the anti-spam baseline. On limit hit: 429 with `Retry-After` header; frontend shows a Darija "limit reached" message.

## Cold-start optimization

Done:
- Single-file Node app (no bundler, no transpilation)
- Module-level Mongo connection pool reused across requests
- Lazy `require()` for heavy modules where possible
- No build step (Vercel deploys the source directly)

Not done:
- Provisioned concurrency on Vercel (would eliminate cold starts; costs money)
- Edge function migration (some routes could move to Edge runtime; the `mongodb` driver is not Edge-compatible)
- ESM modules (still CommonJS — easier debugging, slightly slower import)

Result: p50 cold start ~600 ms, p50 warm ~150 ms. Adequate for a free-tier deploy.

## End-to-end trace of one query

User types `"bghit plombier f tanja"`:

1. Browser PWA collects `{ messages, city: null, category: null, image: null }`. POSTs to `/api/ai/chat`.
2. Vercel routes to `server.js` (warm — ~50 ms).
3. Express middleware: rate-limit (30/hr), JSON body parser.
4. Route handler `/api/ai/chat`:
   - `LLM_CONFIGURED` check passes
   - `GROUNDED_RETRIEVAL` flag enabled → delegate to `handleGroundedChat`
   - Pass `callLLM` as `callXAI`, plus `callClaude` separately for the agent path
5. `handleGroundedChat` ([`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js)):
   - Parse body, `query = "bghit plombier f tanja"`
   - Write SSE headers (`Content-Type: text/event-stream`)
   - Generate `request_id`, set `X-Request-Id` header
   - Agent-path detection: `allowedWorkerIds` empty → skip
6. Pass 0.5: `detectMultiTrade("bghit plombier f tanja")` → null
7. Pass 1 (regex first):
   - `regexClassify` reads `KEYWORD_TO_CAT`, matches `"plombier"` → trade=بلومبي
   - `regexClassify` reads `KEYWORD_TO_CITY`, matches `"tanja"` → city=طنجة
   - Returns `{ trade:'بلومبي', city:'طنجة', urgency:'normal', confidence:0.85, source:'regex' }`
   - Elapsed ~2 ms
8. `streamThinking` event: stage='classify', trade=بلومبي, city=طنجة, source='regex', elapsed_ms=2
9. `retrieveCandidates(db, classification)`:
   - MongoDB query with `{category:'بلومبي', city:'طنجة', approved:{$ne:false}, available:{$ne:false}}`, sorted by `featured:-1, verified:-1, rating:-1`, limit 8
   - Returns 8 worker docs
   - Elapsed ~30 ms
10. `streamThinking` event: stage='retrieve', candidates_count=8, elapsed_ms=30
11. `speculativeIntro()`: stream `"لقيتلك 8 بلومبيين فطنجة، جا نوريهملك..."` immediately (latency hack)
12. `semantic_cache` lookup: no hit
13. Pass 2 — `streamConstrainedResponse`:
    - Build system prompt with 8 candidate workers + grounding rules
    - Messages: `[system, ...history, user]`
    - Routing hints: `{ hasImage: false, multiTrade: false, lowConfidence: false, longHistory: false }`
    - All false → router picks `gemini-3-flash`
    - `callLLM` with `stream:true` → `callGemini` → Gemini SSE
    - For each chunk: parse `candidates[0].content.parts[0].text` → token → strip ObjectId leaks → emit `{text}` to user
    - Stream ends; full output collected for verification
14. Pass 3 — `verifyGrounding`:
    - Extract `<<WORKERS:id1,id2,id3>>` marker
    - Validate each ID is in candidate set (yes, all 3)
    - Scan prices for plausibility (90–220 MAD/hr — within range)
    - Scan Latin proper nouns against candidate names (no violations)
    - Score: 1.0
15. `semantic_cache` write: `{ key:query, rawOutput, cited_ids, candidate_ids, classification }`
16. `streamEnd`: `data: {done:true, workers:[3 sanitized worker objects], workersByTrade:null, verifier:{ok:true, score:1, violations:[]}}`
17. `res.end()` — SSE closes
18. `persistEvalLog` (fire-and-forget): write request_id, path='grounded', query, classification, candidatesCount=8, citedIds=[3 IDs], verifier, timings to MongoDB
19. Browser receives final `{done}` event:
    - Render 3 worker cards
    - Save assistant message to history with `workers_cited` sidecar
    - User can now follow up — e.g., "is the first one good?" — triggering the agent path

End-to-end: ~1.2s p50 warm. Cold start adds ~600 ms.

## File map

| File | Role |
|---|---|
| [`server.js`](../server.js) | Express app, all routes, middleware, wrappers |
| [`vercel.json`](../vercel.json) | Function configuration (30s max duration) |
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) | Main pipeline (Pass 0.5 → Pass 1 → retrieve → Pass 2 → verifier → eval_logs) |
| [`lib/semantic-cache.js`](../lib/semantic-cache.js) | Cache helpers (scaffolded, not actively serving hits) |
| [`/api/health`](https://www.jak.ma/api/health) | Liveness + readiness endpoint |
| [`/api/ai/classify`](https://www.jak.ma/api/ai/classify?q=test) | Debug introspection endpoint |
