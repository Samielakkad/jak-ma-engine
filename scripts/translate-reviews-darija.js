#!/usr/bin/env node
/**
 * Translates all worker reviews in data/workers.json to authentic Moroccan Darija.
 *
 * Uses a comprehensive rule-based approach:
 *  1. Exact-match replacements for the most common seeded review texts
 *  2. Phrase-level substitutions (longest-first to avoid partial collisions)
 *  3. Franco-Darija word conversions
 *
 * SAFE: Reviews that are already mostly in Darija or very short are left untouched
 *       if no rule matches. No API dependency.
 *
 * Usage:
 *   node scripts/translate-reviews-darija.js        # apply
 *   node scripts/translate-reviews-darija.js --dry  # preview, no write
 */

const fs   = require('fs');
const path = require('path');

const DATA_PATH   = path.join(__dirname, '..', 'data', 'workers.json');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `workers.backup.reviews.${Date.now()}.json`);
const DRY         = process.argv.includes('--dry');

// ─── 1. EXACT full-text replacements ─────────────────────────────────────────
// Ordered by frequency. If the entire review text matches, replace wholesale.
const EXACT = {
  'ممتاز':                             'واعر',
  'خدمة ممتازة':                       'خدمة واعرة',
  'خدمة ممتازة!':                      'خدمة واعرة!',
  'خدمة ممتازة.':                      'خدمة واعرة.',
  'خدمة ممتازة جدا':                   'خدمة واعرة بزاف',
  'خدمة ممتازة. منتجات عالية الجودة.': 'خدمة واعرة. المنتجات بجودة عالية.',
  'خدمة ممتازة بالتوفيق':              'خدمة واعرة، ربي يوفق',
  'خدمات ممتازة':                      'خدمات واعرة',
  'خدمة جيدة':                         'خدمة مزيانة',
  'خدمة جيدة 👍':                      'خدمة مزيانة 👍',
  'خدمة بون':                          'خدمة مزيانة',
  'خدمة في المستوى':                   'الخدمة فالمستوى',
  'خدمة بون 👍':                       'خدمة مزيانة 👍',
  'أحسنت':                             'أحسنت واللهي',
  'عمل ممتاز':                         'خدمة واعرة',
  'عملك ممتاز':                        'خدمتك واعرة',
  'عمل جيد':                           'خدمة مزيانة',
  'عمل جيد 👍':                        'خدمة مزيانة 👍',
  'عمل رائع':                          'خدمة واعرة',
  'عمل متقن':                          'خدمة متقنة',
  'احترافي':                            'محترف بزاف',
  'أنصح به بشدة':                      'ننصح بيه بزاف',
  'جيد جدا':                            'مزيان بزاف',
  'جيد جدًا':                           'مزيان بزاف',
  'على ما يرام':                        'مزيان',
  'أفضل خدمة':                         'أحسن خدمة',
  'بالتوفيق':                           'ربي يوفق',
  'جميل جدا':                           'زوين بزاف',
  'جميلة':                              'زوينة',
  'حظ سعيد':                            'ربي يوفق',
  'مرحبا':                              'أهلاً',
  'مرحبًا':                             'أهلاً',
  'متوسط':                              'عادي',
  '👍👍👍':                             '👍👍👍',
  'ممتاز 👍':                           'واعر 👍',
  'ممتازة':                             'واعرة',
  'تجربة جيدة':                         'تجربة مزيانة',
  'تجربة ممتازة':                       'تجربة واعرة',
  'محترف للغاية':                       'محترف بزاف',
  'لا بأس بها':                         'مشكاش',
  'ليس سيئًا':                          'مشكاش',
  'تبارك الله عليكم':                   'تبارك الله عليكم',
  'الخدمة رائعة':                       'الخدمة واعرة',
  'في المستوى':                         'فالمستوى',
  'الجودة والإتقان':                    'جودة وإتقان',
  'الاحترافية في العمل و الدقة في الإنجاز': 'احترافية فالخدمة ودقة فالإنجاز',
  'جودة عالية':                         'جودة عالية',
  'جودة وخدمة ممتازة':                  'جودة وخدمة واعرة',
  'اثمنة جد مناسبة':                    'الثمن مناسب بزاف',
  'لطيف - جيد':                         'لطيف — مزيان',
  'الافضل':                             'الأحسن',
  'الأفضل':                             'الأحسن',
  'شكراً جزيلا':                        'شكراً بزاف',
  'شكرا جزيلا':                         'شكراً بزاف',
  'شكراً 🥰❤️':                         'شكراً بزاف 🥰❤️',
  'تحياتي لكم جميعا ♥️':               'تحيات للجميع ♥️',
  'إنه رائع':                           'واعر',
  'très bon rapport qualité prix':      'التمن مناسب للجودة',
  'مكان جيد':                           'بلاصة مزيانة',
  'مكان جميل':                          'بلاصة زوينة',
  'مكان وصالة عرض جيدة لعرض الأعمال واللوحات الفنية': 'بلاصة مزيانة وصالة عرض زوينة للأعمال الفنية',
  'استقبل جميل':                        'استقبال زوين',
  'العمل':                              'الخدمة',
  'سلام عليكم':                         'السلام عليكم',
  'السلام عليكم':                       'السلام عليكم',
  'Lah yi3tik saha professional':       'الله يعطيك الصحة، محترف',
  'Khdma nqia lay 3tik saha':           'خدمة نقية، الله يعطيك الصحة',
  'Ahsan me3alem haliyan mo3amala tooop': 'أحسن معلم دابا، المعاملة توب',
  'Saraha mo3amala mezyana kaliti wa3ra': 'صراحة معاملة مزيانة وكاليتي واعرة',
  'Khedma mt9ona , chokran':            'خدمة متقنة، شكراً',
  'Had tajrib khas ta3ch  maxi hi tawsf osffi wa3r bazf': 'هاد التجربة خاصها تتعاش، ما فيها وصف — واعرة بزاف',
  'Tahiyati 3izi':                      'تحياتي عزيزي',
  'Tbarkelah 3lik si bilal 👍':         'تبارك الله عليك سي بلال 👍',
  'Kol avis b account':                 'كل ريفيو بحساب',
  'Tanger':                             'طنجة',
};

// ─── 2. PHRASE substitutions (applied to longer texts) ────────────────────────
// Ordered longest-first so more specific phrases replace before short ones.
const PHRASES = [
  // Darija-ify strong recommendation phrases
  ['أنصح بها بشدة',         'ننصح بيها بزاف'],
  ['أنصح بهم بشدة',         'ننصح بيهم بزاف'],
  ['أنصح به بشدة',          'ننصح بيه بزاف'],
  ['أوصي بها بشدة',         'ننصح بيها بزاف'],
  ['أوصي بهم بشدة',         'ننصح بيهم بزاف'],
  ['أوصي به بشدة',          'ننصح بيه بزاف'],
  ['أنصح به',               'ننصح بيه'],
  ['أنصح بهم',              'ننصح بيهم'],
  ['أنصح بها',              'ننصح بيها'],
  ['أوصي به',               'ننصح بيه'],
  ['أوصي بهم',              'ننصح بيهم'],
  ['أوصي بها',              'ننصح بيها'],
  ['ننصح به',               'ننصح بيه'],
  ['ننصح بهم',              'ننصح بيهم'],
  ['ننصح بها',              'ننصح بيها'],
  ['نوصي به',               'ننصح بيه'],
  ['نوصي بهم',              'ننصح بيهم'],
  ['نوصي بها',              'ننصح بيها'],

  // Intensity adverbs
  ['للغاية',                'بزاف'],
  ['جداً',                  'بزاف'],
  ['جدًا',                  'بزاف'],
  ['جدا',                   'بزاف'],
  ['بشدة',                  'بزاف'],
  ['كثيراً',                'بزاف'],
  ['كثيرا',                 'بزاف'],

  // Quality words
  ['ممتاز جداً',            'واعر بزاف'],
  ['ممتاز جدا',             'واعر بزاف'],
  ['ممتازة جداً',           'واعرة بزاف'],
  ['ممتازة جدا',            'واعرة بزاف'],
  ['ممتاز',                 'واعر'],
  ['ممتازة',                'واعرة'],
  ['رائع جداً',             'واعر بزاف'],
  ['رائعة جداً',            'واعرة بزاف'],
  ['رائع',                  'واعر'],
  ['رائعة',                 'واعرة'],
  ['متميز',                 'واعر'],
  ['متميزة',                'واعرة'],
  ['استثنائي',              'واعر'],
  ['استثنائية',             'واعرة'],
  ['جيد جداً',              'مزيان بزاف'],
  ['جيد جدا',               'مزيان بزاف'],
  ['جيدة جداً',             'مزيانة بزاف'],
  ['جيدة جدا',              'مزيانة بزاف'],
  ['جيد',                   'مزيان'],
  ['جيدة',                  'مزيانة'],
  ['رديئة',                 'مريضة'],
  ['سيء',                   'مريض'],

  // Work/service terms
  ['عمل ممتاز',             'خدمة واعرة'],
  ['عمل رائع',              'خدمة واعرة'],
  ['عمل جيد',               'خدمة مزيانة'],
  ['عمل متقن',              'خدمة متقنة'],
  ['عمل احترافي',           'خدمة احترافية'],
  ['خدمة ممتازة',           'خدمة واعرة'],
  ['خدمة رائعة',            'خدمة واعرة'],
  ['خدمة جيدة',             'خدمة مزيانة'],
  ['خدمة ودودة',            'خدمة لطيفة'],
  ['خدمة فعّالة',           'خدمة فعّالة'],
  ['خدمة مرضية',            'خدمة مرضية'],

  // Schedule/time
  ['ملتزمون بالمواعيد',     'مجاوبين على الوقت'],
  ['ملتزم بالمواعيد',       'مجاوب على الوقت'],
  ['ملتزمة بالمواعيد',      'مجاوبة على الوقت'],
  ['في الوقت المحدد',       'مجاوب على الوقت'],
  ['في الوقت المناسب',      'فالوقت المناسب'],
  ['الموعد النهائي',        'الأجل المحدد'],

  // Clients
  ['العملاء',               'الزبناء'],
  ['عملائنا',               'زبناؤنا'],
  ['عملاء',                 'زبناء'],

  // Pronoun this
  ['هذا',                   'هاد'],
  ['هذه',                   'هادي'],
  ['هؤلاء',                 'هادوك'],

  // Worth / recommend
  ['يستحق الثناء',          'يستاهل المدح'],
  ['تستحق الثناء',          'تستاهل المدح'],
  ['يستحق',                 'يستاهل'],
  ['تستحق',                 'تستاهل'],

  // Thanks
  ['شكراً جزيلاً',          'شكراً بزاف'],
  ['شكرا جزيلا',            'شكراً بزاف'],
  ['شكراً جزيلا',           'شكراً بزاف'],
  ['شكرًا جزيلًا',          'شكراً بزاف'],
  // Best
  ['الأفضل',                'الأحسن'],
  ['أفضل',                  'أحسن'],

  // Good luck
  ['بالتوفيق',              'ربي يوفق'],
  ['حظ سعيد',               'ربي يوفق'],

  // مكان / place
  ['مكان جميل',             'بلاصة زوينة'],
  ['مكان جيد',              'بلاصة مزيانة'],
  ['مكان',                  'بلاصة'],

  // Price value
  ['قيمة جيدة مقابل المال', 'التمن مناسب للخدمة'],
  ['قيمة ممتازة مقابل المال','التمن واعر للخدمة'],
  ['سعر معقول',             'الثمن معقول'],
  ['أسعار معقولة',          'الأثمان معقولة'],

  // Professional
  ['محترفون للغاية',        'محترفين بزاف'],
  ['محترفة للغاية',         'محترفة بزاف'],
  ['محترف للغاية',          'محترف بزاف'],
  ['احترافي',               'محترف'],
  ['احترافية',              'احترافية'],

  // Very
  ['للغاية',                'بزاف'],

  // Franco-Darija word tokens
  ['tooop',                 'توب'],
  ['TOP',                   'توب'],
  ['top',                   'توب'],
  ['wa3r',                  'واعر'],
  ['wa3ra',                 'واعرة'],
  ['mzyan',                 'مزيان'],
  ['mzyana',                'مزيانة'],
  ['mzien',                 'مزيان'],
  ['mzian',                 'مزيان'],
  ['bzaf',                  'بزاف'],
  ['bzzaf',                 'بزاف'],
  ['3jbni',                 'عجبني'],
  ['3jab',                  'عجب'],
  ['saha',                  'صحة'],
  ['lah y3tik',             'الله يعطيك'],
  ['lah yi3tik',            'الله يعطيك'],
  ['Lah y3tik',             'الله يعطيك'],
  ['Lah yi3tik',            'الله يعطيك'],
  ['tbarkelah',             'تبارك الله'],
  ['Tbarkelah',             'تبارك الله'],
  ['tbarak allah',          'تبارك الله'],
  ['tbarkllah',             'تبارك الله'],
  ['3lik',                  'عليك'],
  ['3lih',                  'عليه'],
  ['3liha',                 'عليها'],
  ['7it',                   'حيت'],
  ['7aja',                  'حاجة'],
  ['khdma',                 'خدمة'],
  ['khedma',                'خدمة'],
  ['Khdma',                 'خدمة'],
  ['Khedma',                'خدمة'],
  ['nqia',                  'نقية'],
  ['mt9ona',                'متقنة'],
  ['mt9on',                 'متقن'],
  ['sahb',                  'صاحب'],
  ['wahed',                 'واحد'],
  ['mezyana',               'مزيانة'],
  ['mezyan',                'مزيان'],
  ['professional',          'محترف'],
  ['professionnel',         'محترف'],
  ['professionnels',        'محترفين'],
];

// Franco phrase → Darija phrase (full-text matches for Franco reviews)
const FRANCO_EXACT = {
  'Saraha tjriba unique 3jbni bzaf l ambiance w ta3amoul w ta l energie de l espace fih wahd ra7aaaa':
    'صراحة تجربة فريدة، عجبني بزاف — الأمبيانس والمعاملة والطاقة ديال البلاصة فيها راحة بزاف',
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function applyPhrases(text) {
  let out = text;
  for (const [from, to] of PHRASES) {
    // Single-pass global replace (split+join replaces all occurrences at once)
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function translate(text) {
  if (!text || text.trim().length === 0) return null;
  const t = text.trim();

  // 1. Franco exact match
  if (FRANCO_EXACT[t]) return FRANCO_EXACT[t];

  // 2. Exact full-text match
  if (EXACT[t]) return EXACT[t];

  // 3. Phrase substitutions on longer text
  const replaced = applyPhrases(t);
  if (replaced !== t) return replaced;

  return null; // no change
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const original = fs.readFileSync(DATA_PATH, 'utf8');
const workers  = JSON.parse(original);

let changed = 0;
let unchanged = 0;
const samples = [];

for (const w of workers) {
  for (const rv of (w.reviews || [])) {
    const newText = translate(rv.text || '');
    if (newText && newText !== rv.text) {
      if (samples.length < 25) {
        samples.push({ old: (rv.text || '').slice(0, 80), new: newText.slice(0, 80) });
      }
      if (!DRY) rv.text = newText;
      changed++;
    } else {
      unchanged++;
    }
  }
}

console.log('=== REVIEW DARIJA TRANSLATION ===');
console.log(`Total reviews  : ${changed + unchanged}`);
console.log(`Changed        : ${changed}`);
console.log(`Unchanged      : ${unchanged}  (already Darija or no rule matched)`);
console.log('\nFirst 25 changes:');
samples.forEach(s => {
  console.log(`  OLD: ${s.old}`);
  console.log(`  NEW: ${s.new}`);
  console.log();
});

if (DRY) {
  console.log('** DRY RUN — workers.json NOT modified. **');
  process.exit(0);
}

fs.writeFileSync(BACKUP_PATH, original);
console.log('\nBackup saved:', BACKUP_PATH);
fs.writeFileSync(DATA_PATH, JSON.stringify(workers, null, 2));
console.log('Updated:', DATA_PATH);
console.log('✅ Done.');
