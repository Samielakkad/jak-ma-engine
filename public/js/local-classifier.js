/**
 * local-classifier.js — browser-side trade classifier for jak.ma.
 *
 * STATUS: STUB (model not yet trained).
 *
 * The production design loads a fine-tuned MobileNetV3-Small head over a
 * 12-class softmax matching the jak.ma trade categories. Once trained
 * (see scripts/train_classifier.py and docs/multimodal-runbook.md) and
 * dropped at /models/trade-classifier-tfjs/model.json, this module returns
 * sub-250ms predictions on mid-tier Android handsets — no network roundtrip.
 *
 * Until the model exists, every prediction returns confidence: 0 so the
 * server-side /api/ai/vision fallback (Grok-2-Vision) always fires. This
 * keeps the UX correct end-to-end during the scaffolding phase.
 *
 * INTEGRATION
 * ───────────
 * Loaded on demand from public/index.html via:
 *   <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js" defer></script>
 *   <script src="/js/local-classifier.js" defer></script>
 *
 * Exposes:
 *   window.jakmaClassifyImage(imgEl) → Promise<{
 *     top: {trade, prob},
 *     top3: [{trade, prob}, ...],
 *     confidence: number,
 *     elapsed_ms: number,
 *     fallback_to_grok: boolean,
 *     stub: boolean,
 *   }>
 *
 * SWITCHING FROM STUB TO ACTIVE
 * ─────────────────────────────
 * 1. Train and export the model (scripts/train_classifier.py).
 * 2. Place model.json + shards under public/models/trade-classifier-tfjs/.
 * 3. Edit STUB_MODE below to `false`.
 * 4. Deploy. The first user to open the image picker triggers a one-time
 *    ~1MB model download; subsequent classifications are local + sub-250ms.
 */

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────────────
  // Set STUB_MODE to false once a real model is deployed at /models/trade-classifier-tfjs/
  const STUB_MODE = true;

  const MODEL_URL = '/models/trade-classifier-tfjs/model.json';
  const CONFIDENCE_THRESHOLD = 0.7;  // below this → fall back to Grok-Vision
  const INPUT_SIZE = 224;            // MobileNet input

  // Trade labels — order MUST match the trained model's softmax order.
  // Keep in sync with scripts/train_classifier.py.
  const TRADES = [
    'بلومبي', 'طريسيان', 'صباغة', 'نجارة',
    'بناء', 'نقاوة', 'حدادة', 'ديكور',
    'نقل', 'كلامبيستري', 'خياطة', 'حراسة',
  ];

  // ── MODEL LOADER (lazy, idempotent) ─────────────────────────────────────
  let modelPromise = null;

  async function loadModel() {
    if (STUB_MODE) return null;
    if (!modelPromise) {
      if (typeof tf === 'undefined') {
        console.warn('[local-classifier] tf.js not loaded; falling back to Grok-Vision');
        return null;
      }
      modelPromise = tf.loadLayersModel(MODEL_URL).catch(err => {
        console.error('[local-classifier] model load failed:', err);
        modelPromise = null;
        return null;
      });
    }
    return modelPromise;
  }

  // ── MAIN ENTRY ──────────────────────────────────────────────────────────
  async function classifyImage(imageElement) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // STUB: return zero-confidence prediction so caller falls back to Grok
    if (STUB_MODE) {
      return {
        top: { trade: null, prob: 0 },
        top3: [],
        confidence: 0,
        elapsed_ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
        fallback_to_grok: true,
        stub: true,
      };
    }

    // ACTIVE path (used once a model is trained + deployed)
    const model = await loadModel();
    if (!model) {
      return {
        top: { trade: null, prob: 0 },
        top3: [],
        confidence: 0,
        elapsed_ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
        fallback_to_grok: true,
        stub: false,
        error: 'model_unavailable',
      };
    }

    // Preprocess: 224×224, normalize to [-1, 1] (MobileNet convention)
    const tensor = tf.tidy(() => {
      let t = tf.browser.fromPixels(imageElement);
      t = tf.image.resizeBilinear(t, [INPUT_SIZE, INPUT_SIZE]);
      t = t.toFloat().div(127.5).sub(1);
      return t.expandDims(0);
    });

    const predictions = model.predict(tensor);
    const probs = await predictions.data();
    tensor.dispose();
    predictions.dispose();

    const sorted = TRADES.map((trade, i) => ({ trade, prob: probs[i] }))
      .sort((a, b) => b.prob - a.prob);

    const elapsed_ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    return {
      top: sorted[0],
      top3: sorted.slice(0, 3),
      confidence: sorted[0].prob,
      elapsed_ms,
      fallback_to_grok: sorted[0].prob < CONFIDENCE_THRESHOLD,
      stub: false,
    };
  }

  // ── PUBLIC API ──────────────────────────────────────────────────────────
  window.jakmaClassifyImage = classifyImage;
  window.jakmaLocalClassifier = {
    classify: classifyImage,
    isStub: () => STUB_MODE,
    threshold: CONFIDENCE_THRESHOLD,
    trades: TRADES.slice(),
  };
})();
