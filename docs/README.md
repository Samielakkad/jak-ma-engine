# `docs/` — Engineering Deep Dives

Per-subsystem technical documentation for jak.ma. Each doc is self-contained, with file:line references back to the repo and explicit limitations sections. For the architectural overview, start with [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Contents

| Doc | Subject | Length | Best for |
|---|---|---|---|
| [**AGENT.md**](./AGENT.md) | Tool-calling agent: 3 tools, allowlist, single-round loop, provider integration | ~12 KB | How follow-up queries (`"is he good?"`, `"shchhal kayseweh?"`) are handled |
| [**CLASSIFIER.md**](./CLASSIFIER.md) | Darija / Arabizi classifier: 5 input forms, 260+ keywords, Arabizi conventions, Pass-1 LLM fallback | ~13 KB | How Moroccan Darija (with Arabizi 3/7/9/8/5/6 conventions) gets parsed into trade × city |
| [**LLM-ROUTING.md**](./LLM-ROUTING.md) | Multi-provider routing: Gemini + Claude + HF Darija LoRA, signal-driven model selection, fallback chain, OpenAI-shape adapter | ~12 KB | How three LLM providers serve one chat through a unified interface |
| [**EVALUATION.md**](./EVALUATION.md) | `eval_logs` schema, 57 regression tests, 5-dimension rubric, external-model leaderboard | ~12 KB | How every published number is reproducible from one MongoDB query |
| [**MULTIMODAL.md**](./MULTIMODAL.md) | TF.js MobileNet (<250ms) for 95% of image queries + LLM vision fallback | ~10 KB | The two-tier image pipeline and notes on adapting it for audio |
| [**DARIJA-LORA.md**](./DARIJA-LORA.md) | Qwen2.5-1.5B + LoRA + 53k Darija training, HF Spaces deployment, production fallback integration | ~11 KB | The fine-tune-and-deploy story end-to-end |
| [**PRODUCTION-OPS.md**](./PRODUCTION-OPS.md) | Vercel topology, Mongo TTL strategy, SSE translation per provider, error degradation hierarchy, end-to-end query trace | ~14 KB | The operational reality, not just the architecture diagram |

Total: ~84 KB of technical writing. Every doc cites source lines back into [`server.js`](../server.js), [`lib/`](../lib/), and [`tests/`](../tests/).

## Reading paths

### Reviewing for a research lab role

1. [`../README.md`](../README.md) — what this repo is + the live demo links (2 min)
2. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — full system overview with diagrams, cost math, defensibility table (15 min)
3. [`AGENT.md`](./AGENT.md) — closest match if the lab works on AI agents (10 min)
4. [`EVALUATION.md`](./EVALUATION.md) — closest match if the lab works on LLM evaluation (10 min)
5. The "patterns for audio work" sections at the bottom of [`MULTIMODAL.md`](./MULTIMODAL.md), [`DARIJA-LORA.md`](./DARIJA-LORA.md), [`CLASSIFIER.md`](./CLASSIFIER.md) — which patterns transfer to multimodal audio work

### Debugging a production issue

Start with [`PRODUCTION-OPS.md`](./PRODUCTION-OPS.md) for the end-to-end query trace, then jump to the specific subsystem's doc for the relevant layer. Each doc lists its limitations.

### Forking or extending

Each doc ends with "What I'd build next" — concrete proposals, not aspirations. Pick the one matching your interest; the file map at the end of each doc shows where to start editing.

## Cross-references

Concepts that span docs:

| Concept | Primary doc | Also mentioned in |
|---|---|---|
| Allowlist philosophy | [AGENT.md](./AGENT.md) | [EVALUATION.md](./EVALUATION.md) (verifier) |
| OpenAI-shape adapter | [LLM-ROUTING.md](./LLM-ROUTING.md) | [AGENT.md](./AGENT.md) (tool calling) |
| `eval_logs` schema | [EVALUATION.md](./EVALUATION.md) | [AGENT.md](./AGENT.md), [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |
| Arabizi conventions (3/7/9/8/5/6) | [CLASSIFIER.md](./CLASSIFIER.md) | [DARIJA-LORA.md](./DARIJA-LORA.md) |
| HF Darija LoRA as fallback | [DARIJA-LORA.md](./DARIJA-LORA.md) | [LLM-ROUTING.md](./LLM-ROUTING.md) |
| `/api/ai/classify` debug endpoint | [CLASSIFIER.md](./CLASSIFIER.md) | [EVALUATION.md](./EVALUATION.md), [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |
| Browser TF.js MobileNet | [MULTIMODAL.md](./MULTIMODAL.md) | [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |
| Verifier (cited-ID validation) | [EVALUATION.md](./EVALUATION.md) | [AGENT.md](./AGENT.md), [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |

## Author

[Sami EL AKKAD](https://linkedin.com/in/samielakkad) — Tsinghua SIGS AI Master's, former Baidu ERNIE 4.5 Mentor, founder of jak.ma. Production deployment at [jak.ma](https://jak.ma).
