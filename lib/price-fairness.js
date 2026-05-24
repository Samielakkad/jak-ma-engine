/**
 * price-fairness.js — AI-augmented price fairness verifier for jak.ma.
 *
 * The rule-based price engine (scripts/price-engine.js) produces a deterministic
 * baseline range per worker. This module is the layer ON TOP: an AI verifier that
 * flags quoted prices as fair / below_fair / above_fair / wildly_off and explains
 * the verdict in Darija.
 *
 * USED AT THREE INTEGRATION POINTS
 * ─────────────────────────────────
 * A. Worker registration / pricing update (server.js POST /api/workers):
 *    - On wildly_off → return 422 with Darija warning so the worker can confirm.
 *    - On above_fair / below_fair → save, but log to admin queue.
 *
 * B. Grounded retrieval (lib/grounded-retrieval.js Pass 2 post-hook):
 *    - If a cited candidate's quoted range is wildly_off → append Darija note.
 *
 * C. Admin sweep (server.js POST /api/admin/audit-prices):
 *    - Iterates all approved workers, flags any not in the fair band.
 *
 * CACHING (24h)
 * ─────────────
 * Mid-range AI verdicts are cached in MongoDB collection `price_fairness_cache`
 * with a TTL index (created in server.js:ensureTTLIndexes). Cache key:
 * `${workerId}:${quotedPrice}`. Hard-rule extremes are NOT cached (they're free).
 *
 * COST
 * ────
 * - Hard rule path: free (regex + arithmetic).
 * - Mid-range LLM path: ~$0.0001 per call (Grok-3-mini, ~250 tokens).
 * - Admin sweep over 2,000 workers, all mid-range: ~$0.20 + 24h cache benefit
 *   on rerun (free).
 */

const { computePriceRange } = require('../scripts/price-engine');
const DARIJA = require('./darija-strings');

// Thresholds for hard rules (deterministic, no LLM)
const HARD_LOW_RATIO = 0.40;   // < 40% of baseline min → wildly_off (suspect typo)
const HARD_HIGH_RATIO = 2.50;  // > 250% of baseline max → wildly_off

const LLM_BUDGET_MS = 3_500;

/**
 * Evaluate price fairness for a single worker / quoted price combination.
 *
 * @param {Object} params
 * @param {Function} params.callXAI - xAI helper from server.js
 * @param {Object} params.db - MongoDB database (for cache); pass null to skip cache
 * @param {Object} params.worker - worker object (must have at least { _id, category, city })
 * @param {number} params.quotedPrice - the price to evaluate
 * @param {string} [params.currency='MAD']
 * @returns {Promise<{
 *   verdict: 'fair'|'below_fair'|'above_fair'|'wildly_off'|'unknown',
 *   message_darija: string,
 *   baseline: {min, max, unit}|null,
 *   confidence: number,
 *   source: 'hard_rule_low'|'hard_rule_high'|'cache'|'llm'|'unknown_category',
 * }>}
 */
async function evaluatePriceFairness({ callXAI, db, worker, quotedPrice, currency = 'MAD' }) {
  // 1. Get the rule-based baseline
  const baseline = computePriceRange(worker);
  if (!baseline) {
    return {
      verdict: 'unknown',
      message_darija: '',
      baseline: null,
      confidence: 0,
      source: 'unknown_category',
    };
  }
  const { min, max, unit } = baseline;
  const quoted = Number(quotedPrice);
  if (!Number.isFinite(quoted) || quoted <= 0) {
    return { verdict: 'unknown', message_darija: '', baseline, confidence: 0, source: 'invalid_input' };
  }

  // 2. Hard-rule extremes (free, deterministic, no LLM call)
  if (quoted < min * HARD_LOW_RATIO) {
    return {
      verdict: 'wildly_off',
      message_darija: DARIJA.PRICE_TOO_LOW({ quoted, currency, unit, min, max, city: worker.city, trade: worker.category }),
      baseline,
      confidence: 0.95,
      source: 'hard_rule_low',
    };
  }
  if (quoted > max * HARD_HIGH_RATIO) {
    return {
      verdict: 'wildly_off',
      message_darija: DARIJA.PRICE_TOO_HIGH({ quoted, currency, unit, min, max, city: worker.city, trade: worker.category }),
      baseline,
      confidence: 0.95,
      source: 'hard_rule_high',
    };
  }

  // 3. Within the fair band? (no LLM needed)
  if (quoted >= min && quoted <= max) {
    return {
      verdict: 'fair',
      message_darija: DARIJA.PRICE_FAIR(baseline),
      baseline,
      confidence: 0.9,
      source: 'fair_band',
    };
  }

  // 4. Cache lookup for mid-range queries (between extremes but outside fair band)
  const cacheKey = `${String(worker._id || worker.id || '')}:${quoted}`;
  if (db && cacheKey !== ':' + quoted) {
    try {
      const cached = await db.collection('price_fairness_cache').findOne({ cache_key: cacheKey });
      if (cached) {
        return { ...cached.verdict_payload, source: 'cache' };
      }
    } catch (err) { /* cache miss is fine */ }
  }

  // 5. LLM verdict for nuanced mid-range cases
  const llmResult = await llmEvaluate({ callXAI, worker, quotedPrice: quoted, baseline, currency });

  // 6. Cache the verdict for 24h (TTL index handles expiry)
  if (db && llmResult.verdict !== 'unknown') {
    try {
      await db.collection('price_fairness_cache').updateOne(
        { cache_key: cacheKey },
        { $set: { cache_key: cacheKey, verdict_payload: llmResult, ts: new Date() } },
        { upsert: true }
      );
    } catch (err) { /* cache write failure non-fatal */ }
  }

  return llmResult;
}

/**
 * LLM-based mid-range evaluation. Used only when hard rules don't fire and the
 * price falls outside the fair band but within plausible extremes.
 */
async function llmEvaluate({ callXAI, worker, quotedPrice, baseline, currency }) {
  const { min, max, unit } = baseline;
  const direction = quotedPrice < min ? 'below_fair' : 'above_fair';

  const systemPrompt = `You are a price-fairness verifier for jak.ma, a Moroccan home services marketplace.

Given a worker profile and a quoted price, judge if the quote is fair given:
- The worker's trade and city (Casablanca/Rabat are 20% pricier than Tangier baseline)
- The worker's profile signals (specialist, luxury keywords, 24/7, etc.)
- Local market norms

The baseline range for this worker is ${min}-${max} ${currency}/${unit}.
The quoted price ${quotedPrice} ${currency} falls ${direction.replace('_', ' ')}.

Output JSON ONLY:
{
  "verdict": "fair" | "below_fair" | "above_fair",
  "message_darija": "1-2 sentence Darija explanation for the user (Arabic script)",
  "confidence": 0.0-1.0
}

Rules for message_darija:
- Plain Moroccan Darija, Arabic script.
- 1-2 sentences max.
- End with a constructive action ("قارن", "تفاوض", "اقبل").`;

  const userPrompt = JSON.stringify({
    worker: {
      category: worker.category,
      city: worker.city,
      zone: worker.zone || '',
      experience: worker.experience || 0,
      tags: worker.tags || [],
      description: (worker.description || '').slice(0, 200),
    },
    quoted_price: quotedPrice,
    currency,
    baseline: { min, max, unit },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_BUDGET_MS);

  try {
    const resp = await callXAI(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { model: 'claude-haiku-4-5', temperature: 0.2, maxTokens: 250, jsonMode: true, signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await resp.json();
    const text = (data?.choices?.[0]?.message?.content || '{}').trim();
    const parsed = JSON.parse(text);

    const verdict = ['fair', 'below_fair', 'above_fair'].includes(parsed.verdict)
      ? parsed.verdict : direction;

    // Use LLM's Darija if present, else fall back to a templated string.
    const fallback = direction === 'below_fair'
      ? DARIJA.PRICE_BELOW_FAIR(baseline)
      : DARIJA.PRICE_ABOVE_FAIR(baseline);
    return {
      verdict,
      message_darija: (parsed.message_darija || '').trim() || fallback,
      baseline,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      source: 'llm',
    };
  } catch (err) {
    clearTimeout(timeout);
    // LLM failed → fall back to templated Darija (deterministic, never crashes the caller)
    const fallback = direction === 'below_fair'
      ? DARIJA.PRICE_BELOW_FAIR(baseline)
      : DARIJA.PRICE_ABOVE_FAIR(baseline);
    return {
      verdict: direction,
      message_darija: fallback,
      baseline,
      confidence: 0.3,
      source: 'llm_fallback',
    };
  }
}

/**
 * Batch evaluator — used by the admin sweep. Hard-rule-only by default
 * (no LLM calls, no cost). Pass { includeLLM: true } to also run mid-range.
 *
 * Returns: { total, fair, below_fair, above_fair, wildly_off, unknown, samples }
 */
async function batchEvaluate({ callXAI, db, workers, includeLLM = false }) {
  const counts = { total: 0, fair: 0, below_fair: 0, above_fair: 0, wildly_off: 0, unknown: 0 };
  const samples = { wildly_off: [], above_fair: [], below_fair: [] };

  for (const w of workers) {
    counts.total++;
    // Evaluate both min and max — flag the worker if either is suspect
    for (const quoted of [w.price_min, w.price_max].filter(Number.isFinite)) {
      const ev = includeLLM
        ? await evaluatePriceFairness({ callXAI, db, worker: w, quotedPrice: quoted })
        : await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: quoted });
      const v = ev.verdict;
      counts[v] = (counts[v] || 0) + 1;
      if (v === 'wildly_off' && samples.wildly_off.length < 25) samples.wildly_off.push({ _id: String(w._id), name: w.name, category: w.category, city: w.city, quoted, baseline: ev.baseline });
      if (v === 'above_fair' && samples.above_fair.length < 10) samples.above_fair.push({ _id: String(w._id), name: w.name, quoted, baseline: ev.baseline });
      if (v === 'below_fair' && samples.below_fair.length < 10) samples.below_fair.push({ _id: String(w._id), name: w.name, quoted, baseline: ev.baseline });
    }
  }
  return { counts, samples };
}

module.exports = { evaluatePriceFairness, llmEvaluate, batchEvaluate, HARD_LOW_RATIO, HARD_HIGH_RATIO };
