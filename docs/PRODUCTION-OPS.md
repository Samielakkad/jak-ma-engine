# Production Operations

> Deep dive: how jak.ma actually runs in production — Vercel serverless cold-starts, MongoDB indexes, SSE streaming patterns, error handling, graceful degradation, observability, privacy decisions.
> Code: [`server.js`](../server.js), [`vercel.json`](../vercel.json), [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js).

---

## Deployment topology

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

Single serverless function handles all routes — no microservices, no Kubernetes, no Docker. Vercel's free tier runs this for $0/month at jak.ma's current scale.

**Function timeout**: 30s (configured in `vercel.json#functions.maxDuration`). Per-pass budgets in [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) sum to 25s, leaving 5s of headroom.

**Cold start**: ~600 ms (warm: ~150 ms). Mongo connection pooled across invocations via a module-level singleton in `connectDB()`. LLM API clients are stateless `fetch()` calls — no connection reuse needed.

---

## `vercel.json` configuration

```json
{
  "version": 2,
  "builds": [{
    "src": "server.js",
    "use": "@vercel/node",
    "config": { "maxDuration": 30 }
  }],
  "routes": [{
    "src": "/(.*)",
    "dest": "server.js"
  }]
}
```

Every request goes through `server.js`. No static asset routing (those are served by Express from `public/`). Single-binary deploy — the entire app is one Node process.

---

## MongoDB Atlas schema

### Collections + indexes

| Collection | Purpose | Key indexes |
|---|---|---|
| `workers` | Worker catalog (production only — not in this public repo) | `{category:1, city:1, approved:1, available:1}` · `{secondary_categories:1, city:1}` · `{category:1, featured:-1, verified:-1, rating:-1}` · `{name:'text', description:'text', tags:'text', zone:'text'}` |
| `eval_logs` | Per-request telemetry (90-day TTL) | `{ts:1}` (TTL) |
| `semantic_cache` | Pass-2 output reuse for identical queries (1-hour TTL) | `{key:1}` (unique) · `{ts:1}` (TTL) |
| `price_fairness_cache` | Worker price-fairness verdicts (24-hour TTL) | `{cache_key:1}` (unique) · `{ts:1}` (TTL) |
| `leaderboard_submissions` | External-model submissions (scaffolded, not active) | — |
| `leaderboard_results` | Nightly judge scores | — |

Indexes are created idempotently in `ensureIndexes()` and `ensureTTLIndexes()` on cold start (in [`server.js`](../server.js)). MongoDB no-ops if the index already exists, so cold start doesn't add measurable latency.

### TTL strategy

Why 3 different TTLs:

- `eval_logs`: 90 days — long enough for monthly aggregation queries, short enough to keep the collection from ballooning
- `semantic_cache`: 1 hour — query intent shifts fast in a marketplace; stale cached responses would point users to workers who may no longer be available
- `price_fairness_cache`: 24 hours — price ranges are stable day-to-day; refresh daily to catch newly registered workers in a trade × city pair

### Worker schema (production — kept out of this public repo)

The schema is documented in [`ARCHITECTURE.md`](../ARCHITECTURE.md) but the actual data isn't here. Real workers have: name, phone, city, zone, category, secondary_categories, description, tags, price, rating, rating_count, reviews[], verified, featured, available, approved, experience, createdAt.

---

## SSE streaming pattern

All chat endpoints use Server-Sent Events for the response stream. Wire format:

```
data: {"thinking":{"stage":"classify","trade":"بلومبي","city":"طنجة","source":"regex","elapsed_ms":2}}\n\n
data: {"thinking":{"stage":"retrieve","candidates_count":8,"elapsed_ms":42}}\n\n
data: {"text":"لقيتلك "}\n\n
data: {"text":"8 بلومبيين فطنجة"}\n\n
...
data: {"done":true,"workers":[...],"workersByTrade":{},"verifier":{"ok":true,"score":1}}\n\n
```

5 SSE event types the frontend handles:

| event | meaning |
|---|---|
| `{text}` | Token chunk during streaming — append to current bubble |
| `{thinking}` | Stage telemetry — render in collapsible reasoning pane |
| `{done, workers, workersByTrade, verifier, agent?}` | Final event — render worker cards, close stream |
| `{error}` | Error string in Darija — replace bubble with error message |
| `data: [DONE]` | Stream-end sentinel from provider (translated in wrapper) |

`streamWrite(res, text)` and `streamEnd(res, payload)` and `streamThinking(res, stage, data)` are helpers in [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js). All check `res.writableEnded` before writing — once the stream is closed (e.g. due to client disconnect), subsequent writes silently no-op.

---

## Cross-provider SSE translation (the hard part)

Anthropic, Gemini, and OpenAI all have different streaming chunk formats. jak.ma's frontend speaks one format (OpenAI-style). So the wrappers translate.

**Anthropic SSE format** (native):
```
event: message_start
data: {"type":"message_start", ...}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"لقيت"}}

event: message_stop
data: {"type":"message_stop"}
```

**Gemini SSE format** (native — set `?alt=sse`):
```
data: {"candidates":[{"content":{"parts":[{"text":"لقيت"}]},"finishReason":null}]}

data: {"candidates":[{"content":{"parts":[{"text":"لك"}]}}]}

data: {"candidates":[{"finishReason":"STOP"}]}
```

**OpenAI shape** (what the frontend reads):
```
data: {"choices":[{"delta":{"content":"لقيت"}}]}

data: {"choices":[{"delta":{"content":"لك"}}]}

data: [DONE]
```

[`_wrapClaudeStream`](../server.js) and [`_wrapGeminiStream`](../server.js) each set up a Node `PassThrough` stream. They consume the upstream provider's chunks in an async iterator, parse each provider's events, and emit OpenAI-shape chunks on the PassThrough. The caller treats the wrapper's `body` as a normal Node Readable.

This translation is the abstraction that lets `lib/grounded-retrieval.js` work with any provider without knowing the difference.

---

## Error handling + graceful degradation

The defensive pattern at every layer:

| layer | failure mode | mitigation |
|---|---|---|
| Vercel cold start | First request slow | Most users get warm container; cold-start budget includes 600ms headroom |
| MongoDB connection | Mongo down | `getWorkers()` falls back to `loadWorkersJSON()` (local file with worker subset) |
| Provider 1 (Gemini) overloaded | 429 / 503 | Router falls through to Anthropic |
| Provider 2 (Anthropic) overloaded | 429 / 503 | Router falls through to HF Darija LoRA |
| Provider 3 (HF LoRA) cold start | 20-60s wait | Configurable timeout; on timeout, return canned Darija "try again" message |
| Pass-1 LLM timeout | 4s elapsed without response | AbortController fires; fall through to "ask clarification" canned response |
| Pass-2 LLM stream interrupted | Network error mid-stream | Frontend renders partial response with retry button |
| Agent tool timeout (1.5s) | DB query slow | Tool returns `{ error: 'timeout' }`; LLM continues with reduced data |
| Agent loop crashes | Any throw | Catch in `handleGroundedChat`, fall back to standard grounded path |
| eval_logs write fails | Mongo write error | `.catch()` swallows — response was already sent |
| Verifier flags hallucinated ID | Hard violation | Append a Darija warning to the response pointing user to the worker cards instead of the prose |

The hierarchy is consistent: **each layer's job is to ensure the layer above sees a sensible (if degraded) response**, never an exception. If everything below fails, the user sees a canned Darija message instead of a 500.

---

## Observability stack

### 1. `eval_logs` MongoDB collection

Per-request telemetry. See [`docs/EVALUATION.md`](./EVALUATION.md) for the full schema. Queryable via MongoDB aggregations for p50/p99, regex hit rate, tool success rate, etc.

### 2. Vercel function logs

Every `console.log` / `console.warn` from the function shows up in the Vercel dashboard. Notable warn lines:

- `[router] degraded to claude after primary failed: ...` — Gemini failed, Anthropic took over
- `[router] gemini failed (429): rate limited` — specific provider failure
- `[classify] LLM call failed → fallback: ...` — Pass-1 LLM threw
- `[agent] failed, falling back to grounded: ...` — agent loop threw

Grep-able for incident triage.

### 3. `/api/health` endpoint

Returns:
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

Used by deployment smoke tests and uptime monitors. Returns 200 if app is up, 503 if DB unreachable.

### 4. `/api/ai/classify` debug endpoint

For human-in-the-loop classifier introspection. See [`docs/EVALUATION.md`](./EVALUATION.md).

### 5. `X-Request-Id` response header

Every `/api/ai/chat` response includes a 16-hex request ID in the response headers. Same ID is logged to `eval_logs`. Users reporting a problem can quote the ID; engineers can immediately pull the full telemetry for that exact request.

---

## Privacy decisions

Several deliberate calls about what data is exposed where:

| decision | rationale |
|---|---|
| Worker phone numbers are public on listings, but agent tools return only `phone_last3` | LLM never gets the full number; user contacts via the UI WhatsApp button which has the full number. Defense against the model being prompt-injected to "reveal the phone." |
| Worker IDs allow-listed per conversation | Prevents the agent tools from enumerating arbitrary worker records via tool calls. |
| Reviewer initials, not full names | Reviews show `م.ب` instead of full name. Lighter privacy posture than the worker phone but still respects reviewer wishes. |
| `eval_logs` keeps queries for 90 days | Long enough for analysis, short enough that data isn't perpetual. |
| No tracking cookies, no analytics SDK | Just Vercel Web Analytics (privacy-friendly, no PII) and Microsoft Clarity (opt-in via cookie banner in production). |
| `data/workers.json` NOT in this public repo | Real worker contact data lives only in the private repo + MongoDB. The public mirror has zero PII. |
| `.env` files always gitignored | API keys + Mongo URI + admin password live only in Vercel env vars. The public repo's admin password fallback is a clearly-invalid placeholder string. |

---

## Rate limiting

Built with `express-rate-limit`:

| route | limit |
|---|---|
| `/api/ai/chat` | 30 per hour per IP |
| `/api/ai/vision`, `/api/ai/smartmsg`, `/api/ai/darija`, `/api/ai/classify` | 30 per hour per IP |
| `/api/workers` (registration) | 5 per hour per IP |
| `/api/workers/:id/review` | 10 per hour per IP |
| `/api/otp/send` | 5 per hour per IP |

Rate limits are intentionally generous for the chat endpoints — a real user might run through 5-10 chat queries in a sitting. The 5/hr on registration is the anti-spam baseline.

When a limit is hit, the response is a `429` with `Retry-After` header. Frontend shows a Darija "you've reached the limit, try again later" message.

---

## Cold-start optimization (what's done + what isn't)

Done:
- Single-file Node app (no bundler, no transpilation, fast startup)
- Module-level Mongo connection pool reused across requests
- Lazy `require()` for heavy modules where possible
- No build step (Vercel deploys the source directly)

Not done:
- Provisioned concurrency on Vercel (would eliminate cold starts entirely, but costs $)
- Edge function migration (some routes could move to Edge runtime for lower cold-start, but `mongodb` driver isn't Edge-compatible)
- ESM modules (still CommonJS — easier debugging, slightly slower import)

The result: p50 cold start ~600ms, p50 warm ~150ms. For a free-tier deploy, that's good enough.

---

## How a typical query flows through the stack (end-to-end)

User types `"bghit plombier f tanja"` and hits send:

```
1. Browser PWA collects: { messages, city: null, category: null, image: null }
   POST /api/ai/chat over fetch with Content-Type: application/json

2. Vercel routes to server.js function (warm — ~50ms)

3. Express middleware: rateLimit (30/hr), json body parser

4. Route handler /api/ai/chat:
   - LLM_CONFIGURED check (true)
   - GROUNDED_RETRIEVAL flag enabled → delegate to handleGroundedChat
   - Pass callLLM as callXAI, callClaude separately for the agent path

5. handleGroundedChat (lib/grounded-retrieval.js):
   - Parse body → query="bghit plombier f tanja"
   - SSE headers written (Content-Type: text/event-stream)
   - request_id generated, X-Request-Id header set
   - Agent-path detection: allowedWorkerIds empty → skip agent path

6. Pass 0.5: detectMultiTrade("bghit plombier f tanja") → null (no multi-trade match)

7. Pass 1 (regex first):
   - regexClassify reads KEYWORD_TO_CAT, matches "plombier" → trade=بلومبي
   - regexClassify reads KEYWORD_TO_CITY, matches "tanja" → city=طنجة
   - Returns { trade:'بلومبي', city:'طنجة', urgency:'normal', confidence:0.85, source:'regex' }
   - Elapsed: ~2ms

8. streamThinking event emitted: stage='classify', trade=بلومبي, city=طنجة, source='regex', elapsed_ms=2

9. retrieveCandidates(db, classification):
   - MongoDB query: { category:'بلومبي', city:'طنجة', approved:{$ne:false}, available:{$ne:false} }
     .sort({ featured:-1, verified:-1, rating:-1 }).limit(8)
   - Returns 8 worker docs
   - Elapsed: ~30ms

10. streamThinking event: stage='retrieve', candidates_count=8, elapsed_ms=30

11. speculativeIntro(): Stream "لقيتلك 8 بلومبيين فطنجة، جا نوريهملك..." immediately (Darija latency hack)

12. semantic_cache lookup: no hit (first time this query)

13. Pass 2 — streamConstrainedResponse:
    - Build system prompt with 8 candidate workers + grounding rules
    - Build messages: [system, ...history, user]
    - Routing hints: { hasImage: false, multiTrade: false, lowConfidence: false, longHistory: false }
    - All false → router picks gemini-3-flash
    - callLLM with stream:true → callGemini → Gemini SSE stream
    - For each chunk in the Gemini stream:
      - Parse Gemini's "candidates[0].content.parts[0].text" → token
      - Strip raw ObjectId leak (defense-in-depth regex)
      - Emit {text} SSE event to user
    - Stream ends, full output collected for verification

14. Pass 3 — verifyGrounding:
    - Extract <<WORKERS:id1,id2,id3>> marker from raw output
    - Validate each ID is in candidates set (yes, all 3 are)
    - Scan prices for plausibility (90-220 MAD/hr — within range)
    - Scan Latin proper nouns against candidate names (no violations)
    - Score: 1.0

15. semantic_cache write: { key:query, rawOutput, cited_ids, candidates_ids, classification }

16. streamEnd: data: {done:true, workers:[...3 sanitized worker objects], workersByTrade:null, verifier:{ok:true, score:1, violations:[]}}

17. res.end() — SSE stream closes

18. persistEvalLog (fire-and-forget): write request_id, path:'grounded', query, classification, candidatesCount:8, citedIds:[3 IDs], verifier, timings to MongoDB eval_logs

19. Browser receives the final {done} event:
    - Render 3 worker cards
    - Save assistant message to history with workers_cited sidecar
    - User can now ask a follow-up like "is the first one good?" → agent path fires
```

End-to-end: ~1.2s p50 (warm). Cold start adds ~600ms.

---

## File map

| File | Role |
|---|---|
| [`server.js`](../server.js) | Express app, all routes, all middleware, all wrappers |
| [`vercel.json`](../vercel.json) | Function configuration (30s max duration) |
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) | Main pipeline (Pass 0.5 → Pass 1 → retrieve → Pass 2 → verifier → eval_logs) |
| [`lib/semantic-cache.js`](../lib/semantic-cache.js) | Cache helpers (currently scaffolded — not actively serving cache hits) |
| [`/api/health`](https://www.jak.ma/api/health) | Liveness + readiness endpoint |
| [`/api/ai/classify`](https://www.jak.ma/api/ai/classify?q=test) | Debug introspection endpoint |
