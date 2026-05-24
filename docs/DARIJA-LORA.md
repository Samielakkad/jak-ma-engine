# The Darija LoRA — Open-Source Fine-Tune Serving as Production Fallback

> Deep dive: `jakma-darija-A-adapter` — a Qwen2.5-1.5B LoRA fine-tuned on ~53k Darija conversational samples, hosted on HuggingFace Spaces, serving as the third tier of jak.ma's production fallback chain.
> Public model: https://huggingface.co/samielakkad1/jakma-darija-A-adapter
> Live Space: https://huggingface.co/spaces/samielakkad1/jakma-darija-chat
> Server integration: [`server.js`](../server.js) `callHF`.

---

## The role this LoRA plays in production

When **both** Gemini and Anthropic fail (rate limits, vendor outages, billing issues), jak.ma's router falls through to the Darija LoRA so the chatbot never returns 503. That's the entire point of having this model — sovereign safety net for a Moroccan product that can't afford to depend on the uptime of two American vendors.

In steady state, the LoRA is reached on **<0.5% of queries**. But that 0.5% is exactly the times when the user would otherwise get an error, and they're disproportionately important: an outage during the demo, a rate limit during a traffic spike, a billing issue mid-flight.

---

## Why a LoRA and not a full fine-tune

| approach | feasibility for this use case |
|---|---|
| Full fine-tune of a 7B model | ❌ Too expensive to train (~$500-2000 of GPU time), too heavy to host on free tier |
| **LoRA adapter on a 1.5B base** | ✅ Trains in hours on a single A100 (~$10-30), hostable on HF Spaces free tier |
| Prompt engineering only on commercial LLM | ✅ Cheap to iterate, ❌ vendor-locked, doesn't help when vendor is down |
| Few-shot prompting with retrieval | ✅ Often enough for many tasks, ❌ requires high-quality Darija exemplars at retrieval time |

LoRA on a small base hits the right Pareto point: cheap to train, cheap to host, owned end-to-end, good enough for the fallback role. Not trying to compete with Sonnet 4-5 on Darija quality — that's not the job. The job is "produce a coherent Darija response when the commercial providers are down."

---

## Base model choice: Qwen2.5-1.5B-Instruct

[Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) is the base. Why:

| consideration | reasoning |
|---|---|
| Size (1.5B) | Fits in HuggingFace Spaces free tier RAM (~16GB) with room for inference |
| Instruction-tuned baseline | We need a chat model, not a base completion model |
| Multilingual coverage | Qwen has reasonable Arabic + French + English baseline (better than Llama-3.1-1B on Arabic) |
| Apache 2.0 license | Commercial-friendly; the LoRA can ship as Apache 2.0 |
| Chat template (`<|im_start|>...<|im_end|>`) | Standard ChatML format; integrates with anything that speaks ChatML |
| Strong reasoning for size | Qwen 2.5 family punches above its weight on reasoning benchmarks |

What I rejected:
- **Llama-3.1-1B** — weaker Arabic baseline; would need more Darija data to compensate
- **Phi-3-mini (3.8B)** — too big for HF Spaces free tier
- **Mistral-Nemo (12B)** — way too big
- **Qwen2.5-0.5B** — too small; Darija fine-tune wouldn't stick

---

## The dataset (~53k samples)

53,325 Darija conversational pairs across:

- Worker-customer dialog templates (synthetic, but grounded in jak.ma's 12 trades + 15 cities)
- Moroccan colloquial expressions, idioms, code-switching examples
- Common chatbot Q&A patterns rewritten into Darija
- Multilingual mixes (Darija + French + English in single conversation turns)

**Sources** (cited where applicable):
- Atlasia Darija corpora (open)
- DODa (Dictionary of Darija) — sentences subset
- Synthetic templates generated from jak.ma's trade × city × phrase combinations
- A small hand-curated set of edge cases

**Data quality decisions**:
- Filtered out pairs shorter than 20 tokens or longer than 512 tokens
- Removed code-switched MSA-heavy pairs (which would dilute the Darija specialization)
- Deduplicated by exact-match + paraphrase clustering
- Train/val split 95/5 with stratification by trade category

Final training loss: **0.5612** (per model card). For context, that's better than a random base model on Darija, and the LoRA visibly produces more natural Darija outputs than the unmodified Qwen2.5-1.5B.

The 53k figure is real. The raw dataset is in `data/finetune/` in the private repo — kept private because some of the synthetic templates derive from real worker descriptions on jak.ma.

---

## Training setup

| parameter | value |
|---|---|
| Base | Qwen/Qwen2.5-1.5B-Instruct |
| Method | LoRA (PEFT library) |
| Target modules | `q_proj`, `k_proj`, `v_proj`, `o_proj` |
| LoRA rank (`r`) | 16 |
| LoRA alpha | 32 |
| LoRA dropout | 0.05 |
| Learning rate | 2e-4 (cosine schedule) |
| Batch size | 4 (with gradient accumulation steps = 4 → effective 16) |
| Epochs | 3 |
| Max sequence length | 1024 |
| Optimizer | AdamW (8-bit, paged) |
| Mixed precision | bf16 |
| Hardware | Single A100 80GB (rented for the training run) |

Training time: ~6 hours on the A100. Final adapter size: small (~10MB) — a LoRA on `q/k/v/o` projections at rank 16 doesn't add much footprint.

---

## HuggingFace deployment

Two artifacts deployed:

### 1. The model card: `samielakkad1/jakma-darija-A-adapter`

The LoRA weights + `adapter_config.json` + tokenizer files + `README.md` (model card with library tags `peft`, `lora`, language tags `ar` and `ary` — Moroccan Arabic ISO code). Anyone can:

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-1.5B-Instruct")
model = PeftModel.from_pretrained(base, "samielakkad1/jakma-darija-A-adapter")
tok = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-1.5B-Instruct")
# inference as usual
```

### 2. The Space: `samielakkad1/jakma-darija-chat`

A Gradio chat interface that exposes the model via Gradio's HTTP API. Anyone with the URL can:
- Chat with it in the browser (Gradio UI)
- Hit it via API for programmatic access

The Space's `/gradio_api/info` endpoint enumerates:
- `/generate` — primary endpoint, takes `message` (string), returns the model's response
- `/_examples_fn` — example helper

[`server.js#callHF`](../server.js) talks to the Space via the two-step Gradio 4.x HTTP protocol:

```js
async function callHF(messages, { signal }) {
  const userText = _extractLastUserText(messages);

  // Step 1: POST to start the job
  const postResp = await fetch(`${HF_SPACE_URL}/gradio_api/call/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${HF_TOKEN}` },
    body: JSON.stringify({ data: [userText] }),
  });
  const { event_id } = await postResp.json();

  // Step 2: GET the SSE stream until 'event: complete'
  const getResp = await fetch(`${HF_SPACE_URL}/gradio_api/call/generate/${event_id}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
    signal,
  });
  // Parse SSE, return last 'complete' event's text
}
```

Why HF Space and not direct model inference:
- Free hosting (HF Spaces free tier)
- Sleep-on-idle is fine for a fallback tier
- Anyone with the Space URL can use it (including the demo audience)
- Gradio gives the chat UI for free

Cold-start latency on free tier: 20-60 seconds. Configurable via `HF_FALLBACK_TIMEOUT_MS` env var (default 15s). When the Space is warm, inference is ~2-4s per response.

---

## Where the LoRA fits in the router

[`server.js#callLLM`](../server.js) builds a fallback chain:

```
primary intent (Gemini Flash | Claude Sonnet 4-5)
  ↓ fails
other commercial provider (Claude Haiku | Gemini Flash)
  ↓ fails
HF Darija LoRA  ← we are here
```

The LoRA tier is skipped when:
- `stream: true` (the Gradio API is fire-and-poll, not real streaming)
- `jsonMode: true` (a 1.5B model isn't reliable at JSON output)
- `tools` is present (no tool-calling training in the LoRA)

So it's the right tier for: plain chat completion when everything else has failed.

---

## What this LoRA is good at + bad at (honest)

**Good at**:
- Generating coherent Darija text (better than unmodified Qwen2.5-1.5B; better than MSA-heavy LLMs forced into Darija)
- Maintaining the jak.ma persona (`"جاك ذكي"`) in single-turn responses
- Following short instructions in Darija
- Code-switching (Darija + French + English) gracefully
- Common idioms and greetings

**Bad at**:
- Multi-turn conversations with long context (no instruct-tuning for tool use, no system prompt training)
- JSON output (not trained for structured output)
- Tool calling (no tool-use training)
- Long-form generation (>200 tokens) — quality degrades
- Strict factual grounding (it'll happily make up details if not constrained — that's why it's only used as a chat fallback, never as the primary classifier)
- Vision (no multimodal capability)
- Real-time streaming (Gradio fire-and-poll)

A larger / more recent model would be better. The point isn't to compete on quality — it's to **exist as a sovereign safety net**.

---

## What it cost

| item | cost |
|---|---|
| GPU training time (A100 80GB × 6 hours) | ~$15 |
| Dataset assembly | personal time, no monetary cost (open sources + synthetic) |
| HF Spaces hosting | $0 (free tier) |
| HF model storage | $0 (free tier for public models) |
| Inference cost per request | ~$0 (HF free tier) |
| Total | **<$20 of cash + a weekend of work** |

For that, jak.ma has:
- An open-source contribution to the Darija NLP community
- A sovereign fallback tier in its router
- A model card that doubles as portfolio evidence ("yes, I fine-tuned and deployed a real model")

---

## What I'd build next (audio analog — honest extension)

If extending this LoRA work to audio for the mentor's lab:

### Option 1: Darija ASR LoRA

| task | concrete plan |
|---|---|
| Base | Whisper-large-v3 (or Whisper-medium for free-tier hosting) |
| Method | LoRA on encoder + cross-attention layers |
| Dataset | Public: MGB-2 Arabic + Mozilla Common Voice ar | curate ~50-100h Darija audio |
| Goal | ASR for Darija + Arabic dialects beats baseline Whisper by ~3-5 WER points |
| Hosting | Same pattern as today: HF Spaces, exposed via Gradio API |
| Cost | ~$50-100 of GPU time |
| Defensible claim | "Open-source Darija ASR LoRA serving production as fallback ASR tier" |

### Option 2: Darija TTS LoRA

| task | concrete plan |
|---|---|
| Base | XTTS-v2 or VITS for Arabic |
| Method | LoRA on speaker conditioning + decoder layers |
| Dataset | Darija audiobook narration + curated 10-20h Moroccan speech |
| Goal | Synthesize Darija with Moroccan accent (most multilingual TTS produces MSA-accented Arabic) |
| Hosting | Same pattern |
| Cost | ~$100-200 of GPU time |
| Defensible claim | "First open-source TTS LoRA targeting Moroccan accent" |

### Option 3: GPT-4o-like multimodal audio LLM (much harder)

Out of scope for a single weekend. Would require:
- A multimodal base (e.g. Qwen2-Audio or LLaVA-NeXT-Audio)
- Curated audio-instruction tuning data (~10k hours minimum)
- Significant GPU spend (~$5k-20k)
- Real-time streaming infrastructure

Not feasible solo. Mentor's lab is the right place for this kind of work.

---

## What this proves (and what it doesn't)

**What I can honestly claim**:
- I can fine-tune a small open-source model end-to-end (dataset → training → deployment)
- I can integrate that fine-tune into a production fallback chain
- The model is real, publicly accessible, and serves production traffic
- The training methodology (LoRA on Qwen, 53k samples, 0.5612 final loss) is real and reproducible

**What this does NOT prove**:
- I'm an audio researcher (I'm not — this is text)
- I've published papers on this (I haven't — it's an engineering contribution, not a paper)
- The model is state-of-the-art on Darija (it isn't — it's a serviceable fallback)
- The dataset is world-class (it's solid but limited to ~53k samples, much smaller than the gold standard)

If the mentor asks "have you trained models before?", the honest answer is: "Yes, this LoRA. End-to-end from dataset to deployment to production integration. Small model, not novel research, but real and serving traffic. The pattern transfers cleanly to audio if you want me to do the same thing for Darija ASR."

---

## File map

| File | Role |
|---|---|
| [HF model card](https://huggingface.co/samielakkad1/jakma-darija-A-adapter) | LoRA weights, config, README |
| [HF Space](https://huggingface.co/spaces/samielakkad1/jakma-darija-chat) | Live demo + Gradio API |
| [`server.js`](../server.js) `callHF` | Production integration as fallback tier |
| [`server.js`](../server.js) `/api/ai/darija` | Direct Darija LoRA endpoint (bypasses the router) |
| [`public/darija.html`](../public/darija.html) | Frontend page embedding the HF Space iframe |
