/**
 * semantic-cache.js — 1h MongoDB-backed cache for grounded retrieval turns.
 *
 * Used to dodge the LLM Pass-2 call on repeat-or-similar queries. Cache key is
 * a SHA-1 of the canonical-form query (diacritic-stripped, whitespace-collapsed,
 * Latin-lowercased). Hits replay the AI text but ALWAYS re-fetch candidates
 * from MongoDB — that way worker availability changes are never stale.
 *
 * Why a hash and not real semantic similarity? At jak.ma's scale (~100 q/day)
 * the natural variation in phrasing is small. SHA-1 of canonical text catches
 * the high-traffic repeated queries (e.g. "بغيت بلومبي فطنجة" typed by a
 * dozen users this week) without paying for an embedding model. For deeper
 * fuzz, swap the canonical function to use embeddings + ANN later.
 *
 * Storage: MongoDB collection `chat_cache` with TTL index on `ts` (3600 s).
 * The TTL index is created in server.js:ensureTTLIndexes alongside the others.
 *
 * Cost: zero. Storage <1MB even at 10k cached entries.
 */

const crypto = require('crypto');

const TTL_MS = 60 * 60 * 1000;  // 1 hour

// Canonical form for cache-key purposes. Conservative — small false-positive
// rate is way preferable to false hits returning stale text.
function canonicalQuery(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')  // Arabic diacritics + tatweel
    .replace(/[^؀-ۿa-z0-9\s]/g, ' ')    // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 250);
}

function cacheKey(text) {
  return crypto.createHash('sha1').update(canonicalQuery(text)).digest('hex').slice(0, 20);
}

/**
 * @returns {Promise<{rawOutput, citedIds, classification, ts} | null>}
 */
async function getCached(db, query) {
  if (!db) return null;
  try {
    const doc = await db.collection('chat_cache').findOne({ key: cacheKey(query) });
    if (!doc || !doc.ts) return null;
    if (Date.now() - new Date(doc.ts).getTime() > TTL_MS) return null;
    return doc.payload || null;
  } catch (err) {
    return null;
  }
}

async function setCached(db, query, payload) {
  if (!db || !payload) return;
  try {
    await db.collection('chat_cache').updateOne(
      { key: cacheKey(query) },
      { $set: { key: cacheKey(query), q_preview: (query || '').slice(0, 80), payload, ts: new Date() } },
      { upsert: true }
    );
  } catch {}
}

// Speculative-intro generator. Returns a short Darija sentence we can stream
// IMMEDIATELY when the regex pre-filter hits — gives the user feedback in
// ~50ms (vs ~2-3s waiting for Grok Pass 2 to start streaming). The actual
// LLM output streams after this.
function speculativeIntro(classification, candidatesCount) {
  if (!classification?.trade) return '';
  const trade = classification.trade;
  const city = classification.city;
  if (candidatesCount === 0) return '';
  if (city) {
    return `لقيتلك ${candidatesCount} ${trade} ف${city}، جا نوريهملك... `;
  }
  return `لقيتلك ${candidatesCount} ${trade}، جا نوريهملك... `;
}

module.exports = { canonicalQuery, cacheKey, getCached, setCached, speculativeIntro, TTL_MS };
