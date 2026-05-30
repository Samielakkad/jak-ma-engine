# AI + LLM Agents · jak-ma-engine

Public engineering mirror of [**jak.ma**](https://jak.ma) — the production Moroccan Darija home-services marketplace.

This repo contains the code-only architecture: server, libraries, agent + classifier stack, tests, and the full [`ARCHITECTURE.md`](./ARCHITECTURE.md) document. The production worker dataset (real names + phone numbers of ~2,000 Moroccan tradespeople) is intentionally **not** included for privacy reasons — it lives only in the private production repo and MongoDB.

> **Live demo**: [jak.ma](https://jak.ma)
> **Architecture doc**: [ARCHITECTURE.md](./ARCHITECTURE.md)
> **Live classifier debug**: [`/api/ai/classify?q=bghit+plombier+f+tanja`](https://www.jak.ma/api/ai/classify?q=bghit+plombier+f+tanja)
> **Open-source Darija LoRA**: [huggingface.co/samielakkad1/jakma-darija-A-adapter](https://huggingface.co/samielakkad1/jakma-darija-A-adapter)

---

## What's in here

### The agent + classifier stack (May 2026)

- **Single-round tool-calling agent** ([`lib/agent-loop.js`](./lib/agent-loop.js)) — fires on follow-up queries like *"is the first one good?"* or *"shchhal kayseweh?"*. Three tools ([`lib/tools.js`](./lib/tools.js)): `lookupWorkerById`, `getRecentReviews`, `estimatePrice`. Allow-list-scoped, bounded loop, max 3 tools per iter with 1.5s timeout.

- **Romanized-Darija classifier** ([`lib/text-classifier.js`](./lib/text-classifier.js)) — ~260 trade keywords + ~90 city keywords across 12 trades and 15 cities. Covers 5 input forms (MSA / Darija script / Arabizi / French / English) including the full Arabizi convention set (`3=ع · 7=ح · 9=ق · 8=غ · 5=خ · 6=ط`). **~85% of Darija queries resolve in <20ms with zero LLM cost.**

- **Multi-provider routing** ([`server.js#callLLM`](./server.js)) — `gemini-3-flash` default → `claude-sonnet-4-5` for hard queries → HuggingFace Darija LoRA last-resort fallback. All three wrappers return OpenAI-shape so downstream code is provider-agnostic.

- **Two-pass grounded retrieval** ([`lib/grounded-retrieval.js`](./lib/grounded-retrieval.js)) — Pass 1 classifies, Pass 2 streams a constrained response that can only cite workers from the retrieved candidate set. Output is post-validated and ID-checked.

- **Public debug endpoint** [`/api/ai/classify`](https://www.jak.ma/api/ai/classify?q=bghit+plombier+f+tanja) — paste any Darija query, see which keyword matched and which pipeline path resolved it, in <5ms.

Full architecture, cost math, latency budgets, and defensibility checklist: [**ARCHITECTURE.md**](./ARCHITECTURE.md).

### Engineering deep-dives (`docs/`)

7 dedicated docs, one per subsystem, each with file:line citations, limitations sections, and notes on patterns applicable to audio work:

- [**`docs/AGENT.md`**](./docs/AGENT.md) — the tool-calling agent (3 tools, allow-list, single-round loop)
- [**`docs/CLASSIFIER.md`**](./docs/CLASSIFIER.md) — Darija/Arabizi classifier (5 input forms, 260+ keywords, Arabizi 3/7/9/8/5/6)
- [**`docs/LLM-ROUTING.md`**](./docs/LLM-ROUTING.md) — multi-provider routing (Gemini + Claude + HF, OpenAI-shape adapter)
- [**`docs/EVALUATION.md`**](./docs/EVALUATION.md) — eval_logs schema, 57 regression tests, 5-dim rubric, leaderboard
- [**`docs/MULTIMODAL.md`**](./docs/MULTIMODAL.md) — TF.js MobileNet (<250ms) + LLM vision fallback
- [**`docs/DARIJA-LORA.md`**](./docs/DARIJA-LORA.md) — open-source LoRA training methodology + production integration
- [**`docs/PRODUCTION-OPS.md`**](./docs/PRODUCTION-OPS.md) — Vercel cold-starts, Mongo schemas, SSE translation, error handling, end-to-end query trace

Index: [`docs/README.md`](./docs/README.md).

---

## Test coverage

```
node --test tests/text-classifier.test.js   # 36 tests — regex coverage
node --test tests/agent-loop.test.js        # 21 tests — agent stack
```

**57 tests total, all passing** — locks the regex behavior and the agent semantics against regression.

---

## Companion repos (Sami's other public artifacts)

- [**jak-ma-case-study**](https://github.com/Samielakkad/AI-Product-JakMa-Case-Study) — production case study, hero metrics, 5 architectural decisions, 5 things that broke
- [**jak-ma-eval-suite**](https://github.com/Samielakkad/AI-LLM-Evaluation-JakMa) — evaluation methodology + 5-dim rubric
- [**darija-nlp-resources**](https://github.com/Samielakkad/AI-NLP-Darija-Resources) — curated reading list of Moroccan Arabic NLP corpora, papers, and tools
- [**pm-frameworks-darija**](https://github.com/Samielakkad/AI-Product-Management-Frameworks) — reusable PM frameworks for low-resource LLM products
- [**ernie-evaluation-notes**](https://github.com/Samielakkad/AI-LLM-Evaluation-Baidu-ERNIE) — methodology from the Baidu ERNIE Mentor Program

---

## Tech stack

- **Runtime**: Node.js 18+ on Vercel serverless
- **LLMs**: Anthropic Claude (Sonnet 4.5), Google Gemini (3 Flash), HuggingFace Spaces (self-hosted Qwen2.5-1.5B Darija LoRA)
- **Database**: MongoDB (workers + eval_logs + caches)
- **Frontend**: vanilla HTML/CSS/JS PWA — no React, no build step, fast to load on Moroccan 3G
- **Vision**: browser-side TF.js MobileNet ([`public/js/local-classifier.js`](./public/js/local-classifier.js)) — 95% of image queries never hit the server
- **Testing**: `node --test` (zero deps)

---

## Local development

```bash
git clone https://github.com/Samielakkad/AI-LLM-Agents-JakMa-Engine
cd jak-ma-engine
npm install

# Required env vars (none of these are in git):
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-api03-...
GEMINI_API_KEY=AIza...
ADMIN_PASSWORD=use-a-strong-random-string-here
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/    # optional — falls back to local JSON
GROUNDED_RETRIEVAL=1
EOF

node server.js          # → http://localhost:3000
npm test                # all 57 tests
```

Get the API keys at:
- Anthropic: https://console.anthropic.com/settings/keys
- Google AI Studio: https://aistudio.google.com/apikey
- HuggingFace: https://huggingface.co/settings/tokens

---

## What's NOT in this repo

- `data/workers.json` — real worker contact data (name + phone + address × ~2,000 records). Lives in the private production repo + MongoDB only.
- `data/external/`, `data/finetune/` — 92MB of LoRA training data. See the HuggingFace model card for the trained artifact: [jakma-darija-A-adapter](https://huggingface.co/samielakkad1/jakma-darija-A-adapter).
- `.env` — all secrets are in env vars only.
- Git history before 2026-05-23 — squashed for the public mirror.

---

## License

MIT — code only. The trained LoRA on HuggingFace is Apache 2.0.

---

## Author

[Sami EL AKKAD](https://linkedin.com/in/samielakkad) — Tsinghua SIGS AI Master's · ex Baidu ERNIE Mentor (4.5) · founder of jak.ma.
