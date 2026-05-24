# `docs/` — Deep-Dive Engineering Documentation

This directory contains technical deep-dives for each major subsystem of jak.ma. Each doc is self-contained, source-cited (with file:line references back into the repo), and **honest about both what's built and what's not**.

For the architectural overview, start with [`../ARCHITECTURE.md`](../ARCHITECTURE.md). For a specific subsystem, jump straight to its dive below.

---

## Table of contents

| Doc | Subject | Length | Best for |
|---|---|---|---|
| [**AGENT.md**](./AGENT.md) | The tool-calling agent: 3 tools, allow-list, single-round loop, provider integration | ~12 KB | Understanding how follow-up queries (`"is he good?"`, `"shchhal kayseweh?"`) are handled |
| [**CLASSIFIER.md**](./CLASSIFIER.md) | The Darija/Arabizi classifier: 5 input forms, 260+ keywords, Arabizi conventions, Pass-1 LLM fallback | ~13 KB | Understanding how Moroccan Darija (with Arabizi 3/7/9/8/5/6 conventions) gets parsed into trade × city |
| [**LLM-ROUTING.md**](./LLM-ROUTING.md) | Multi-provider routing: Gemini + Claude + HF Darija LoRA, signal-driven model selection, fallback chain, OpenAI-shape adapter | ~12 KB | Understanding how 3 LLM providers serve one chat through a unified interface |
| [**EVALUATION.md**](./EVALUATION.md) | Eval methodology: eval_logs schema, 57 regression tests, 5-dim rubric, the leaderboard for external models | ~12 KB | Understanding how every CV number is reproducible from a single MongoDB query |
| [**MULTIMODAL.md**](./MULTIMODAL.md) | Multimodal handling: browser-side TF.js MobileNet (<250ms) for 95% of image queries, LLM vision fallback for the long tail | ~10 KB | Understanding the two-tier image pipeline (and the honest bridge to audio work) |
| [**DARIJA-LORA.md**](./DARIJA-LORA.md) | The open-source LoRA: Qwen2.5-1.5B fine-tuned on 53k Darija samples, training methodology, HF Spaces deployment, production fallback integration | ~11 KB | Understanding the fine-tune-and-deploy story end-to-end (and what an audio analog would look like) |
| [**PRODUCTION-OPS.md**](./PRODUCTION-OPS.md) | How it actually runs: Vercel cold-starts, MongoDB schemas, SSE streaming, error handling, observability, privacy decisions, a step-by-step trace of one query | ~14 KB | Understanding the operational reality (not just the architecture diagram) |

Total: ~84 KB of dense engineering documentation. Every file cites source lines back into [`server.js`](../server.js), [`lib/`](../lib/), [`tests/`](../tests/).

---

## How to use this

### If you're reviewing this for a research lab role

Read in this order:
1. [`../README.md`](../README.md) — what this repo is + the live demo links (2 min)
2. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — the full system overview with diagrams + cost math + defensibility table (15 min)
3. [`AGENT.md`](./AGENT.md) — agentic AI (closest match if the lab works on AI agents) (10 min)
4. [`EVALUATION.md`](./EVALUATION.md) — eval methodology (closest match if the lab works on LLM evaluation) (10 min)
5. The honest "transfer to audio" sections at the bottom of [`MULTIMODAL.md`](./MULTIMODAL.md), [`DARIJA-LORA.md`](./DARIJA-LORA.md), [`CLASSIFIER.md`](./CLASSIFIER.md) — direct discussion of which patterns transfer to multimodal audio work and which don't

### If you're debugging a production issue

Start with [`PRODUCTION-OPS.md`](./PRODUCTION-OPS.md) for the end-to-end query trace, then jump to the specific subsystem's doc for the layer where the issue is. Every doc has a "what's NOT built" section enumerating known limits.

### If you want to fork / extend this work

Each doc has a "What I'd build next" section with concrete proposals — not vague "could be improved." Pick the one that matches your interest and the file map at the end tells you exactly where to start editing.

---

## Cross-references

Many concepts span multiple docs. Common ones:

| Concept | Primary doc | Also mentioned in |
|---|---|---|
| Allow-list philosophy | [AGENT.md](./AGENT.md) | [EVALUATION.md](./EVALUATION.md) (verifier) |
| OpenAI-shape adapter | [LLM-ROUTING.md](./LLM-ROUTING.md) | [AGENT.md](./AGENT.md) (tool calling translation) |
| `eval_logs` schema | [EVALUATION.md](./EVALUATION.md) | [AGENT.md](./AGENT.md), [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |
| Arabizi conventions (3/7/9/8/5/6) | [CLASSIFIER.md](./CLASSIFIER.md) | [DARIJA-LORA.md](./DARIJA-LORA.md) (training data covers these) |
| HF Darija LoRA as fallback | [DARIJA-LORA.md](./DARIJA-LORA.md) | [LLM-ROUTING.md](./LLM-ROUTING.md) (router tier 3) |
| `/api/ai/classify` debug endpoint | [CLASSIFIER.md](./CLASSIFIER.md) | [EVALUATION.md](./EVALUATION.md), [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |
| Browser-side TF.js MobileNet | [MULTIMODAL.md](./MULTIMODAL.md) | [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) (95% of image queries) |
| Verifier (cited-ID validation) | [EVALUATION.md](./EVALUATION.md) | [AGENT.md](./AGENT.md), [PRODUCTION-OPS.md](./PRODUCTION-OPS.md) |

---

## Honesty notes

These docs intentionally include:

- **"What this is NOT" sections** for every subsystem — honest scope statements so claims don't drift in interviews
- **"What's NOT built" sections** — known limits, not aspirational features
- **"Where this transfers to audio work" sections** with explicit "what doesn't transfer" — direct discussion of which patterns are general engineering and which are specific to text. Aimed at audio-research labs but no manufactured audio claims.
- **Cited file paths and line numbers** so every statement is verifiable in the source

If you spot a claim that isn't backed by code in this repo, file an issue — that's a bug in the docs, not in the code.

---

## Author

[Sami EL AKKAD](https://linkedin.com/in/samielakkad) — Tsinghua SIGS AI Master's · ex Baidu ERNIE Mentor (4.5) · founder of jak.ma.

These docs are the engineering write-up of the work shipped from 2026-05-23 onwards. The production deployment is at [jak.ma](https://jak.ma); the chat is live; everything cited here is reproducible.
