#!/usr/bin/env node
/**
 * Heuristic (no-AI) reclassifier for data/workers.json.
 *
 * SAFETY GUARANTEES (preserves real self-registered worker data):
 *  - NEVER deletes a worker
 *  - NEVER overwrites a primary category without saving the original to `original_category`
 *  - With `--add-secondary-only` flag: NEVER changes primary category at all (purely additive)
 *  - Always writes a backup of the original file before any change
 *  - Never destroys existing user-set secondary_categories — only adds, never removes
 *
 * Strategy:
 *  1. Score every worker against every category using keyword matches in name+description+tags.
 *  2. Only OVERRIDE the stored primary if BOTH name and description agree on a different category
 *     with high confidence (>= 4 score, > 1.8x current cat's score, name independently agrees).
 *  3. ADD secondary_categories whenever the worker has strong signals for ≥2 categories.
 *  4. Backup & write a diff report.
 *
 * Usage:
 *   node scripts/reclassify-heuristic.js                       # apply (override + secondary)
 *   node scripts/reclassify-heuristic.js --dry                 # preview only
 *   node scripts/reclassify-heuristic.js --add-secondary-only  # SAFEST: never touch primary
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'workers.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `workers.backup.${Date.now()}.json`);
const REPORT_PATH = path.join(__dirname, '..', 'data', `reclassify-report.${Date.now()}.json`);
const DRY_RUN = process.argv.includes('--dry');
const ADD_SECONDARY_ONLY = process.argv.includes('--add-secondary-only');

// Strong, unambiguous keywords per category. Multi-word phrases first (higher specificity).
// Each keyword scores 1; multi-word phrases score 2 (more specific).
const SIGNALS = {
  'بلومبي': [
    ['plomberie', 2], ['plombier', 2], ['plumber', 2], ['sanitaire', 2], ['chauffe-eau', 2], ['chauffe eau', 2],
    ['سباكة', 2], ['سباك', 2], ['بلومبي', 2], ['تسريب', 2], ['تيوبو', 1], ['بيبان', 1], ['صنبور', 2],
    ['robinet', 1], ['douche', 1], ['baignoire', 1], ['toilette', 1], ['fuite', 1], ['evacuation', 1], ['siphon', 1],
    ['plomb', 1], ['cumulus', 2], ['conduite', 1], ['canalisation', 2]
  ],
  'طريسيان': [
    ['électricien', 2], ['electricien', 2], ['électricité', 2], ['electricite', 2], ['electrical', 2], ['electrician', 2],
    ['كهرباء', 2], ['كهربائي', 2], ['طريسيان', 2], ['تريسيان', 2], ['تابلو كهربائي', 2],
    ['disjoncteur', 2], ['câblage', 2], ['cablage', 2], ['installation électrique', 2], ['climatiseur', 1], ['airzone', 2],
    ['interphone', 1], ['domotique', 2]
  ],
  'صباغة': [
    ['peinture', 2], ['peintre', 2], ['painter', 2], ['painting', 2],
    ['صباغة', 2], ['صباغ', 2], ['دهان', 2], ['تصبيغ', 2],
    ['enduit', 1], ['ravalement', 2], ['façade', 1], ['crépi', 2], ['crepi', 2]
  ],
  'نجارة': [
    ['menuiserie', 2], ['menuisier', 2], ['carpenter', 2], ['carpentry', 2], ['ébéniste', 2], ['ebeniste', 2],
    ['نجارة', 2], ['نجار', 2], ['خشب', 2], ['باركي', 2],
    ['parquet', 2], ['placard', 1], ['armoire', 1], ['bois', 1], ['cuisine bois', 2], ['porte bois', 2],
    ['fenêtre bois', 2], ['fenetre bois', 2]
  ],
  'بناء': [
    ['maçon', 2], ['macon', 2], ['maçonnerie', 2], ['maconnerie', 2], ['construction', 2], ['btp', 2], ['gros oeuvre', 2], ['gros œuvre', 2],
    ['بناء', 2], ['تشييد', 2], ['ترميم', 2], ['تيبسية', 2], ['خرسانة', 2],
    ['béton', 1], ['beton', 1], ['fissure', 1], ['démolition', 2], ['demolition', 2], ['fondation', 2]
  ],
  'نقاوة': [
    ['nettoyage', 2], ['ménage', 2], ['femme de menage', 2], ['femme de ménage', 2], ['cleaning', 2],
    ['نقاوة', 2], ['تنظيف', 2], ['نضافة', 2],
    ['désinfection', 2], ['desinfection', 2], ['lavage', 1], ['nounou', 2]
  ],
  'حدادة': [
    ['ferronnerie', 2], ['serrurier', 2], ['serrurerie', 2], ['soudeur', 2], ['soudure', 2], ['inox', 2],
    ['حدادة', 2], ['حداد', 2], ['سودور', 2],
    ['fer forgé', 2], ['fer forge', 2], ['portail', 2], ['grille', 1], ['métallique', 1], ['metallique', 1],
    ['construction métallique', 2], ['aluminium', 2], ['ألومنيوم', 2], ['شباك حديد', 2], ['شبابيك حديد', 2],
    ['شبابيك ألومنيوم', 2], ['شباك ألومنيوم', 2], ['menuiserie aluminium', 2], ['menuiserie alu', 2],
    ['façade aluminium', 2], ['mur rideau', 2]
  ],
  'ديكور': [
    ['décoration', 2], ['decoration', 2], ['décorateur', 2], ['decorateur', 2], ['design intérieur', 2], ['interior design', 2],
    ['faux plafond', 2], ['plâtre', 2], ['platre', 2], ['gypse', 2], ['placo', 2], ['placoplâtre', 2],
    ['ديكور', 2], ['جبس', 2], ['تصميم داخلي', 2], ['ورق الحيطان', 2],
    ['aménagement', 2], ['amenagement', 2], ['papier peint', 2]
  ],
  'نقل': [
    ['déménagement', 2], ['demenagement', 2], ['déménageur', 2], ['demenageur', 2], ['transport', 2], ['moving', 2],
    ['نقل', 2], ['نقل العفش', 2], ['تحويل العفش', 2], ['شاحنة', 2],
    ['camion', 1], ['livraison', 1], ['delivery', 1]
  ],
  'كلامبيستري': [
    ['carrelage', 2], ['carreleur', 2], ['zellige', 2], ['faïence', 2], ['faience', 2], ['marbre', 2], ['mosaïque', 2],
    ['كلامبيستري', 2], ['زليج', 2], ['بلاط', 2], ['تبليط', 2], ['رخام', 2], ['فايانس', 2],
    ['pose carrelage', 2], ['revêtement de sol', 2], ['revetement de sol', 2], ['floor', 1]
  ],
  'خياطة': [
    ['couture', 2], ['couturier', 2], ['couturière', 2], ['couturiere', 2], ['tailor', 2], ['tailleur', 2], ['retouche', 2],
    ['خياطة', 2], ['خياط', 2], ['قفطان', 2], ['جلابة', 2],
    ['rideaux', 2], ['rideau', 2], ['tapisserie', 2], ['ستائر', 2]
  ],
  'حراسة': [
    ['sécurité', 2], ['securite', 2], ['gardien', 2], ['gardiennage', 2], ['security', 2], ['surveillance', 2], ['vigile', 2], ['securitech', 2],
    ['حراسة', 2], ['حارس', 2], ['أمن', 2]
  ],
};

const VALID_CATS = Object.keys(SIGNALS);

function scoreText(text) {
  const lower = (text || '').toLowerCase();
  const scores = {};
  const matched = {};
  for (const cat of VALID_CATS) {
    scores[cat] = 0;
    matched[cat] = [];
    for (const [kw, weight] of SIGNALS[cat]) {
      if (lower.includes(kw)) {
        scores[cat] += weight;
        matched[cat].push(kw);
      }
    }
  }
  return { scores, matched };
}

function classify(worker) {
  const nameTxt = worker.name || '';
  const descTxt = (worker.description || '') + ' ' + (worker.tags || []).join(' ');

  const nameRes = scoreText(nameTxt);
  const descRes = scoreText(descTxt);

  // Combined score weights NAME more heavily — names are more reliable trade indicators
  const combined = {};
  for (const cat of VALID_CATS) combined[cat] = nameRes.scores[cat] * 2 + descRes.scores[cat];

  // Sorted strongest-first
  const ranked = VALID_CATS
    .map(cat => ({ cat, score: combined[cat], nameHits: nameRes.scores[cat], descHits: descRes.scores[cat] }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;

  const top = ranked[0];
  const current = worker.category;
  const currentScore = combined[current] || 0;

  // Build secondary_categories: any other category with score >= 2 AND >= 30% of top score
  const secondary = ranked.slice(1)
    .filter(x => x.cat !== top.cat && x.score >= 2 && x.score >= top.score * 0.3)
    .map(x => x.cat)
    .slice(0, 3);

  // Decide whether to OVERRIDE current category:
  // - top.cat must differ from current
  // - top must score at least 4 (strong signal)
  // - top must beat current by >= 1.8x AND name independently agrees with top
  const shouldOverride = top.cat !== current
    && top.score >= 4
    && top.score >= currentScore * 1.8
    && top.nameHits > 0;  // name must point to the new cat

  const newPrimary = shouldOverride ? top.cat : current;
  // Make sure the kept primary is not also in secondary list
  const finalSecondary = secondary.filter(c => c !== newPrimary);

  return { primary: newPrimary, secondary: finalSecondary, override: shouldOverride, top, currentScore };
}

const original = fs.readFileSync(DATA_PATH, 'utf8');
const workers = JSON.parse(original);

let overrides = 0, withSecondary = 0, noSignal = 0;
const overrideList = [], secondaryList = [];

for (const w of workers) {
  const cls = classify(w);
  if (!cls) { noSignal++; continue; }

  // Override primary — only if not in safe additive mode
  if (cls.override && !ADD_SECONDARY_ONLY) {
    overrideList.push({ name: w.name, city: w.city, old: w.category, new: cls.primary, score: cls.top.score });
    // AUDIT TRAIL: preserve original category so the change is reversible
    if (!w.original_category) w.original_category = w.category;
    w.category = cls.primary;
    overrides++;
  }

  // Merge secondary categories — UNION with anything the user/system already set, never destructive
  if (cls.secondary.length) {
    const existing = Array.isArray(w.secondary_categories) ? w.secondary_categories : [];
    const merged = Array.from(new Set([...existing, ...cls.secondary])).filter(c => c !== w.category);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      secondaryList.push({ name: w.name, primary: w.category, secondary: merged });
      w.secondary_categories = merged;
      withSecondary++;
    }
  }
  // NEVER remove existing secondary_categories — they may have been set by the user or AI at registration
}

const newCounts = {};
const secCounts = {};
for (const w of workers) {
  newCounts[w.category] = (newCounts[w.category] || 0) + 1;
  if (w.secondary_categories) {
    for (const s of w.secondary_categories) secCounts[s] = (secCounts[s] || 0) + 1;
  }
}

console.log('=== HEURISTIC RECLASSIFY ===');
console.log('Mode:', ADD_SECONDARY_ONLY ? 'ADD-SECONDARY-ONLY (primary untouched)' : 'OVERRIDE+SECONDARY');
console.log('Total workers:', workers.length);
console.log('Workers with no keyword signal at all:', noSignal);
console.log('Primary category overrides:', overrides, ADD_SECONDARY_ONLY ? '(skipped — safe mode)' : '(originals preserved in original_category)');
console.log('Workers gained secondary categories:', withSecondary);
console.log('\n--- First 30 overrides ---');
overrideList.slice(0, 30).forEach(o => console.log(`  [${o.old} → ${o.new}] (score=${o.score}) ${o.name} (${o.city})`));
console.log('\n--- First 25 secondary additions ---');
secondaryList.slice(0, 25).forEach(s => console.log(`  [${s.primary}] + ${s.secondary.join(', ')}  ← ${s.name}`));
console.log('\n--- New primary counts ---');
Object.entries(newCounts).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
console.log('\n--- Secondary appearances (extra "showings" per category pill) ---');
Object.entries(secCounts).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  +${c}: ${n}`));

fs.writeFileSync(REPORT_PATH, JSON.stringify({
  overrides: overrideList,
  secondaries: secondaryList,
  newCounts,
  secCounts
}, null, 2));
console.log('\nReport:', REPORT_PATH);

if (DRY_RUN) {
  console.log('\nDRY RUN — workers.json NOT modified.');
} else {
  fs.writeFileSync(BACKUP_PATH, original);
  console.log('Backup:', BACKUP_PATH);
  fs.writeFileSync(DATA_PATH, JSON.stringify(workers, null, 2));
  console.log('Updated:', DATA_PATH);
}
