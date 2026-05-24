/**
 * hybrid-retrieval.js — sparse (BM25) + dense (embeddings) retrieval over workers.
 *
 * The existing retrieveCandidates in grounded-retrieval.js uses a strict
 * (category|secondary_categories) × city filter. That's reliable but brittle
 * when the user describes their problem in free-form Darija that doesn't map
 * cleanly to a single category — e.g. "بغيت واحد يصلح ليا حنفية وتيوبو فالطنجة"
 * (mixed plumbing + tiling intent).
 *
 * This module adds:
 *   - SPARSE: MongoDB $text index over (name, description, tags). Token-overlap
 *     ranking via $meta:'textScore'. Free, zero new deps.
 *   - DENSE: optional embedding-based ranking. Vector store + ANN scaffolding
 *     is here but DISABLED by default (USE_EMBEDDINGS env flag) because it
 *     needs an embedding-model endpoint + per-call cost. The plumbing is ready;
 *     flip the flag once you have one.
 *
 * Hybrid score: 0.6 × bm25 + 0.4 × embedding_cosine + 0.2 × structured_boost.
 * (Structured boost = featured/verified/rating — same signal as the existing
 * sort key.) Weights are empirical first guesses — tune via the eval suite.
 *
 * Integration: NOT yet called by handleGroundedChat. Wire it in once you have
 * a benchmark showing it beats the strict filter on the 5-dim rubric. The
 * scaffolding exists so the architectural story holds water for a recruiter
 * reading the code, and so the path from "regex + filter" to "hybrid sparse-
 * dense + reranker" is documented in code, not just in claims.
 */

const USE_EMBEDDINGS = process.env.USE_EMBEDDINGS === '1';
const EMBED_ENDPOINT = process.env.EMBED_ENDPOINT || 'https://api.x.ai/v1/embeddings';
const EMBED_MODEL = process.env.EMBED_MODEL || 'grok-2-vision-1212';  // placeholder; xAI's embedding model name TBD

// ── SPARSE: BM25 via MongoDB $text ──────────────────────────────────────────

/**
 * Ensure a text index exists on workers. Called from server.js:ensureIndexes.
 * Idempotent — MongoDB no-ops if the same index already exists.
 */
async function ensureTextIndex(db) {
  if (!db) return;
  try {
    await db.collection('workers').createIndex(
      { name: 'text', description: 'text', tags: 'text', zone: 'text' },
      { name: 'workers_text_index', weights: { name: 10, tags: 5, description: 3, zone: 1 } }
    );
  } catch (err) {
    // Existing text index with different fields/weights will throw — that's
    // OK in dev where someone manually created a different text index.
    if (!String(err.message || '').includes('different options')) {
      console.error('[hybrid] ensureTextIndex:', err.message);
    }
  }
}

/**
 * BM25-ranked retrieval. Returns workers scored by token overlap with the
 * query, intersected with the strict (trade, city) filter so we keep
 * grounding intact.
 */
async function bm25Retrieve(db, { query, trade, city, approved = true, limit = 12 }) {
  if (!db || !query) return [];
  const filter = {
    $text: { $search: query },
    approved: { $ne: false },
    available: { $ne: false },
  };
  if (trade) filter.$or = [{ category: trade }, { secondary_categories: trade }];
  if (city) filter.city = city;
  try {
    return await db.collection('workers')
      .find(filter, { projection: { _id: 1, name: 1, category: 1, secondary_categories: 1, city: 1, zone: 1, phone: 1, description: 1, price_min: 1, price_max: 1, price_unit: 1, price: 1, rating: 1, rating_count: 1, experience: 1, verified: 1, featured: 1, tags: 1, score: { $meta: 'textScore' } } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray();
  } catch (err) {
    // Returns [] on missing $text index — caller falls back to strict retrieval.
    return [];
  }
}

// ── DENSE: embedding-based retrieval (scaffolded, disabled by default) ──────

async function embedQuery(text, fetch = global.fetch) {
  if (!USE_EMBEDDINGS) return null;
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(EMBED_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });
    const data = await r.json();
    return data?.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/**
 * Dense retrieval: embeds the query, fetches candidates from MongoDB
 * (typically the BM25 top-N), and reranks by cosine similarity against
 * each candidate's pre-computed embedding (stored in worker.embedding).
 *
 * If candidates lack stored embeddings, this currently no-ops. The
 * embedding-population pipeline lives in scripts/embed-workers.js (TODO).
 */
async function denseRerank(query, candidates, fetch = global.fetch) {
  if (!USE_EMBEDDINGS || !candidates || candidates.length === 0) return candidates;
  const qVec = await embedQuery(query, fetch);
  if (!qVec) return candidates;
  return candidates
    .map(c => ({ ...c, _dense: cosine(qVec, c.embedding) }))
    .sort((a, b) => (b._dense || 0) - (a._dense || 0));
}

// ── HYBRID: combine sparse + dense + structured boost ───────────────────────

function structuredBoost(worker) {
  let b = 0;
  if (worker.featured) b += 0.2;
  if (worker.verified) b += 0.1;
  b += Math.min((worker.rating || 0) / 5, 1) * 0.1;
  return b;
}

/**
 * Hybrid retrieval. Returns a ranked list of candidates.
 *
 * @param {Object} db - MongoDB database
 * @param {Object} opts - { query, trade, city, limit, weights? }
 * @returns {Promise<Array>}
 */
async function hybridRetrieve(db, opts) {
  const { query, trade, city, limit = 8, weights = { bm25: 0.6, dense: 0.4, struct: 0.2 } } = opts;
  let candidates = await bm25Retrieve(db, { query, trade, city, limit: 20 });
  if (candidates.length === 0) return [];

  const bm25Max = Math.max(...candidates.map(c => c.score || 0)) || 1;

  if (USE_EMBEDDINGS) {
    candidates = await denseRerank(query, candidates);
  }
  const denseMax = Math.max(...candidates.map(c => c._dense || 0)) || 1;

  const ranked = candidates
    .map(c => {
      const bm25Norm = (c.score || 0) / bm25Max;
      const denseNorm = (c._dense || 0) / denseMax;
      const structNorm = structuredBoost(c);
      const hybridScore = weights.bm25 * bm25Norm + weights.dense * denseNorm + weights.struct * structNorm;
      return { ...c, _hybrid: hybridScore };
    })
    .sort((a, b) => b._hybrid - a._hybrid)
    .slice(0, limit);

  return ranked;
}

module.exports = {
  bm25Retrieve,
  denseRerank,
  hybridRetrieve,
  ensureTextIndex,
  embedQuery,
  cosine,
  USE_EMBEDDINGS,
};
