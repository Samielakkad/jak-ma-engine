#!/usr/bin/env node
/**
 * One-time batch reclassifier for data/workers.json
 *
 * For each worker, asks Claude Haiku to determine:
 *   - primary category (must be one of the 12 valid trades)
 *   - secondary categories (for multi-trade businesses)
 *
 * Runs in batches of 20 to keep token use low.
 * Writes a backup to data/workers.backup.json before overwriting.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx node scripts/reclassify-workers.js          # full run
 *   ANTHROPIC_API_KEY=xxx node scripts/reclassify-workers.js --dry    # preview only, no write
 *   ANTHROPIC_API_KEY=xxx node scripts/reclassify-workers.js --limit 50  # process first 50 only
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const VALID_CATS = [
  'بلومبي', 'طريسيان', 'صباغة', 'نجارة', 'بناء', 'نقاوة',
  'حدادة', 'ديكور', 'نقل', 'كلامبيستري', 'خياطة', 'حراسة'
];

const BATCH_SIZE = 20;
const SLEEP_MS = 600; // pace requests so we never trip rate limits

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

const DATA_PATH = path.join(__dirname, '..', 'data', 'workers.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `workers.backup.${Date.now()}.json`);
const REPORT_PATH = path.join(__dirname, '..', 'data', `reclassify-report.${Date.now()}.json`);

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY missing. Set it in .env or env var.');
  process.exit(1);
}

const ANTHROPIC_MODEL   = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function classifyBatch(batch) {
  const prompt = `نتا غادي تصنف ليا ${batch.length} ديال المعلمين. لكل واحد قول ليا:
- "primary": نوع الخدمة الكبير (واحد بصاح من اللائحة)
- "secondary": ليستة فيها أنواع زايدة إيلا كان المعلم كيدير كتر من خدمة (خليها [] إيلا غير وحدة)

اللائحة المسموحة (ما تخرجش منها): ${VALID_CATS.join('، ')}

قواعد خاصك تتبعها:
- "Plomberie Electricité" → primary هو اللي بان كتر فالسمية، الآخر دير فsecondary
- "Société de nettoyage et peinture" → primary حسب اللي بان كتر فالسمية، الآخر فsecondary
- "Design / Décoration" فالسمية → غالبا ديكور، إلا إيلا الوصف قال شي حاجة أخرى (مثلا Floor Design = كلامبيستري حيت عاد بلاط)
- شبابك ألومنيوم ولا حديد → حدادة. شبابك ديال الخشب → نجارة
- "Déménagement" → نقل (ماشي نقاوة، حيت كلمة "ménage" دخلات بالغلط)
- "Sécurité" → حراسة. "Nettoyage/Ménage" → نقاوة
- "Tableau électrique" → طريسيان
- "Faux plafond / Gypse / Plâtre" → ديكور
- "Carrelage / Zellige / Faïence / Marbre" → كلامبيستري
- "Serrurerie / Ferronnerie / Inox" → حدادة
- "Plomberie / Sanitaire / Chauffe-eau" → بلومبي

رجع JSON array بصاح (بلا شرح، بلا markdown). كل واحد فيه: {"i": index, "primary": "...", "secondary": [...]}.

المعلمين:
${batch.map((w, i) => `${i}: name="${(w.name || '').slice(0, 100)}" desc="${(w.description || '').slice(0, 150)}" tags=${JSON.stringify(w.tags || [])}`).join('\n')}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      temperature: 0,
      system: 'Respond with valid JSON only. No prose, no markdown fences, no commentary.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Anthropic API ${r.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
  // Strip code fences if model still wrapped them despite system instruction
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('Bad JSON from model:', clean.slice(0, 300));
    throw e;
  }
  if (!Array.isArray(parsed)) throw new Error('Model did not return an array');
  return parsed;
}

function validateClass(c) {
  if (!c || typeof c !== 'object') return null;
  const primary = VALID_CATS.includes(c.primary) ? c.primary : null;
  if (!primary) return null;
  const secondary = Array.isArray(c.secondary)
    ? c.secondary.filter(x => VALID_CATS.includes(x) && x !== primary)
    : [];
  return { primary, secondary };
}

(async () => {
  console.log('Reading', DATA_PATH);
  const original = fs.readFileSync(DATA_PATH, 'utf8');
  const workers = JSON.parse(original);
  console.log('Loaded', workers.length, 'workers');

  const target = LIMIT ? workers.slice(0, LIMIT) : workers;
  console.log(`Will classify ${target.length} workers in batches of ${BATCH_SIZE}`);
  console.log(DRY_RUN ? '** DRY RUN — no writes **' : '** WILL OVERWRITE workers.json **');

  const batches = chunks(target, BATCH_SIZE);
  const changes = [];
  const addedSecondary = [];
  let processed = 0;
  let failed = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    process.stdout.write(`Batch ${bi + 1}/${batches.length} (${processed}/${target.length})... `);
    let parsed = null;
    // Retry up to 3 times with exponential backoff for transient 4xx/5xx
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        parsed = await classifyBatch(batch);
        break;
      } catch (e) {
        const wait = SLEEP_MS * Math.pow(3, attempt);
        process.stdout.write(`(attempt ${attempt} failed: ${e.message.slice(0, 60)}, waiting ${wait}ms) `);
        await sleep(wait);
      }
    }
    if (!parsed) {
      console.log('FAILED after 3 attempts.');
      failed += batch.length;
      continue;
    }

    for (const item of parsed) {
      const i = typeof item.i === 'number' ? item.i : parseInt(item.i, 10);
      if (!Number.isInteger(i) || i < 0 || i >= batch.length) continue;
      const worker = batch[i];
      const cls = validateClass(item);
      if (!cls) continue;

      const oldCat = worker.category;
      const oldSec = JSON.stringify(worker.secondary_categories || []);
      const newSec = JSON.stringify(cls.secondary);

      if (cls.primary !== oldCat) {
        changes.push({
          name: worker.name,
          city: worker.city,
          old: oldCat,
          new: cls.primary,
          secondary: cls.secondary
        });
        worker.category = cls.primary;
      }
      if (cls.secondary.length && newSec !== oldSec) {
        worker.secondary_categories = cls.secondary;
        addedSecondary.push({
          name: worker.name,
          primary: cls.primary,
          secondary: cls.secondary
        });
      } else if (cls.secondary.length === 0 && worker.secondary_categories) {
        delete worker.secondary_categories;
      }
    }
    processed += batch.length;
    console.log('done.');
    await sleep(SLEEP_MS);
  }

  console.log('\n=== REPORT ===');
  console.log('Processed:', processed);
  console.log('Failed:', failed);
  console.log('Primary category changes:', changes.length);
  console.log('Workers given secondary categories:', addedSecondary.length);
  console.log('\nFirst 30 primary changes:');
  changes.slice(0, 30).forEach(c => {
    console.log(`  [${c.old} → ${c.new}] ${c.name} (${c.city})${c.secondary.length ? ` +secondary: ${c.secondary.join(',')}` : ''}`);
  });
  console.log('\nFirst 15 multi-trade additions:');
  addedSecondary.slice(0, 15).forEach(a => {
    console.log(`  [${a.primary} + ${a.secondary.join(',')}] ${a.name}`);
  });

  // Per-category counts
  const counts = {};
  workers.forEach(w => { counts[w.category] = (counts[w.category] || 0) + 1; });
  console.log('\nPost-reclassification counts:');
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  fs.writeFileSync(REPORT_PATH, JSON.stringify({
    processed, failed,
    primaryChanges: changes,
    secondaryAdditions: addedSecondary,
    finalCounts: counts
  }, null, 2));
  console.log('\nFull report:', REPORT_PATH);

  if (DRY_RUN) {
    console.log('\nDRY RUN — workers.json NOT modified.');
    return;
  }

  fs.writeFileSync(BACKUP_PATH, original);
  console.log('Backup:', BACKUP_PATH);
  fs.writeFileSync(DATA_PATH, JSON.stringify(workers, null, 2));
  console.log('Updated:', DATA_PATH);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
