# Multimodal Stack

Code: [`public/js/local-classifier.js`](../public/js/local-classifier.js), [`server.js`](../server.js) — `/api/ai/vision`, [`lib/grounded-retrieval.js#classifyImage`](../lib/grounded-retrieval.js).

## The product use case

Users can't always describe their problem in words. They open the chat, photograph a broken sink or cracked wall, and expect the bot to figure out it's a plumbing issue. jak.ma accepts an optional image with every chat message.

The naive implementation — send every image to Claude Vision — is slow (1–2 second round-trip) and expensive (~$0.001 per image). That latency hurts the experience, especially on Moroccan 3G where the upload itself is already 200–500 ms.

The chosen implementation is a two-tier vision pipeline:

1. **Tier 1**: browser-side TF.js MobileNet classifies the image entirely in the user's browser. Result in under 250 ms. Confidence ≥ 0.7 → done, no server call.
2. **Tier 2**: when MobileNet's confidence falls below 0.7, the browser sends the image to `/api/ai/vision`, which calls Gemini Flash with a short prompt asking for one of 12 trade categories.

About 95% of image queries resolve in Tier 1. The remaining 5% take ~1.5 seconds via Tier 2 but cost almost nothing because they are rare.

## Tier 1: browser-side TF.js MobileNet

[`public/js/local-classifier.js`](../public/js/local-classifier.js) loads `@tensorflow/tfjs` plus `@tensorflow-models/mobilenet` from a CDN. The model is MobileNet v2 quantized — about 14 MB gzipped, loaded in under 2 seconds from a warm cache. After that, every classification runs locally.

```js
const model = await mobilenet.load({ version: 2, alpha: 1.0 });

async function classifyImage(imgEl) {
  const predictions = await model.classify(imgEl);
  // predictions: [{ className, probability }, ...] from generic ImageNet labels
  const tradeMapping = mapPredictionsToTrade(predictions);
  // → { trade: 'بلومبي', confidence: 0.87 } or null
  return tradeMapping;
}
```

Why MobileNet:
- 14 MB quantized fits in a PWA's first-paint budget
- Designed for mobile inference (low-end Android — the median jak.ma user)
- ImageNet classes give a 1000-class output space; a hand-curated mapping reduces those to 12 trades

The mapping layer is the key design choice. ImageNet has classes like `tabby cat` and `goldfish` that we ignore, but also `water faucet`, `washbasin`, `crane (machine)`, `screw`, `hammer` — these map cleanly to specific trades.

Confidence threshold: 0.7. Below that, the browser sends the image to the server for the Tier-2 LLM pass.

Latency: 80–250 ms warm, 2–3 seconds cold (first classification). Cold path is acceptable because the model loads in the background while the user is typing.

## Tier 2: server-side LLM vision

When Tier 1 returns confidence below 0.7, the browser POSTs the image to `/api/ai/vision`:

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

  const trade = imgData.choices[0].message.content.trim();
  return { trade, confidence: 0.8, source: 'gemini-vision' };
});
```

Three design notes:

1. One-word output forced via the prompt. We ask for a single Arabic category. `temperature: 0` + `maxTokens: 20` keeps it deterministic and cheap.
2. 5-second timeout. Image queries fail fast. The frontend falls back to a clarification message if vision times out.
3. The call goes through `callLLM`, not pinned to a provider. Default routes to Gemini Flash (cheap vision); the router can override if the multi-provider chain requires it.

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
  - regex match on "shchhal hadshi kayseweh" → no trade keyword
  - LLM Pass-1 with imageHint='بلومبي' in prompt → trade: بلومبي, confidence: 0.95
  ↓
retrieve(trade=بلومبي, city=طنجة) → 8 plumbers
  ↓
Pass-2 stream: "هاد الإصلاح كيتكلف..."
```

If text disagrees with image (`"بغيت طريسيان"` + image of broken faucet), text wins by design — the user has explicit intent. The `image_disagreement` field is logged to `eval_logs` for monitoring.

## The grounded-retrieval vision entry point

For agent-path follow-ups that include an image, [`lib/grounded-retrieval.js#classifyImage`](../lib/grounded-retrieval.js) runs as Pass 0.75 (between multi-trade detection and Pass-1 text classification):

```js
async function classifyImage(callXAI, imageDataUrl) {
  if (!imageDataUrl?.startsWith('data:image/')) return null;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 4000);

  const response = await callXAI(
    [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: imageDataUrl } },
      { type: 'text', text: 'قول ليا فقط: ما هي الفئة المناسبة من هذه القائمة: ...' },
    ]}],
    { model: 'gemini-3-flash', temperature: 0, maxTokens: 20, signal: ctrl.signal }
  );
}
```

Same logic as `/api/ai/vision`, called internally. The Pass-1 LLM prompt receives `imageHint` as additional context. Disagreements are logged.

## Limitations

The multimodal pipeline handles image input only:

- No audio. Users cannot send a voice message.
- No video. No video classification, no project tutorial videos.
- No multi-image. One image per request.
- No image generation. No "show me what your bathroom could look like."
- No image editing or annotation.
- No real-time camera streaming.

A true GPT-4o-like assistant needs streaming voice in/out, real-time bidirectional audio, and optional vision in the same stream. None of those are built here. jak.ma's multimodal capability is: image input → trade classification, text output.

## Patterns for audio work

The two-tier pattern (cheap pre-filter + expensive LLM fallback) is directly applicable to audio:

| This work (image) | Audio analog |
|---|---|
| Browser TF.js MobileNet for 95% of cases | Browser-side WebRTC VAD + small wake-word model for voice activation |
| LLM vision (Gemini/Claude) for the 5% long tail | LLM ASR (Whisper-large-v3, Moshi) for the long tail |
| `confidence ≥ 0.7` threshold to skip server call | Same threshold pattern: ASR confidence per utterance |
| One-word Arabic output forced via prompt | Equivalent: forced short structured output on ASR text |
| 5s timeout on vision LLM | Tighter for real-time voice (1–2s per phase) |
| Image disagreement logged to eval_logs | ASR n-best alternatives logged for retraining |
| Vision result becomes Pass-1 hint | ASR text becomes input to a downstream intent classifier |

What does not transfer: real-time streaming. The image pipeline is request-response. Audio requires streaming infrastructure — duplex SSE or WebSocket with audio chunks flowing continuously. That is separate work.

Concrete next steps if extending to audio:
1. WebRTC voice ingest in the browser, with VAD to detect speech end
2. Whisper-large-v3 deployed on HuggingFace Spaces as the ASR fallback (same pattern as the Darija LoRA today)
3. Streaming ASR via Deepgram or AssemblyAI for the real-time path
4. XTTS or ElevenLabs for output synthesis
5. Same multi-provider router pattern, with audio-specific signals (utterance length, SNR, language detected)

The router pattern, the eval_logs telemetry, the debug-endpoint pattern, and the cheap-pre-filter philosophy all transfer. The audio plumbing would be new code.

## File map

| File | Role |
|---|---|
| [`public/js/local-classifier.js`](../public/js/local-classifier.js) | Browser TF.js MobileNet, 12-trade mapping, 0.7 confidence threshold |
| [`server.js`](../server.js) `/api/ai/vision` | Server-side Gemini vision fallback (Tier 2) |
| [`lib/grounded-retrieval.js`](../lib/grounded-retrieval.js) `classifyImage` | Pass 0.75 vision-classification entry point used by `handleGroundedChat` |
| [`server.js`](../server.js) `_toAnthropicMessages` + `_toGeminiContents` | Translation: OpenAI `image_url` → Anthropic `image` block / Gemini `inlineData` |
