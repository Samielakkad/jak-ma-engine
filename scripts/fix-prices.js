#!/usr/bin/env node
/**
 * Rewrites worker prices in data/workers.json with realistic Moroccan market rates.
 *
 * Sources: forumconstruction.ma, mano.ma, likoum.ma, mondevis.ma, mainenmain.ma (2024-2025)
 *
 * Methodology:
 *  - Base price range per category (from real Moroccan market data)
 *  - City multiplier (Casablanca highest, small cities lowest)
 *  - Random spread within range so prices look natural, not uniform
 *  - Fixes price_unit where it was wrong
 */

const fs   = require('fs');
const path = require('path');

const DATA_PATH   = path.join(__dirname, '..', 'data', 'workers.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `workers.backup.prices.${Date.now()}.json`);

// ── City multipliers (base = Tanger = 1.0) ──────────────────────────────────
// Source: mano.ma, forumconstruction.ma — Casablanca 20-30% > Tanger, small cities 10-15% less
const CITY_MULT = {
  // Casablanca zone +20%
  'الدار البيضاء': 1.22, 'عين الشق': 1.20, 'عين السبع': 1.18,
  'أنفا': 1.22, 'الحي الحسني': 1.18, 'الحي المحمدي': 1.16,
  'المحمدية': 1.14, 'سيدي مومن': 1.15,
  // Marrakech zone +10% (tourism premium)
  'مراكش': 1.12, 'المحاميد': 1.08, 'كيليز': 1.10,
  'تمارة مراكش': 1.08, 'المدينة القديمة': 1.10, 'سيدي يوسف': 1.06,
  // Agadir zone +5%
  'أكادير': 1.08, 'إنزكان': 1.05, 'آيت ملول': 1.04,
  'شتوكة آيت باها': 1.02,
  // Tanger = base
  'طنجة': 1.00,
  // Smaller cities -10%
  'تيزنيت': 0.90, 'تارودانت': 0.88,
};

// ── Category price configs ────────────────────────────────────────────────────
// Each: { unit, min, max }  — prices are BASE (Tanger-equivalent)
// Sources: avito.ma listings, mano.ma, likoum.ma, chronomenage.com, forumconstruction.ma 2025
// Avito confirms LOWER prices than company sites — these reflect real independent worker rates
const CAT_PRICE = {
  // Maçon qualifié: 200–350 DH/jour. Avito + forumconstruction.ma confirm this range.
  // Unskilled helper: 120–180. Qualified: 200–350. Tanger base.
  'بناء':       { unit: 'اليوم',   min: 200, max: 350 },

  // Plombier indépendant: 100–250 DH/heure. Avito most common: 150–200 DH.
  // Companies charge more (300+) but independent artisans on avito: 100–250.
  'بلومبي':     { unit: 'الساعة',  min: 100, max: 250 },

  // Peintre: 180–300 DH/jour. forumconstruction: "200–300 DH/jour".
  // Avito listings confirm 200–300 range for independents.
  'صباغة':      { unit: 'اليوم',   min: 180, max: 310 },

  // Menuisier qualifié: 250–480 DH/jour. Aluminum specialists slightly higher.
  // forumconstruction: "300–600 DH" but avito indie workers: 250–480.
  'نجارة':      { unit: 'اليوم',   min: 250, max: 480 },

  // Ferronnier/soudeur: 250–450 DH/jour. Similar to menuisier, market rate.
  'حدادة':      { unit: 'اليوم',   min: 250, max: 450 },

  // Décorateur intérieur: 350–650 DH/jour. More specialized = higher.
  'ديكور':      { unit: 'اليوم',   min: 350, max: 650 },

  // Déménagement LOCAL (même ville): 300–1500 DH. Avito: "300–500 DH" small moves.
  // mainenmain.ma: petit appartement 600–1500. Grand appartement 1500–3000.
  'نقل':        { unit: 'المرة',   min: 300, max: 1500 },

  // Carreleur: 200–350 DH/jour. mano.ma: 25–40 DH/m², 10–15m²/jour → 250–600 DH.
  // But independent workers (avito): 200–350 DH/jour is the real market rate.
  'كلامبيستري': { unit: 'اليوم',   min: 200, max: 350 },

  // Couturière/retouche: 40–150 DH/pièce. Retouche simple: 40–80. Confection: 80–150.
  'خياطة':      { unit: 'القطعة',  min: 40,  max: 150 },

  // Gardien de nuit indépendant: 150–280 DH/nuit.
  // Avito: 1600–3000 DH/mois → ~55–100 DH/jour. Nuit rate ~150–280 DH.
  'حراسة':      { unit: 'الليلة',  min: 150, max: 280 },

  // Électricien indépendant: 100–250 DH/heure. Avito: 97–200 DH most common.
  // Companies charge 300–500 but indie artisans: 100–250.
  'طريسيان':    { unit: 'الساعة',  min: 100, max: 250 },

  // Femme de ménage: 120–230 DH/jour. chronomenage: 30 DH/h → 240 DH/8h.
  // likoum.ma Casablanca: 150–200 DH/jour. Marrakech: 120–180. Avito: ~2500–3000/mois → 100–130/jour.
  'نقاوة':      { unit: 'اليوم',   min: 120, max: 230 },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
// Seeded random based on worker id so re-runs give same result
function seededRand(seed, min, max) {
  // Simple deterministic hash
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  const t = Math.abs(h) / 2147483647;
  return Math.round(min + t * (max - min));
}

function getPrice(worker) {
  const cfg = CAT_PRICE[worker.category];
  if (!cfg) return null;

  const mult = CITY_MULT[worker.city] || 1.0;
  const min  = Math.round(cfg.min * mult);
  const max  = Math.round(cfg.max * mult);

  // Use worker's _id or name as seed for deterministic spread
  const seed = String(worker._id || worker.name || worker.phone || Math.random());
  const price = seededRand(seed, min, max);

  // Round to nearest 10 for realism
  return { price: Math.round(price / 10) * 10, unit: cfg.unit };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const original = fs.readFileSync(DATA_PATH, 'utf8');
const workers  = JSON.parse(original);

let updated = 0;
let skipped = 0;
const samples = [];

for (const w of workers) {
  const result = getPrice(w);
  if (!result) { skipped++; continue; }

  const oldPrice = w.price;
  const oldUnit  = w.price_unit;

  w.price      = String(result.price);
  w.price_unit = result.unit;
  updated++;

  if (samples.length < 20) {
    samples.push({
      name: (w.name || '').slice(0, 30),
      cat: w.category,
      city: w.city,
      old: oldPrice + ' ' + oldUnit,
      new: result.price + ' ' + result.unit,
    });
  }
}

console.log('=== PRICE FIX ===');
console.log(`Updated : ${updated}`);
console.log(`Skipped : ${skipped} (unknown category)`);
console.log('\nSample changes:');
samples.forEach(s => {
  console.log(`  [${s.cat}/${s.city}] ${s.name}`);
  console.log(`    ${s.old}  →  ${s.new}`);
});

// Show per-category stats
console.log('\nPer-category range after fix:');
const stats = {};
workers.forEach(w => {
  const c = w.category;
  if (!stats[c]) stats[c] = { prices: [], unit: w.price_unit };
  const p = Number(w.price);
  if (p > 0) stats[c].prices.push(p);
});
Object.entries(stats).forEach(([cat, s]) => {
  const sorted = s.prices.sort((a,b)=>a-b);
  const min = sorted[0], max = sorted[sorted.length-1];
  const avg = Math.round(s.prices.reduce((a,b)=>a+b,0)/s.prices.length);
  console.log(`  ${cat}: ${min}–${max} DH/${s.unit} (avg ${avg})`);
});

fs.writeFileSync(BACKUP_PATH, original);
console.log('\nBackup saved:', BACKUP_PATH);
fs.writeFileSync(DATA_PATH, JSON.stringify(workers, null, 2));
console.log('Updated:', DATA_PATH);
console.log('✅ Done.');
