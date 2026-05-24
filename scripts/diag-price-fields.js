/**
 * diag-price-fields.js — read-only diagnostic for the workers collection.
 *
 * Purpose: before deploying grounded retrieval, verify that every worker has
 * `price_min`, `price_max`, and `price_unit` populated. The grounded retrieval
 * candidate projection (lib/grounded-retrieval.js:160) reads these fields and
 * silently degrades if they're missing.
 *
 * Usage:
 *   node scripts/diag-price-fields.js
 *
 * Exits 0 always. Read-only. Safe to run in production.
 *
 * Integration point: invoked manually in Phase 0.3 of the upgrade mission.
 *   If coverage < 90% → run scripts/backfill-prices.js next.
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set. Add it to .env or export it.');
  process.exit(1);
}

(async () => {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db('brikoul');
  const col = db.collection('workers');

  const total = await col.countDocuments({});
  const approved = await col.countDocuments({ approved: { $ne: false } });

  const hasMin = await col.countDocuments({ price_min: { $exists: true, $gt: 0 } });
  const hasMax = await col.countDocuments({ price_max: { $exists: true, $gt: 0 } });
  const hasUnit = await col.countDocuments({ price_unit: { $exists: true, $type: 'string' } });
  const hasAll = await col.countDocuments({
    price_min: { $exists: true, $gt: 0 },
    price_max: { $exists: true, $gt: 0 },
    price_unit: { $exists: true, $type: 'string' },
  });

  const coverage = total === 0 ? 0 : (hasAll / total) * 100;

  console.log('─── workers collection — price field coverage ────────────────');
  console.log(`  total documents:           ${total}`);
  console.log(`  approved (active):         ${approved}`);
  console.log(`  has price_min > 0:         ${hasMin}  (${pct(hasMin, total)}%)`);
  console.log(`  has price_max > 0:         ${hasMax}  (${pct(hasMax, total)}%)`);
  console.log(`  has price_unit (string):   ${hasUnit} (${pct(hasUnit, total)}%)`);
  console.log(`  has ALL three:             ${hasAll}  (${coverage.toFixed(1)}%)`);
  console.log('');

  const missing = await col.find(
    {
      $or: [
        { price_min: { $exists: false } },
        { price_min: { $lte: 0 } },
        { price_max: { $exists: false } },
        { price_max: { $lte: 0 } },
        { price_unit: { $exists: false } },
      ],
    },
    { projection: { _id: 1, name: 1, category: 1, city: 1, price: 1, price_min: 1, price_max: 1, price_unit: 1 } }
  ).limit(5).toArray();

  if (missing.length) {
    console.log('─── sample missing-field workers ────────────────────────────');
    for (const w of missing) {
      console.log(`  ${String(w._id).slice(-6)}  ${w.name?.slice(0, 20).padEnd(20)} ${(w.category || '?').padEnd(12)} ${w.city || '?'}`);
      console.log(`     price="${w.price ?? ''}"  min=${w.price_min ?? '∅'}  max=${w.price_max ?? '∅'}  unit=${w.price_unit ?? '∅'}`);
    }
    console.log('');
  }

  // Recommendation
  console.log('─── recommendation ──────────────────────────────────────────');
  if (coverage >= 90) {
    console.log('  ✅ Coverage OK. Grounded retrieval can ship without backfill.');
  } else {
    console.log(`  ⚠️  Coverage ${coverage.toFixed(1)}% (target ≥90%).`);
    console.log('     Run: node scripts/backfill-prices.js          (dry-run first)');
    console.log('     Then: node scripts/backfill-prices.js --write (to apply)');
  }

  await client.close();
})().catch(err => {
  console.error('❌ diag failed:', err.message);
  process.exit(2);
});

function pct(n, total) {
  if (!total) return '0.0';
  return ((n / total) * 100).toFixed(1);
}
