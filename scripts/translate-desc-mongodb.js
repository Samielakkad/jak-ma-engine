#!/usr/bin/env node
/**
 * Translates templated worker descriptions in MongoDB to authentic Moroccan Darija.
 *
 * SAFE: only changes descriptions that match known seeded templates.
 * Real self-registered descriptions that don't start with a known prefix are left untouched.
 * DRY-RUN by default — pass --apply to write.
 *
 * Usage:
 *   MONGODB_URI=... node scripts/translate-desc-mongodb.js           # dry run
 *   MONGODB_URI=... node scripts/translate-desc-mongodb.js --apply   # apply
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('FATAL: MONGODB_URI missing.'); process.exit(1); }

// ── Same translation engine as translate-desc-darija.js ──────────────────────
const TEMPLATES = [
  { starts: ['أعمال بناء في '],              darija: c => `بناء فـ${c} — البناء والليبسة والتصليح` },
  { starts: ['سباكة في '],                   darija: c => `بلومبي فـ${c} — تصليح التسريبات وتركيب الصنابر والحمامات` },
  { starts: ['صباغة في '],                   darija: c => `صباغة فـ${c} — الداخل والخارج، التيلي والواجزيري` },
  { starts: ['نجارة في '],                   darija: c => `نجارة فـ${c} — البيبان والشبابيك والأثاث عل التقديرة` },
  { starts: ['ديكور داخلي في '],             darija: c => `ديكور داخلي فـ${c} — جبس، بلاط، وتزويق الصالونات` },
  { starts: ['نقل عفش في '],                darija: c => `نقل العفش فـ${c} — داخل المدينة وبين المدن` },
  { starts: ['تركيب وإصلاح كلامبيستري في '], darija: c => `كلامبيستري فـ${c} — البلاط والزليج والرخام` },
  { starts: ['خياطة وتعديل ملابس في '],      darija: c => `خياطة فـ${c} — تخييط وتبديل الحوايج` },
  { starts: ['حراسة وأمن في '],             darija: c => `حراسة وأمن فـ${c}` },
  { starts: ['خدمة كهرباء في ', 'كهربائي في '], darija: c => `طريسيان فـ${c} — تحويلات، تمديدات، وتصليح العطالات` },
  { starts: ['خدمة تنظيف في '],             darija: c => `نقاوة فـ${c} — الشقق والفيلات والمكاتب` },
  { starts: ['حدادة في '],                  darija: c => `حدادة فـ${c} — الشبابيك وبيبان الحديد والدرابيز` },
];

const VALID_CITIES = new Set([
  'طنجة', 'الدار البيضاء', 'عين الشق', 'عين السبع', 'أنفا', 'الحي الحسني',
  'الحي المحمدي', 'المحمدية', 'سيدي مومن', 'أكادير', 'إنزكان', 'آيت ملول',
  'تيزنيت', 'تارودانت', 'شتوكة آيت باها', 'مراكش', 'المحاميد', 'كيليز',
  'تمارة مراكش', 'المدينة القديمة', 'سيدي يوسف',
]);

function extractCity(desc, prefix) {
  const rest = desc.slice(prefix.length);
  const cityRaw = rest.replace(/\s*[—–\-].*$|\s*\..*$/s, '').trim();
  if (VALID_CITIES.has(cityRaw)) return cityRaw;
  let best = null;
  for (const c of VALID_CITIES) {
    if (cityRaw.startsWith(c) && (!best || c.length > best.length)) best = c;
  }
  return best || cityRaw;
}

function translate(desc) {
  if (!desc) return null;
  for (const tpl of TEMPLATES) {
    for (const prefix of tpl.starts) {
      if (desc.startsWith(prefix)) {
        const city = extractCity(desc, prefix);
        if (!city) return null;
        return tpl.darija(city);
      }
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const col = client.db().collection('workers');

  const all = await col.find({}).toArray();
  console.log('Loaded', all.length, 'workers from MongoDB');

  const toUpdate = [];
  for (const w of all) {
    const newDesc = translate(w.description || '');
    if (newDesc && newDesc !== w.description) {
      toUpdate.push({ _id: w._id, old: (w.description || '').slice(0, 70), new: newDesc });
    }
  }

  console.log(`Will translate: ${toUpdate.length} / ${all.length}`);
  console.log(`Unchanged (custom or no match): ${all.length - toUpdate.length}`);
  console.log('\nFirst 20 changes:');
  toUpdate.slice(0, 20).forEach(u => {
    console.log(`  OLD: ${u.old}`);
    console.log(`  NEW: ${u.new}`);
    console.log();
  });

  if (!APPLY) {
    console.log('\n** DRY RUN — MongoDB NOT modified. Pass --apply to commit. **');
    await client.close();
    return;
  }

  // Save snapshot for rollback
  const snapPath = path.join(__dirname, '..', 'data', `mongo-desc-darija-snapshot-${Date.now()}.json`);
  const snapshot = toUpdate.map(u => ({ _id: u._id, old_description: u.old }));
  fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
  console.log('\nSnapshot saved:', snapPath);

  // Apply updates in bulk
  let done = 0;
  for (const u of toUpdate) {
    await col.updateOne({ _id: u._id }, { $set: { description: u.new } });
    done++;
    if (done % 50 === 0) process.stdout.write(`\r  Applied ${done}/${toUpdate.length}...`);
  }
  console.log(`\n✅ Done — ${done} workers updated in MongoDB.`);
  await client.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
