# The Darija LoRA

Open-source fine-tune of Qwen2.5-1.5B on ~53k Moroccan Darija samples, deployed on HuggingFace Spaces, serving as the third tier of jak.ma's production fallback chain.

- Model card: https://huggingface.co/samielakkad1/jakma-darija-A-adapter
- Live Space: https://huggingface.co/spaces/samielakkad1/jakma-darija-chat
- Server integration: [`server.js`](../server.js) — `callHF`

## Role in production

When both Gemini and Anthropic fail (rate limits, vendor outages, billing issues), the router falls through to this LoRA so the chatbot never returns 503. That is the model's entire purpose: a sovereign safety net for a Moroccan product that cannot afford to depend on two American vendors' uptime.

In steady state, the LoRA is reached on less than 0.5% of queries. But that 0.5% is the times a user would otherwise get an error, and those events tend to cluster (an outage during a demo, a rate limit during a traffic spike, a billing issue mid-flight). Coverage matters more than mean quality for this tier.

## Why a LoRA and not a full fine-tune

| Approach | Feasibility |
|---|---|
| Full fine-tune of a 7B+ model | Too expensive to train (~$500–2000 of GPU time), too heavy to host on free tier |
| **LoRA adapter on a 1.5B base** | Trains in hours on a single A100 (~$10–30), hostable on HF Spaces free tier |
| Prompt engineering only | Cheap to iterate; vendor-locked; useless when the vendor is down |
| Few-shot prompting with retrieval | Often enough for many tasks; requires high-quality Darija exemplars at retrieval time |

LoRA on a small base hits the right Pareto point: cheap to train, cheap to host, owned end-to-end, sufficient for the fallback role. Not designed to compete with Sonnet 4-5 on Darija quality — the job is "produce a coherent Darija response when commercial providers are down."

## Base model: Qwen2.5-1.5B-Instruct

[Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct). Reasoning:

| Consideration | Reasoning |
|---|---|
| Size | 1.5B fits in HF Spaces free-tier RAM (~16 GB) with room for inference |
| Instruction-tuned baseline | Chat model, not a base completion model |
| Multilingual coverage | Better Arabic + French + English baseline than Llama-3.1-1B on Arabic |
| License | Apache 2.0 — commercial-friendly |
| Chat template | ChatML format (`<|im_start|>...<|im_end|>`) — standard |
| Reasoning per parameter | Qwen 2.5 family punches above its weight |

Rejected:
- **Llama-3.1-1B** — weaker Arabic baseline; would need more Darija data to compensate
- **Phi-3-mini (3.8B)** — too big for HF Spaces free tier
- **Mistral-Nemo (12B)** — much too big
- **Qwen2.5-0.5B** — too small; the Darija fine-tune would not stick

## Dataset: ~53k samples

53,325 Darija conversational pairs across:

- Worker-customer dialog templates (synthetic, grounded in jak.ma's 12 trades + 15 cities)
- Moroccan colloquial expressions, idioms, code-switching examples
- Common chatbot Q&A patterns rewritten into Darija
- Multilingual mixes (Darija + French + English within single turns)

Sources:
- Atlasia Darija corpora (open)
- DODa (Dictionary of Darija) — sentences subset
- Synthetic templates generated from jak.ma's trade × city × phrase combinations
- A small hand-curated set of edge cases

Data quality choices:
- Filter out pairs shorter than 20 tokens or longer than 512 tokens
- Remove code-switched MSA-heavy pairs (which would dilute the Darija specialization)
- Deduplicate by exact-match plus paraphrase clustering
- Train/val split 95/5, stratified by trade category

Final training loss: 0.5612 (per model card). Acceptable for a small specialist on Darija.

The raw dataset lives in `data/finetune/` in the private repo — kept private because some synthetic templates derive from real worker descriptions on jak.ma.

## Training setup

| Parameter | Value |
|---|---|
| Base | Qwen/Qwen2.5-1.5B-Instruct |
| Method | LoRA (PEFT library) |
| Target modules | `q_proj`, `k_proj`, `v_proj`, `o_proj` |
| LoRA rank (`r`) | 16 |
| LoRA alpha | 32 |
| LoRA dropout | 0.05 |
| Learning rate | 2e-4 (cosine schedule) |
| Batch size | 4 (gradient accumulation 4 → effective 16) |
| Epochs | 3 |
| Max sequence length | 1024 |
| Optimizer | AdamW (8-bit, paged) |
| Mixed precision | bf16 |
| Hardware | Single A100 80GB (rented for the run) |

Training time: ~6 hours on the A100. Final adapter size: ~10 MB. A LoRA on `q/k/v/o` projections at rank 16 adds little footprint.

## HuggingFace deployment

Two artifacts:

### Model card: `samielakkad1/jakma-darija-A-adapter`

LoRA weights + `adapter_config.json` + tokenizer files + `README.md` (model card with `peft`, `lora` library tags and `ar`, `ary` (Moroccan Arabic) language tags). Anyone can use it:

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-1.5B-Instruct")
model = PeftModel.from_pretrained(base, "samielakkad1/jakma-darija-A-adapter")
tok = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-1.5B-Instruct")
# inference as usual
```

### Space: `samielakkad1/jakma-darija-chat`

A Gradio chat interface exposing the model via Gradio's HTTP API. Anyone can:
- Chat in the browser (Gradio UI)
- Hit it programmatically via the Gradio API

The Space's `/gradio_api/info` enumerates:
- `/generate` — primary endpoint, takes `message` (string), returns the model's response
- `/_examples_fn` — example helper

[`server.js#callHF`](../server.js) talks to the Space via Gradio 4.x's two-step HTTP protocol:

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

Why HF Space rather than direct model inference:
- Free hosting (HF Spaces free tier)
- Sleep-on-idle is fine for a fallback tier
- The Space URL is shareable for demos
- Gradio provides the UI for free

Cold-start latency on the free tier: 20–60 seconds. Configurable via `HF_FALLBACK_TIMEOUT_MS` env var (default 15s). When warm, inference is 2–4 seconds per response.

## Position in the router

[`server.js#callLLM`](../server.js) builds a fallback chain:

```
primary intent (Gemini Flash | Claude Sonnet 4-5)
  ↓ fails
other commercial provider (Claude Haiku | Gemini Flash)
  ↓ fails
HF Darija LoRA  ← here
```

The LoRA tier is skipped when:
- `stream: true` (the Gradio API is fire-and-poll, not real streaming)
- `jsonMode: true` (a 1.5B model is not reliable at JSON output)
- `tools` is present (no tool-calling training)

It serves the right tier: plain chat completion when everything else has failed.

## Capabilities

Good at:
- Coherent Darija text (better than unmodified Qwen2.5-1.5B; better than MSA-heavy LLMs forced into Darija)
- The jak.ma persona (`جاك ذكي`) in single-turn responses
- Short instructions in Darija
- Code-switching (Darija + French + English)
- Common idioms and greetings

Limitations:
- Multi-turn conversations with long context (no instruct-tuning for tool use, no system prompt training)
- JSON output (not trained for structured output)
- Tool calling (no tool-use training)
- Long-form generation (>200 tokens) — quality degrades
- Strict factual grounding (it will make up details if not constrained — that is why it is only used as a chat fallback, never as the primary classifier)
- Vision (no multimodal capability)
- Real-time streaming (Gradio fire-and-poll)

A larger or more recent model would be better. The goal is not quality leadership; it is sovereign coverage.

## Cost

| Item | Cost |
|---|---|
| GPU training (A100 80GB × 6 hours) | ~$15 |
| Dataset assembly | personal time (open sources + synthetic) |
| HF Spaces hosting | $0 (free tier) |
| HF model storage | $0 (free tier for public models) |
| Inference cost per request | ~$0 (HF free tier) |
| **Total** | **<$20 cash + a weekend** |

For that, jak.ma has:
- An open-source contribution to the Darija NLP community
- A sovereign fallback tier in its router
- A model card that serves as portfolio evidence (a real fine-tune, deployed, in production)

## Audio analog

If extending this LoRA work to audio:

### Option 1: Darija ASR LoRA

| Task | Plan |
|---|---|
| Base | Whisper-large-v3 (or Whisper-medium for free-tier hosting) |
| Method | LoRA on encoder + cross-attention layers |
| Dataset | Public: MGB-2 Arabic + Mozilla Common Voice ar; curate ~50–100h Darija audio |
| Goal | ASR for Darija and Arabic dialects, beating baseline Whisper by ~3–5 WER points |
| Hosting | HF Spaces, exposed via Gradio API (same pattern as today) |
| Cost | ~$50–100 of GPU time |

### Option 2: Darija TTS LoRA

| Task | Plan |
|---|---|
| Base | XTTS-v2 or VITS for Arabic |
| Method | LoRA on speaker conditioning + decoder layers |
| Dataset | Darija audiobook narration + curated 10–20h Moroccan speech |
| Goal | Synthesize Darija with Moroccan accent (multilingual TTS typically produces MSA-accented Arabic) |
| Hosting | Same pattern |
| Cost | ~$100–200 of GPU time |

### Option 3: GPT-4o-like multimodal audio LLM

Out of scope for one person on a weekend budget. Would need:
- A multimodal base (e.g., Qwen2-Audio or LLaVA-NeXT-Audio)
- Curated audio-instruction tuning data (~10k hours minimum)
- Significant GPU spend (~$5k–20k)
- Real-time streaming infrastructure

Not feasible solo. This is what a research lab is for.

## What this work shows

This LoRA demonstrates end-to-end ownership: dataset assembly → training → deployment → production integration. Small model, no novel research contribution, but real and serving traffic. The same pattern applies cleanly to audio (Whisper-Darija, XTTS-Darija) without rebuilding the deployment infrastructure.

## File map

| File | Role |
|---|---|
| [HF model card](https://huggingface.co/samielakkad1/jakma-darija-A-adapter) | LoRA weights, config, README |
| [HF Space](https://huggingface.co/spaces/samielakkad1/jakma-darija-chat) | Live demo + Gradio API |
| [`server.js`](../server.js) `callHF` | Production integration as fallback tier |
| [`server.js`](../server.js) `/api/ai/darija` | Direct Darija LoRA endpoint (bypasses the router) |
| [`public/darija.html`](../public/darija.html) | Frontend page embedding the HF Space iframe |
