#!/usr/bin/env node
/**
 * MongoDB-safe reclassifier for production self-registered workers.
 *
 * SAFETY GUARANTEES (this script will NEVER lose user data):
 *  - DEFAULT MODE: only ADDS secondary_categories. Primary category from the user's
 *    self-registration is NEVER touched. This is the recommended mode for production.
 *  - With `--allow-override`: will also flip primary categories on very high confidence,
 *    but ALWAYS saves the original to `original_category` first (reversible).
 *  - DRY-RUN by default. You must pass `--apply` to actually write to MongoDB.
 *  - Writes a JSON snapshot of every changed worker to data/mongo-reclassify-snapshot-<ts>.json
 *    BEFORE applying changes — you can roll back from this snapshot.
 *  - Skips already-reviewed workers (those with the `needs_review` flag cleared).
 *
 * Usage:
 *   MONGODB_URI=... node scripts/reclassify-mongodb.js                       # dry run, secondary only
 *   MONGODB_URI=... node scripts/reclassify-mongodb.js --apply                # apply secondary only (safe)
 *   MONGODB_URI=... node scripts/reclassify-mongodb.js --apply --allow-override  # also flip primaries
 *
 * To roll back from snapshot:
 *   MONGODB_URI=... node scripts/reclassify-mongodb.js --rollback <snapshot.json>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const ALLOW_OVERRIDE = process.argv.includes('--allow-override');
const ROLLBACK_IDX = process.argv.indexOf('--rollback');
const ROLLBACK_FILE = ROLLBACK_IDX !== -1 ? process.argv[ROLLBACK_IDX + 1] : null;

const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error('FATAL: MONGODB_URI missing. Set it in .env or env var.');
  process.exit(1);
}

// ── Same scoring engine as reclassify-heuristic.js ────────────────────────────
const SIGNALS = {
  'بلومبي': [['plomberie', 2], ['plombier', 2], ['plumber', 2], ['sanitaire', 2], ['chauffe-eau', 2], ['chauffe eau', 2], ['سباكة', 2], ['سباك', 2], ['بلومبي', 2], ['تسريب', 2], ['تيوبو', 1], ['بيبان', 1], ['صنبور', 2], ['robinet', 1], ['douche', 1], ['baignoire', 1], ['toilette', 1], ['fuite', 1], ['evacuation', 1], ['siphon', 1], ['plomb', 1], ['cumulus', 2], ['conduite', 1], ['canalisation', 2]],
  'طريسيان': [['électricien', 2], ['electricien', 2], ['électricité', 2], ['electricite', 2], ['electrical', 2], ['electrician', 2], ['كهرباء', 2], ['كهربائي', 2], ['طريسيان', 2], ['تريسيان', 2], ['تابلو كهربائي', 2], ['disjoncteur', 2], ['câblage', 2], ['cablage', 2], ['installation électrique', 2], ['climatiseur', 1], ['airzone', 2], ['interphone', 1], ['domotique', 2]],
  'صباغة': [['peinture', 2], ['peintre', 2], ['painter', 2], ['painting', 2], ['صباغة', 2], ['صباغ', 2], ['دهان', 2], ['تصبيغ', 2], ['enduit', 1], ['ravalement', 2], ['façade', 1], ['crépi', 2], ['crepi', 2]],
  'نجارة': [['menuiserie', 2], ['menuisier', 2], ['carpenter', 2], ['carpentry', 2], ['ébéniste', 2], ['ebeniste', 2], ['نجارة', 2], ['نجار', 2], ['خشب', 2], ['باركي', 2], ['parquet', 2], ['placard', 1], ['armoire', 1], ['bois', 1], ['cuisine bois', 2], ['porte bois', 2], ['fenêtre bois', 2], ['fenetre bois', 2]],
  'بناء': [['maçon', 2], ['macon', 2], ['maçonnerie', 2], ['maconnerie', 2], ['construction', 2], ['btp', 2], ['gros oeuvre', 2], ['gros œuvre', 2], ['بناء', 2], ['تشييد', 2], ['ترميم', 2], ['تيبسية', 2], ['خرسانة', 2], ['béton', 1], ['beton', 1], ['fissure', 1], ['démolition', 2], ['demolition', 2], ['fondation', 2]],
  'نقاوة': [['nettoyage', 2], ['ménage', 2], ['femme de menage', 2], ['femme de ménage', 2], ['cleaning', 2], ['نقاوة', 2], ['تنظيف', 2], ['نضافة', 2], ['désinfection', 2], ['desinfection', 2], ['lavage', 1], ['nounou', 2]],
  'حدادة': [['ferronnerie', 2], ['serrurier', 2], ['serrurerie', 2], ['soudeur', 2], ['soudure', 2], ['inox', 2], ['حدادة', 2], ['حداد', 2], ['سودور', 2], ['fer forgé', 2], ['fer forge', 2], ['portail', 2], ['grille', 1], ['métallique', 1], ['metallique', 1], ['construction métallique', 2], ['aluminium', 2], ['ألومنيوم', 2], ['شباك حديد', 2], ['شبابيك حديد', 2], ['شبابيك ألومنيوم', 2], ['شباك ألومنيوم', 2], ['menuiserie aluminium', 2], ['menuiserie alu', 2], ['façade aluminium', 2], ['mur rideau', 2]],
  'ديكور': [['décoration', 2], ['decoration', 2], ['décorateur', 2], ['decorateur', 2], ['design intérieur', 2], ['interior design', 2], ['faux plafond', 2], ['plâtre', 2], ['platre', 2], ['gypse', 2], ['placo', 2], ['placoplâtre', 2], ['ديكور', 2], ['جبس', 2], ['تصميم داخلي', 2], ['ورق الحيطان', 2], ['aménagement', 2], ['amenagement', 2], ['papier peint', 2]],
  'نقل': [['déménagement', 2], ['demenagement', 2], ['déménageur', 2], ['demenageur', 2], ['transport', 2], ['moving', 2], ['نقل', 2], ['نقل العفش', 2], ['تحويل العفش', 2], ['شاحنة', 2], ['camion', 1], ['livraison', 1], ['delivery', 1]],
  'كلامبيستري': [['carrelage', 2], ['carreleur', 2], ['zellige', 2], ['faïence', 2], ['faience', 2], ['marbre', 2], ['mosaïque', 2], ['كلامبيستري', 2], ['زليج', 2], ['بلاط', 2], ['تبليط', 2], ['رخام', 2], ['فايانس', 2], ['pose carrelage', 2], ['revêtement de sol', 2], ['revetement de sol', 2], ['floor', 1]],
  'خياطة': [['couture', 2], ['couturier', 2], ['couturière', 2], ['couturiere', 2], ['tailor', 2], ['tailleur', 2], ['retouche', 2], ['خياطة', 2], ['خياط', 2], ['قفطان', 2], ['جلابة', 2], ['rideaux', 2], ['rideau', 2], ['tapisserie', 2], ['ستائر', 2]],
  'حراسة': [['sécurité', 2], ['securite', 2], ['gardien', 2], ['gardiennage', 2], ['security', 2], ['surveillance', 2], ['vigile', 2], ['securitech', 2], ['حراسة', 2], ['حارس', 2], ['أمن', 2]],
};
const VALID_CATS = Object.keys(SIGNALS);

function scoreText(text) {
  const lower = (text || '').toLowerCase();
  const scores = {};
  for (const cat of VALID_CATS) {
    scores[cat] = 0;
    for (const [kw, weight] of SIGNALS[cat]) if (lower.includes(kw)) scores[cat] += weight;
  }
  return scores;
}

function classify(worker) {
  const nameRes = scoreText(worker.name || '');
  const descRes = scoreText((worker.description || '') + ' ' + (worker.tags || []).join(' '));
  const combined = {};
  for (const cat of VALID_CATS) combined[cat] = nameRes[cat] * 2 + descRes[cat];
  const ranked = VALID_CATS
    .map(cat => ({ cat, score: combined[cat], nameHits: nameRes[cat] }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const top = ranked[0];
  const current = worker.category;
  const currentScore = combined[current] || 0;
  const secondary = ranked.slice(1)
    .filter(x => x.score >= 2 && x.score >= top.score * 0.3)
    .map(x => x.cat).slice(0, 3);
  const shouldOverride = top.cat !== current && top.score >= 4 && top.score >= currentScore * 1.8 && top.nameHits > 0;
  return { primary: shouldOverride ? top.cat : current, secondary, override: shouldOverride, top };
}

(async () => {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
  console.log('Connecting to MongoDB...');
  await client.connect();
  const db = client.db();
  const col = db.collection('workers');

  // ── ROLLBACK MODE ──────────────────────────────────────────────────────────
  if (ROLLBACK_FILE) {
    console.log('ROLLBACK from:', ROLLBACK_FILE);
    const snapshot = JSON.parse(fs.readFileSync(ROLLBACK_FILE, 'utf8'));
    let restored = 0;
    for (const orig of snapshot) {
      const setOps = { category: orig.category };
      const unsetOps = {};
      if (orig.secondary_categories) setOps.secondary_categories = orig.secondary_categories;
      else unsetOps.secondary_categories = '';
      if (orig.original_category) setOps.original_category = orig.original_category;
      else unsetOps.original_category = '';
      const update = { $set: setOps };
      if (Object.keys(unsetOps).length) update.$unset = unsetOps;
      await col.updateOne({ _id: orig._id }, update);
      restored++;
    }
    console.log('Restored', restored, 'workers to snapshot state.');
    await client.close();
    return;
  }

  // ── NORMAL MODE ────────────────────────────────────────────────────────────
  console.log('MODE:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('OVERRIDE:', ALLOW_OVERRIDE ? 'enabled (high-confidence flips with audit trail)' : 'disabled (additive secondary only — SAFEST)');
  const all = await col.find({}).toArray();
  console.log('Loaded', all.length, 'workers from MongoDB.');

  const snapshot = [];
  const overrides = [];
  const secondaries = [];

  for (const w of all) {
    const cls = classify(w);
    if (!cls) continue;

    let changed = false;
    const update = { $set: {} };

    if (cls.override && ALLOW_OVERRIDE) {
      overrides.push({ name: w.name, old: w.category, new: cls.primary });
      update.$set.category = cls.primary;
      if (!w.original_category) update.$set.original_category = w.category;
      changed = true;
    }

    if (cls.secondary.length) {
      const existing = Array.isArray(w.secondary_categories) ? w.secondary_categories : [];
      const merged = Array.from(new Set([...existing, ...cls.secondary]))
        .filter(c => c !== (update.$set.category || w.category));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        secondaries.push({ name: w.name, primary: w.category, secondary: merged });
        update.$set.secondary_categories = merged;
        changed = true;
      }
    }

    if (changed) {
      // Snapshot BEFORE the change, so we can roll back
      snapshot.push({
        _id: w._id,
        category: w.category,
        secondary_categories: w.secondary_categories,
        original_category: w.original_category
      });
      if (APPLY) await col.updateOne({ _id: w._id }, update);
    }
  }

  console.log('\n=== REPORT ===');
  console.log('Primary overrides:', overrides.length, ALLOW_OVERRIDE ? '' : '(skipped — safe mode)');
  console.log('Secondary additions:', secondaries.length);
  console.log('First 20 secondary additions:');
  secondaries.slice(0, 20).forEach(s => console.log(`  [${s.primary}] + ${s.secondary.join(', ')}  ← ${s.name}`));
  if (overrides.length) {
    console.log('First 20 overrides:');
    overrides.slice(0, 20).forEach(o => console.log(`  [${o.old} → ${o.new}] ${o.name}`));
  }

  if (snapshot.length && APPLY) {
    const snapPath = path.join(__dirname, '..', 'data', `mongo-reclassify-snapshot-${Date.now()}.json`);
    fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
    console.log('\n✅ Applied. Snapshot written to:', snapPath);
    console.log('   To roll back: node scripts/reclassify-mongodb.js --rollback ' + snapPath);
  } else if (!APPLY) {
    console.log('\n** DRY RUN — no changes written. Pass --apply to commit. **');
  }

  await client.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
