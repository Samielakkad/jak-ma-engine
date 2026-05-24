# Multimodal Stack

> Deep dive: how jak.ma handles image input — browser-side TF.js MobileNet for 95% of cases, Claude/Gemini vision for the long tail. Plus an honest section on what this DOESN'T cover (audio) and which patterns transfer.
> Code: [`public/js/local-classifier.js`](../public/js/local-classifier.js), [`server.js`](../server.js) `/api/ai/vision`, [`lib/grounded-retrieval.js#classifyImage`](../lib/grounded-retrieval.js).

---

## The product use case

A user can't always describe their problem in words. They open the chat, snap a photo of their broken sink / cracked wall / leaking pipe, and expect the bot to figure out it's a plumbing issue. So jak.ma accepts an optional image with every chat message.

The naïve implementation — "send the image to Claude Vision every time" — is slow (1-2 second round-trip) and expensive (~$0.001 per image). That latency kills the UX, especially on Moroccan 3G where the upload itself is already 200-500ms.

The non-naïve implementation: a **two-tier vision pipeline**:

1. **Tier 1** — Browser-side TF.js MobileNet runs the classification entirely in the user's browser. Result in <250ms. Confidence ≥ 0.7 → done, no server call.
2. **Tier 2** — Only when MobileNet's confidence < 0.7, the browser sends the image to `/api/ai/vision`, which calls Gemini Flash with the image + a short prompt asking for one of 12 trade categories.

95% of image queries resolve in Tier 1. The 5% that fall through to Tier 2 take ~1.5s but cost almost nothing because they're rare.

---

## Tier 1: Browser-side TF.js MobileNet

[`public/js/local-classifier.js`](../public/js/local-classifier.js) loads `@tensorflow/tfjs` + `@tensorflow-models/mobilenet` from a CDN. The model is `MobileNet v2` quantized — ~14MB gzipped, loads in <2s on a warm cache. After that, every classification is local.

```js
// Roughly what the local classifier does:
const model = await mobilenet.load({ version: 2, alpha: 1.0 });

async function classifyImage(imgEl) {
  const predictions = await model.classify(imgEl);
  // predictions: [{ className, probability }, ...] — generic ImageNet labels
  // ↓ Custom mapping layer
  const tradeMapping = mapPredictionsToTrade(predictions);
  // → { trade: 'بلومبي', confidence: 0.87 } or null
  return tradeMapping;
}
```

Why MobileNet specifically:
- 14MB quantized fits in a PWA's first-paint budget
- Designed for mobile inference (low-end Android, the median jak.ma user)
- ImageNet classes give us a 1000-class output space; we map those to the 12 trades via a hand-curated rules table

The mapping layer is the trick. ImageNet has classes like `tabby cat` and `goldfish` we don't care about, but also `water faucet`, `washbasin`, `crane (machine)`, `screw`, `hammer` — these map cleanly to specific trades. The mapping is in [`public/js/local-classifier.js`](../public/js/local-classifier.js).

**Confidence threshold = 0.7**. Below that, MobileNet is unsure and the browser sends the image to the server for the Tier-2 LLM vision pass.

**Latency**: 80-250ms warm (model already loaded), 2-3s cold (first classification). Cold path is fine — the model loads in the background while the user is typing their message.

---

## Tier 2: Server-side LLM vision

When Tier 1 returns confidence < 0.7, the browser POSTs the image to `/api/ai/vision` (in [`server.js`](../server.js)):

```js
app.post('/api/ai/vision', aiLimiter, async (req, res) => {
  const { image } = req.body;  // base64 data URL
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);

  const imgResp = await callLLM(
    [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: image } },
      { type: 'text', text: 'قول ليا فقط: ما هي الفئة المناسبة من هذه القائمة: ' +
                            'طريسيان، بلومبي، ... — جاوب بكلمة واحدة فقط' },
    ]}],
    { model: GEMINI_MODEL_VISION, temperature: 0, maxTokens: 20, signal: ctrl.signal }
  );

  // Parse one-word Arabic response, validate against VALID_CATS
  const trade = imgData.choices[0].message.content.trim();
  return { trade, confidence: 0.8, source: 'gemini-vision' };
});
```

Three things worth pointing at:

1. **One-word output forced via prompt** — we ask for a single Arabic category name. `temperature: 0` + `maxTokens: 20` makes it deterministic and cheap.
2. **5-second timeout** — image queries should fail fast. The frontend falls back to a clarification message if vision times out.
3. **`callLLM` routes the request** — not pinned to a provider. By default goes to Gemini Flash (cheap vision); router can override if the multi-provider chain requires it.

---

## Vision as a Pass-1 input hint

When the chat handler receives an image with a query, the vision classification result becomes an `imageHint` that feeds the Pass-1 classifier ([`lib/grounded-retrieval.js#classifyAndExtract`](../lib/grounded-retrieval.js)).

```
User uploads image + types "shchhal hadshi kayseweh?"
  ↓
Browser MobileNet classifies → { trade: 'بلومبي', confidence: 0.87 }
  ↓ (skip server vision, confidence ≥ 0.7)
Chat request: { messages, image, imageHint: 'بلومبي' }
  ↓
classifyAndExtract(query, context, imageHint):
  - regex match query → no trade keyword in "shchhal hadshi kayseweh"
  - LLM Pass-1 with imageHint='بلومبي' in the prompt → trade: بلومبي, confidence: 0.95
  ↓
retrieve(trade=بلومبي, city=طنجة) → 8 plumbers
  ↓
Pass-2 stream: "هاد الإصلاح كيتكلف..."
```

If text disagrees with image (`"بغيت طريسيان"` + image of broken faucet), **text wins** by design — the user has explicit intent. The `image_disagreement` field is logged to `eval_logs` for monitoring.

---

## The grounded-retrieval vision entry point

For agent-path follow-ups that include an image, [`lib/grounded-retrieval.js#classifyImage`](../lib/grounded-retrieval.js) runs as Pass 0.75 (between multi-trade detection and Pass-1 text classification). Its result becomes the `imageHint` for Pass 1.

```js
async function classifyImage(callXAI, imageDataUrl) {
  if (!imageDataUrl?.startsWith('data:image/')) return null;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 4000);  // VISION_BUDGET_MS

  const response = await callXAI(
    [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageDataUrl } },
      { type: 'text', text: 'قول ليا فقط: ما هي الفئة المناسبة من هذه القائمة: ...' },
    ]}],
    { model: 'gemini-3-flash', temperature: 0, maxTokens: 20, signal: ctrl.signal }
  );
  // Returns: { trade: 'بلومبي' } | null
}
```

Same logic as `/api/ai/vision` but called internally. The Pass-1 LLM prompt is given `imageHint` as additional context. If the LLM and the image disagree, the system logs `image_disagreement` to `eval_logs`.

---

## What jak.ma does NOT do (multimodal limits — honest)

- **No audio.** Users can't send a voice message. The chat is text + image only.
- **No video.** No video → trade classification, no project tutorial videos, nothing.
- **No multi-image.** Single image per request. Tier 2 LLM call sends one image only.
- **No image generation.** We don't synthesize images for users (no "show me what your bathroom could look like").
- **No image editing / annotation.** Users can't draw on the image to highlight the problem area.
- **No real-time camera streaming.** Stop-frame upload only — no WebRTC, no live video feed to the model.

This matters for the mentor's interest in **multimodal audio interaction** (GPT-4o-like architectures): jak.ma's multimodal handling is one-way (input → trade classification), text-only output. A true GPT-4o-like assistant needs:
- Streaming voice input
- Streaming voice output with prosody control
- Real-time bidirectional audio
- Optional vision (which jak.ma has, but not in real-time stream)

None of those are built in jak.ma. Treating jak.ma as "GPT-4o-like multimodal experience" would be dishonest. What I can honestly claim:
- Vision input handling (browser-side classifier + server-side LLM fallback)
- Two-tier pipeline that respects latency budgets
- Image-to-text classification with provider-agnostic routing

---

## Where this transfers to audio work (the honest bridge)

The two-tier pattern (cheap pre-filter + expensive LLM fallback) is **directly applicable** to audio:

| this work (image) | audio analog |
|---|---|
| Browser-side TF.js MobileNet for 95% of cases | Browser-side WebRTC VAD + small wake-word model for 95% of voice activation |
| LLM vision (Gemini/Claude) for the 5% long tail | LLM ASR (Whisper-large-v3 / Moshi) for the long tail |
| `confidence ≥ 0.7` threshold to skip server call | Same threshold pattern: ASR confidence per utterance |
| One-word Arabic output forced via prompt | Equivalent: forced short structured output for intent classification on ASR text |
| 5s timeout on vision LLM | Critical for real-time voice — even tighter (1-2s per phase) |
| Image disagreement logged to eval_logs | Equivalent: ASR n-best alternatives logged for retraining |
| Vision result becomes Pass-1 hint to text classifier | Same: ASR text becomes input to a downstream intent classifier |

**What's NOT transferable**: real-time streaming. The image pipeline is request-response. Audio requires streaming infrastructure — duplex SSE or WebSocket with audio chunks flowing continuously. That's net-new work.

**What I'd build first** if extending this to audio:
1. WebRTC voice ingest in the browser, with VAD to detect speech end
2. Whisper-large-v3 deployed on HuggingFace Spaces as the ASR fallback (same pattern as the Darija LoRA today)
3. Streaming ASR via Deepgram or AssemblyAI for the real-time path
4. XTTS or ElevenLabs for output synthesis
5. Same multi-provider router pattern, but with audio-specific signals (utterance length, SNR, language detected)

The router pattern, the eval_logs telemetry, the debug endpoint pattern, the cheap-pre-filter philosophy — all of those transfer. The audio plumbing itself would be new code.

---

## File map

| File | Role |
|---|---|
| [`public/js/local-classifier.js`](../public/js/local-classifier.js) | Browser-side TF.js MobileNet, 12-trade label mapping, 0.7 confidence threshold |
| [`server.js`](../server.js) `/api/ai/vision` | Server-side Gemini vision fallback (Tier 2) |
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) `classifyImage` | Pass 0.75 vision-classification entry point used by `handleGroundedChat` |
| [`server.js`](../server.js) `_toAnthropicMessages` + `_toGeminiContents` | Translation: OpenAI `image_url` block → Anthropic `image` block / Gemini `inlineData` |
