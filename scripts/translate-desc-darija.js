#!/usr/bin/env node
/**
 * Translates all templated worker descriptions in data/workers.json
 * to authentic Moroccan Darija.
 *
 * SAFE: only changes descriptions that match known seeded templates.
 * Workers with truly custom descriptions (not matching any template) are left untouched.
 *
 * Usage:
 *   node scripts/translate-desc-darija.js          # apply
 *   node scripts/translate-desc-darija.js --dry    # preview only, no write
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'workers.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `workers.backup.darija.${Date.now()}.json`);
const DRY = process.argv.includes('--dry');

// ── Darija templates per category ─────────────────────────────────────────────
// Each entry: { starts: string[], darija: fn(city) => string }
// "starts" lists all known formal-Arabic prefixes for that category's template.
// We match desc.startsWith(prefix), grab whatever comes after "في " up to the separator,
// and replace the entire description with the Darija equivalent.

const TEMPLATES = [
  {
    // بناء — construction
    starts: ['أعمال بناء في '],
    darija: c => `بناء فـ${c} — البناء والليبسة والتصليح`,
  },
  {
    // بلومبي — plumbing
    starts: ['سباكة في '],
    darija: c => `بلومبي فـ${c} — تصليح التسريبات وتركيب الصنابر والحمامات`,
  },
  {
    // صباغة — painting
    starts: ['صباغة في '],
    darija: c => `صباغة فـ${c} — الداخل والخارج، التيلي والواجزيري`,
  },
  {
    // نجارة — carpentry
    starts: ['نجارة في '],
    darija: c => `نجارة فـ${c} — البيبان والشبابيك والأثاث عل التقديرة`,
  },
  {
    // ديكور — decoration
    starts: ['ديكور داخلي في '],
    darija: c => `ديكور داخلي فـ${c} — جبس، بلاط، وتزويق الصالونات`,
  },
  {
    // نقل — moving/transport
    starts: ['نقل عفش في '],
    darija: c => `نقل العفش فـ${c} — داخل المدينة وبين المدن`,
  },
  {
    // كلامبيستري — tiling/flooring
    starts: ['تركيب وإصلاح كلامبيستري في '],
    darija: c => `كلامبيستري فـ${c} — البلاط والزليج والرخام`,
  },
  {
    // خياطة — tailoring
    starts: ['خياطة وتعديل ملابس في '],
    darija: c => `خياطة فـ${c} — تخييط وتبديل الحوايج`,
  },
  {
    // حراسة — security/guarding
    starts: ['حراسة وأمن في '],
    darija: c => `حراسة وأمن فـ${c}`,
  },
  {
    // طريسيان — electrician (two variant prefixes in the seeded data)
    starts: ['خدمة كهرباء في ', 'كهربائي في '],
    darija: c => `طريسيان فـ${c} — تحويلات، تمديدات، وتصليح العطالات`,
  },
  {
    // نقاوة — cleaning
    starts: ['خدمة تنظيف في '],
    darija: c => `نقاوة فـ${c} — الشقق والفيلات والمكاتب`,
  },
  {
    // حدادة — metalwork/ironwork
    starts: ['حدادة في '],
    darija: c => `حدادة فـ${c} — الشبابيك وبيبان الحديد والدرابيز`,
  },
];

// Valid city names (prevents garbage appended to city from leaking in)
const VALID_CITIES = new Set([
  'طنجة', 'الدار البيضاء', 'عين الشق', 'عين السبع', 'أنفا', 'الحي الحسني',
  'الحي المحمدي', 'المحمدية', 'سيدي مومن', 'أكادير', 'إنزكان', 'آيت ملول',
  'تيزنيت', 'تارودانت', 'شتوكة آيت باها', 'مراكش', 'المحاميد', 'كيليز',
  'تمارة مراكش', 'المدينة القديمة', 'سيدي يوسف',
]);

/**
 * Extract the city from a description like:
 * "سباكة في طنجة — تصليح تسريب..."
 * Returns the city string or null if not extractable.
 */
function extractCity(desc, prefix) {
  // Everything after the prefix is "city — services" or "city\n" or "city."
  const rest = desc.slice(prefix.length); // e.g., "طنجة — تشييد، تيبسية، إصلاح"
  // Stop at em-dash, en-dash, hyphen-space, period, or end of string
  const cityRaw = rest.replace(/\s*[—–\-].*$|\s*\..*$/s, '').trim();

  // If the extracted "city" is a known valid city, use it directly
  if (VALID_CITIES.has(cityRaw)) return cityRaw;

  // If not a known city, it may have garbage appended (e.g., "عين الشق وينبيست كليماتازيشن").
  // Try to find the longest known-city prefix inside cityRaw
  let best = null;
  for (const c of VALID_CITIES) {
    if (cityRaw.startsWith(c) && (!best || c.length > best.length)) best = c;
  }
  return best || cityRaw; // fallback: use whatever we extracted
}

/**
 * Translate a single description string.
 * Returns the new Darija string, or null if no template matched.
 */
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
  return null; // no template matched → leave untouched
}

// ── Main ─────────────────────────────────────────────────────────────────────
const original = fs.readFileSync(DATA_PATH, 'utf8');
const workers = JSON.parse(original);

let translated = 0;
let unchanged = 0;
const changes = [];

for (const w of workers) {
  const newDesc = translate(w.description || '');
  if (newDesc && newDesc !== w.description) {
    if (changes.length < 20) {
      changes.push({ name: w.name, old: (w.description || '').slice(0, 80), new: newDesc });
    }
    w.description = newDesc;
    translated++;
  } else {
    unchanged++;
  }
}

console.log('=== DARIJA DESCRIPTION TRANSLATION ===');
console.log(`Total workers : ${workers.length}`);
console.log(`Translated    : ${translated}`);
console.log(`Unchanged     : ${unchanged}  (no template matched — likely custom or empty)`);
console.log('\nFirst 20 changes:');
changes.forEach(c => {
  console.log(`  [${c.name.slice(0,30)}]`);
  console.log(`    OLD: ${c.old}`);
  console.log(`    NEW: ${c.new}`);
});

if (DRY) {
  console.log('\n** DRY RUN — workers.json NOT modified. **');
  process.exit(0);
}

fs.writeFileSync(BACKUP_PATH, original);
console.log('\nBackup saved:', BACKUP_PATH);
fs.writeFileSync(DATA_PATH, JSON.stringify(workers, null, 2));
console.log('Updated:', DATA_PATH);
console.log('Done ✓');
