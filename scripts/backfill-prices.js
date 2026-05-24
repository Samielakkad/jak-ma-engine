/**
 * backfill-prices.js — populate price_min / price_max / price_unit on all workers.
 *
 * Reads each worker, computes the price range via scripts/price-engine.js
 * (rule-based, deterministic, takes the same signals computePriceRange uses
 * elsewhere in the codebase). Writes the result back via bulkWrite.
 *
 * Idempotent: rerunning produces the same values (computePriceRange is
 * deterministic with respect to worker._id + name).
 *
 * Usage:
 *   node scripts/backfill-prices.js              # dry-run; logs what WOULD change
 *   node scripts/backfill-prices.js --write      # actually apply
 *   node scripts/backfill-prices.js --write --force  # rewrite even existing values
 *
 * Integration point: Phase 0.4 of the upgrade mission. Run after
 * scripts/diag-price-fields.js reports coverage < 90%.
 *
 * Vercel function timeout: this is a CLI script — runs from a dev machine,
 * not a serverless function. No 30s limit applies.
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const { computePriceRange } = require('./price-engine');

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');
const BATCH = 200;

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set.');
  process.exit(1);
}

(async () => {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db('brikoul');
  const col = db.collection('workers');

  const total = await col.countDocuments({});
  console.log(`workers total: ${total}`);
  console.log(`mode: ${WRITE ? (FORCE ? 'WRITE + FORCE rewrite existing' : 'WRITE (skip workers with existing values)') : 'DRY-RUN'}`);
  console.log('');

  let processed = 0, willUpdate = 0, skippedNoCategory = 0, skippedHasValues = 0, ops = [];

  const filter = FORCE ? {} : {
    $or: [
      { price_min: { $exists: false } },
      { price_min: { $lte: 0 } },
      { price_max: { $exists: false } },
      { price_max: { $lte: 0 } },
      { price_unit: { $exists: false } },
    ],
  };

  const cursor = col.find(filter, {
    projection: { _id: 1, name: 1, category: 1, city: 1, description: 1, tags: 1, experience: 1, phone: 1, price_min: 1, price_max: 1, price_unit: 1 }
  });

  for await (const w of cursor) {
    processed++;
    const range = computePriceRange(w);
    if (!range) { skippedNoCategory++; continue; }

    // Skip if already populated and not forcing
    if (!FORCE && w.price_min > 0 && w.price_max > 0 && w.price_unit) {
      skippedHasValues++;
      continue;
    }

    willUpdate++;
    ops.push({
      updateOne: {
        filter: { _id: w._id },
        update: { $set: { price_min: range.min, price_max: range.max, price_unit: range.unit, price_backfilled_at: new Date() } },
      },
    });

    if (ops.length >= BATCH && WRITE) {
      const r = await col.bulkWrite(ops, { ordered: false });
      console.log(`  batch wrote ${r.modifiedCount} (processed so far: ${processed})`);
      ops = [];
    }
  }

  if (ops.length && WRITE) {
    const r = await col.bulkWrite(ops, { ordered: false });
    console.log(`  final batch wrote ${r.modifiedCount}`);
  }

  console.log('');
  console.log('─── summary ─────────────────────────────────────────────────');
  console.log(`  processed:                    ${processed}`);
  console.log(`  would update / updated:       ${willUpdate}`);
  console.log(`  skipped (no category match):  ${skippedNoCategory}`);
  console.log(`  skipped (values present):     ${skippedHasValues}`);
  console.log('');

  if (!WRITE && willUpdate > 0) {
    console.log('  ↪ dry-run only. To apply: re-run with --write');
  }

  await client.close();
})().catch(err => {
  console.error('❌ backfill failed:', err.message);
  process.exit(2);
});
