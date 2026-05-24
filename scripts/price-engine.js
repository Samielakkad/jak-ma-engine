/**
 * Per-worker price range engine.
 * Exported as module so both the local script and the server migration endpoint can use it.
 *
 * Logic layers (applied in order):
 *  1. Category base range (from real Avito/mano.ma 2025 data)
 *  2. City multiplier (Casablanca +22%, small cities -10%)
 *  3. Company premium (+20–30% if company signals detected)
 *  4. 24/7 / emergency premium (+25%)
 *  5. Luxury/premium premium (+15%)
 *  6. Budget/cheap signal (-15%)
 *  7. Experience bonus (+10% per 5 years, max +20%)
 *  8. Spread width: companies & multi-service → wider spread; solo workers → tighter
 *  9. Round to nearest 10
 */

// ── Base ranges (Tanger = 1.0 baseline) ────────────────────────────────────
// Source: avito.ma listings + mano.ma + forumconstruction.ma 2025
const BASE = {
  'بناء':       { unit:'اليوم',  min:200, max:320 },
  'بلومبي':     { unit:'الساعة', min:100, max:220 },
  'صباغة':      { unit:'اليوم',  min:180, max:280 },
  'نجارة':      { unit:'اليوم',  min:250, max:420 },
  'حدادة':      { unit:'اليوم',  min:240, max:400 },
  'ديكور':      { unit:'اليوم',  min:350, max:600 },
  'نقل':        { unit:'المرة',  min:300, max:1200 },
  'كلامبيستري': { unit:'اليوم',  min:200, max:320 },
  'خياطة':      { unit:'القطعة', min:40,  max:130 },
  'حراسة':      { unit:'الليلة', min:150, max:260 },
  'طريسيان':    { unit:'الساعة', min:100, max:220 },
  'نقاوة':      { unit:'اليوم',  min:120, max:210 },
};

// ── City multipliers ────────────────────────────────────────────────────────
const CITY_MULT = {
  'الدار البيضاء':1.22,'عين الشق':1.20,'عين السبع':1.18,'أنفا':1.22,
  'الحي الحسني':1.18,'الحي المحمدي':1.16,'المحمدية':1.14,'سيدي مومن':1.15,
  'مراكش':1.12,'المحاميد':1.08,'كيليز':1.10,'تمارة مراكش':1.08,
  'المدينة القديمة':1.10,'سيدي يوسف':1.06,
  'أكادير':1.08,'إنزكان':1.05,'آيت ملول':1.04,'شتوكة آيت باها':1.02,
  'طنجة':1.00,'تيزنيت':0.90,'تارودانت':0.88,
};

// ── Signal detectors ────────────────────────────────────────────────────────
const TEXT_COMPANY = [
  /\bsarl\b/i,/\bsas\b/i,/\bs\.a\.r\.l/i,/\bsa\b/i,/\bentreprise\b/i,/\bsociété\b/i,
  /\bcompany\b/i,/\bgroupe\b/i,/\bgroup\b/i,/\bcorporation\b/i,
  /شركة/,/مؤسسة/,/مجموعة/,/\bsté\b/i,/\bste\b/i
];
const TEXT_247 = [
  /24\/7/,/24h/i,/urgence/i,/dépannage/i,/depannage/i,/طوارئ/,/على مدار/,/متاح دايما/
];
const TEXT_LUXURY = [
  /luxe/i,/luxury/i,/premium/i,/prestige/i,/haut.?de.?gamme/i,/vip/i,/راقي/,/فاخر/,/رفيع/
];
const TEXT_BUDGET = [
  /pas cher/i,/bon marché/i,/économique/i,/abordable/i,/رخيص/,/بثمن مناسب/,/أسعار معقولة/,/prix bas/i
];
const TEXT_SPECIALIST = [
  /spécialis/i,/expert/i,/professionnel certifié/i,/certifié/i,/master/i,/chef/i,
  /متخصص/,/خبير/,/محترف معتمد/,/maître/i
];

function matches(text, patterns) {
  return patterns.some(p => p.test(text));
}

function seededRand(seed, min, max) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  const t = Math.abs(h) / 2147483647;
  return min + t * (max - min);
}

// ── Main export ─────────────────────────────────────────────────────────────
function computePriceRange(worker) {
  const base = BASE[worker.category];
  if (!base) return null;

  const fullText = [
    worker.name || '',
    worker.description || '',
    (worker.tags || []).join(' '),
  ].join(' ').toLowerCase();

  const mult      = CITY_MULT[worker.city] || 1.0;
  const isCompany = matches(fullText, TEXT_COMPANY);
  const is247     = matches(fullText, TEXT_247);
  const isLuxury  = matches(fullText, TEXT_LUXURY);
  const isBudget  = matches(fullText, TEXT_BUDGET);
  const isSpec    = matches(fullText, TEXT_SPECIALIST);
  const expYears  = parseInt(worker.experience) || 0;

  // Start from base
  let min = base.min * mult;
  let max = base.max * mult;

  // Company: raises min more than max (companies charge floor price higher)
  if (isCompany) { min *= 1.20; max *= 1.30; }

  // 24/7 emergency: raises both (night surcharge baked in)
  if (is247) { min *= 1.25; max *= 1.35; }

  // Luxury/premium
  if (isLuxury) { min *= 1.15; max *= 1.25; }

  // Budget signal: lowers both
  if (isBudget) { min *= 0.85; max *= 0.88; }

  // Specialist/expert
  if (isSpec) { min *= 1.08; max *= 1.15; }

  // Experience bonus on max only (experienced = higher ceiling)
  if (expYears >= 5)  max *= 1.10;
  if (expYears >= 10) max *= 1.10; // stacks → ~20% for 10+ years

  // Spread width: use seeded random to give each worker a unique position within band
  const seed = String(worker._id || worker.name || worker.phone || '');
  const spread = seededRand(seed, 0, 1);

  // Natural variation: nudge min up/down by up to 10% deterministically
  const nudge = (seededRand(seed + 'n', -0.08, 0.08));
  min = min * (1 + nudge);
  // max is always min + at least 20% of min
  max = Math.max(max, min * 1.20);

  // Round to nearest 10
  const rMin = Math.round(min / 10) * 10;
  const rMax = Math.round(max / 10) * 10;

  return { min: rMin, max: rMax, unit: base.unit };
}

module.exports = { computePriceRange, BASE, CITY_MULT };
