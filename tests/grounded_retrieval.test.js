/**
 * grounded_retrieval.test.js
 *
 * Test suite for lib/grounded-retrieval.js. Uses Node's built-in `node:test`
 * runner (zero new dependencies, Vercel-cold-start-friendly).
 *
 * Categories:
 *   1. Regex pre-filter — classifies common Darija queries deterministically.
 *   2. Retrieval — composite filter + sort + city fallback.
 *   3. Verifier (positive) — well-formed outputs pass.
 *   4. Verifier (adversarial) — fabricated names / implausible prices / unknown IDs flagged.
 *   5. Multi-trade — renovation queries fan out to 4 trades.
 *   6. Edge cases — empty input, gibberish, off-topic queries.
 *
 * Acceptance gate for Day 1 ship: 100% pass on this suite, and at least
 * 95% of the adversarial verifier cases must catch the seeded fabrication.
 *
 * Run:
 *   node --test tests/grounded_retrieval.test.js
 *   npm run test:grounded
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  regexClassify,
  verifyGrounding,
  retrieveCandidates,
  sanitizeWorkers,
  TRADE_CATEGORIES,
} = require('../lib/grounded-retrieval');

const { detectMultiTrade, detectFromText, KEYWORD_TO_CAT, KEYWORD_TO_CITY } = require('../lib/text-classifier');

// =============================================================================
// FIXTURES
// =============================================================================

const oid = (n) => String(n).padStart(24, '0');  // 24-char hex-ish

function fakeWorker(over = {}) {
  return {
    _id: { toString: () => over.id || oid(1) },
    name: over.name || 'محمد العمراني',
    category: over.category || 'بلومبي',
    secondary_categories: over.secondary_categories || [],
    city: over.city || 'طنجة',
    zone: over.zone || 'المدينة',
    phone: over.phone || '0612345678',
    description: over.description || 'معلم بلومبي مع خبرة',
    price_min: over.price_min ?? 120,
    price_max: over.price_max ?? 200,
    price_unit: over.price_unit || 'الساعة',
    rating: over.rating ?? 4.6,
    rating_count: over.rating_count ?? 30,
    experience: over.experience ?? 8,
    verified: over.verified !== false,
    featured: !!over.featured,
    approved: over.approved !== undefined ? over.approved : true,
    available: over.available !== undefined ? over.available : true,
    tags: over.tags || [],
  };
}

// Fake MongoDB collection — accumulates a find/projection/sort/limit chain
function fakeDb(workers) {
  return {
    collection: () => ({
      find: (filter) => {
        let results = workers.filter(w => {
          if (filter.$or) {
            const ok = filter.$or.some(clause => {
              if (clause.category) return w.category === clause.category;
              if (clause.secondary_categories) return (w.secondary_categories || []).includes(clause.secondary_categories);
              return false;
            });
            if (!ok) return false;
          }
          if (filter.approved && filter.approved.$ne === false && w.approved === false) return false;
          if (filter.available && filter.available.$ne === false && w.available === false) return false;
          if (filter.city && w.city !== filter.city) return false;
          return true;
        });
        return {
          project: () => ({
            sort: (spec) => {
              results = results.slice().sort((a, b) => {
                for (const [k, dir] of Object.entries(spec)) {
                  const av = a[k] ?? 0, bv = b[k] ?? 0;
                  if (av !== bv) return (av < bv ? 1 : -1) * dir * -1;
                }
                return 0;
              });
              return {
                limit: (n) => ({
                  toArray: async () => results.slice(0, n),
                }),
              };
            },
          }),
        };
      },
    }),
  };
}

// =============================================================================
// 1. REGEX PRE-FILTER (15 tests)
// =============================================================================

describe('regex pre-filter — Darija classification', () => {
  const cases = [
    // Arabic Darija (primary trade detection)
    { q: 'بغيت بلومبي فطنجة باش يصلح صنبور',          expectedTrade: 'بلومبي',    expectedCity: 'طنجة' },
    { q: 'الضو طايح فالدار البيضاء',                  expectedTrade: 'طريسيان',  expectedCity: 'الدار البيضاء' },
    { q: 'الباب ديالي مكسور وكنحتاج نجار فالرباط',    expectedTrade: 'نجارة',     expectedCity: 'الرباط' },
    { q: 'بغيت صباغ يصبغ البيت ديالي فمراكش',         expectedTrade: 'صباغة',     expectedCity: 'مراكش' },
    { q: 'كنحتاج تنظيف عميق فالشقة فأكادير',          expectedTrade: 'نقاوة',     expectedCity: 'أكادير' },
    { q: 'الزليج ديال الحمام تكسر فسلا',              expectedTrade: 'كلامبيستري',expectedCity: 'سلا' },
    { q: 'كنحتاج معلم حداد لباب الفيلا فطنجة',        expectedTrade: 'حدادة',     expectedCity: 'طنجة' },
    { q: 'بغيت ديكور فاخر فالشقة فالرباط',            expectedTrade: 'ديكور',     expectedCity: 'الرباط' },
    { q: 'بغيت معلم نقل العفش من فاس للدار البيضاء',  expectedTrade: 'نقل',       expectedCity: 'فاس' },
    { q: 'بغيت معلم حراسة لفيلا فمكناس',              expectedTrade: 'حراسة',     expectedCity: 'مكناس' },
    // Latin Darija
    { q: 'enduit sur les murs casablanca',             expectedTrade: 'صباغة',     expectedCity: 'الدار البيضاء' },
    { q: 'fuite d eau f tanger',                       expectedTrade: 'بلومبي',    expectedCity: 'طنجة' },
    { q: 'electricien rabat urgent',                   expectedTrade: 'طريسيان',  expectedCity: 'الرباط' },
    // French
    { q: 'plomberie urgente casablanca',               expectedTrade: 'بلومبي',    expectedCity: 'الدار البيضاء' },
    { q: 'carrelage cassé dans mon appart marrakech',  expectedTrade: 'كلامبيستري',expectedCity: 'مراكش' },
  ];
  for (const { q, expectedTrade, expectedCity } of cases) {
    test(`"${q.slice(0, 50)}..." → ${expectedTrade} @ ${expectedCity}`, () => {
      const result = regexClassify(q);
      assert.ok(result, `expected a classification, got null`);
      assert.strictEqual(result.trade, expectedTrade);
      assert.strictEqual(result.city, expectedCity);
      assert.ok(result.confidence >= 0.8, `confidence too low: ${result.confidence}`);
    });
  }
});

// =============================================================================
// 2. RETRIEVAL — composite filter + city fallback (8 tests)
// =============================================================================

describe('retrieveCandidates — filter + sort + fallback', () => {
  test('returns candidates matching trade + city, sorted by featured > verified > rating', async () => {
    const workers = [
      fakeWorker({ id: oid(1), name: 'A', category: 'بلومبي', city: 'طنجة', rating: 3, featured: false, verified: false }),
      fakeWorker({ id: oid(2), name: 'B', category: 'بلومبي', city: 'طنجة', rating: 5, featured: false, verified: true }),
      fakeWorker({ id: oid(3), name: 'C', category: 'بلومبي', city: 'طنجة', rating: 4, featured: true,  verified: false }),
    ];
    const db = fakeDb(workers);
    const results = await retrieveCandidates(db, { trade: 'بلومبي', city: 'طنجة' });
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].name, 'C', 'featured should be first');
    assert.strictEqual(results[1].name, 'B', 'verified should be second');
    assert.strictEqual(results[2].name, 'A', 'plain should be last');
  });

  test('respects secondary_categories', async () => {
    const workers = [
      fakeWorker({ id: oid(1), name: 'multi', category: 'بناء', secondary_categories: ['بلومبي'], city: 'الرباط' }),
    ];
    const db = fakeDb(workers);
    const r = await retrieveCandidates(db, { trade: 'بلومبي', city: 'الرباط' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].name, 'multi');
  });

  test('city fallback: if exact city empty, returns ANY city', async () => {
    const workers = [
      fakeWorker({ id: oid(1), category: 'حدادة', city: 'فاس' }),
    ];
    const db = fakeDb(workers);
    const r = await retrieveCandidates(db, { trade: 'حدادة', city: 'مكناس' });
    assert.strictEqual(r.length, 1, 'should fall back to any city when exact city has no candidates');
  });

  test('returns [] for trade with no candidates anywhere', async () => {
    const db = fakeDb([]);
    const r = await retrieveCandidates(db, { trade: 'خياطة', city: 'الجديدة' });
    assert.deepStrictEqual(r, []);
  });

  test('returns [] when classification has no trade', async () => {
    const db = fakeDb([fakeWorker()]);
    const r = await retrieveCandidates(db, { trade: null, city: 'طنجة' });
    assert.deepStrictEqual(r, []);
  });

  test('honors limit parameter', async () => {
    const workers = Array.from({ length: 20 }, (_, i) =>
      fakeWorker({ id: oid(i + 1), category: 'بلومبي', city: 'طنجة' })
    );
    const db = fakeDb(workers);
    const r = await retrieveCandidates(db, { trade: 'بلومبي', city: 'طنجة' });
    assert.ok(r.length <= 8, 'should respect MAX_CANDIDATES (8)');
  });

  test('skips approved=false workers', async () => {
    const workers = [
      fakeWorker({ id: oid(1), category: 'بلومبي', city: 'طنجة', approved: false }),
      fakeWorker({ id: oid(2), category: 'بلومبي', city: 'طنجة', approved: true }),
    ];
    const db = fakeDb(workers);
    const r = await retrieveCandidates(db, { trade: 'بلومبي', city: 'طنجة' });
    assert.strictEqual(r.length, 1);
  });

  test('skips available=false workers', async () => {
    const workers = [
      fakeWorker({ id: oid(1), category: 'بلومبي', city: 'طنجة', available: false }),
      fakeWorker({ id: oid(2), category: 'بلومبي', city: 'طنجة' }),
    ];
    const db = fakeDb(workers);
    const r = await retrieveCandidates(db, { trade: 'بلومبي', city: 'طنجة' });
    assert.strictEqual(r.length, 1);
  });
});

// =============================================================================
// 3. VERIFIER — POSITIVE CASES (8 tests)
// =============================================================================

describe('verifyGrounding — well-formed outputs pass', () => {
  test('output with single cited ID matching candidate set → ok', () => {
    const candidates = [fakeWorker({ id: oid(1), name: 'محمد' })];
    const output = 'نقترح ليك محمد. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok, `expected ok, got violations: ${JSON.stringify(v.violations)}`);
    assert.deepStrictEqual(v.cited_ids, ['000000000000000000000001']);
  });

  test('output with 3 cited IDs all in candidate set → ok', () => {
    const candidates = [
      fakeWorker({ id: oid(1), name: 'A' }),
      fakeWorker({ id: oid(2), name: 'B' }),
      fakeWorker({ id: oid(3), name: 'C' }),
    ];
    const output = 'A و B و C كاينين. <<WORKERS:000000000000000000000001,000000000000000000000002,000000000000000000000003>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok);
    assert.strictEqual(v.cited_ids.length, 3);
  });

  test('output with plausible price (200 درهم) → ok', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'هاد المعلم 200 درهم. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok);
  });

  test('output with no proper nouns → ok', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'كاين شي معلم متاح دابا. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok);
  });

  test('output with allowlisted proper nouns (WhatsApp, MA) → ok', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'بعتيلو على WhatsApp، هو مسجل ف MA. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok);
  });

  test('empty output → ok (no violations)', () => {
    const v = verifyGrounding('', [fakeWorker()]);
    assert.ok(v.ok);
    assert.deepStrictEqual(v.cited_ids, []);
  });

  test('output supports <cited> fallback marker', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = '<cited>000000000000000000000001</cited>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok);
    assert.strictEqual(v.cited_ids.length, 1);
  });

  test('output with candidate name mention → ok (name matches)', () => {
    const candidates = [fakeWorker({ id: oid(1), name: 'محمد العمراني' })];
    const output = 'نقترح ليك محمد العمراني. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok);
  });
});

// =============================================================================
// 4. VERIFIER — ADVERSARIAL CASES (10 tests)
// This is the CRITICAL set. Acceptance gate: ≥9 of 10 must catch the fabrication.
// =============================================================================

describe('verifyGrounding — adversarial outputs caught', () => {
  test('FABRICATED ID not in candidate set → ok=false, cited_id violation', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'نقترح ليك معلم وهمي. <<WORKERS:ffffffffffffffffffffffff>>';
    const v = verifyGrounding(output, candidates);
    assert.strictEqual(v.ok, false);
    assert.ok(v.violations.some(s => s.startsWith('cited_id_not_in_candidates')));
  });

  test('MIX of one valid + one fabricated ID → ok=false', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = '<<WORKERS:000000000000000000000001,ffffffffffffffffffffffff>>';
    const v = verifyGrounding(output, candidates);
    assert.strictEqual(v.ok, false);
  });

  test('IMPLAUSIBLE LOW PRICE (5 درهم) → ok=false', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'هاد المعلم 5 درهم فقط. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.strictEqual(v.ok, false);
    assert.ok(v.violations.some(s => s.startsWith('implausible_price')));
  });

  test('IMPLAUSIBLE HIGH PRICE (200000 درهم) → ok=false', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'هاد المعلم 200000 درهم. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.strictEqual(v.ok, false);
    assert.ok(v.violations.some(s => s.startsWith('implausible_price')));
  });

  test('FABRICATED Latin proper noun (Mohamed BenZakri) → flagged', () => {
    const candidates = [fakeWorker({ id: oid(1), name: 'أحمد' })];
    const output = 'نقترح Mohamed BenZakri.  <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    // soft violations OK — these are advisory not hard-blocking
    assert.ok(v.violations.some(s => s.startsWith('unverified_proper_noun')));
  });

  test('output with NO marker BUT mentions worker IDs in prose → cited_ids empty, no false positive', () => {
    // If model forgets the marker, we can't verify — but we shouldn't fabricate violations.
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = 'كاين معلم متاح.';  // no <<WORKERS:>> emitted
    const v = verifyGrounding(output, candidates);
    assert.deepStrictEqual(v.cited_ids, []);
    // No hard violations → still ok
    assert.ok(v.ok);
  });

  test('MULTIPLE fabricated IDs → cited_id violations for each', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = '<<WORKERS:aaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbb,cccccccccccccccccccccccc>>';
    const v = verifyGrounding(output, candidates);
    assert.strictEqual(v.ok, false);
    const idViolations = v.violations.filter(s => s.startsWith('cited_id_not_in_candidates'));
    assert.strictEqual(idViolations.length, 3);
  });

  test('PRICE on boundary (29 درهم) → flagged (just under threshold)', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = '29 درهم. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.violations.some(s => s.startsWith('implausible_price')));
  });

  test('PRICE just within range (30 درهم) → ok', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const output = '30 درهم. <<WORKERS:000000000000000000000001>>';
    const v = verifyGrounding(output, candidates);
    assert.ok(v.ok, `unexpected violations: ${JSON.stringify(v.violations)}`);
  });

  test('SCORE decreases monotonically with violations', () => {
    const candidates = [fakeWorker({ id: oid(1) })];
    const v1 = verifyGrounding('<<WORKERS:000000000000000000000001>>', candidates);
    const v2 = verifyGrounding('<<WORKERS:ffffffffffffffffffffffff>>', candidates);
    const v3 = verifyGrounding('5 درهم. <<WORKERS:ffffffffffffffffffffffff>>', candidates);
    assert.ok(v1.score > v2.score, 'one violation should lower score');
    assert.ok(v2.score > v3.score, 'two violations should lower score further');
  });
});

// =============================================================================
// 5. MULTI-TRADE DETECTION (5 tests)
// =============================================================================

describe('detectMultiTrade', () => {
  test('"بغيت نجدد الحمام" → 4 trades in bathroom order', () => {
    const r = detectMultiTrade('بغيت نجدد الحمام كاملاً');
    assert.deepStrictEqual(r, ['بلومبي', 'كلامبيستري', 'طريسيان', 'صباغة']);
  });

  test('"renovation salle de bain" → bathroom 4-trade plan', () => {
    const r = detectMultiTrade('je veux faire une renovation salle de bain');
    assert.deepStrictEqual(r, ['بلومبي', 'كلامبيستري', 'طريسيان', 'صباغة']);
  });

  test('"تجديد المطبخ" → kitchen 4-trade plan', () => {
    const r = detectMultiTrade('بغيت تجديد المطبخ كاملاً');
    assert.deepStrictEqual(r, ['نجارة', 'طريسيان', 'بلومبي', 'كلامبيستري']);
  });

  test('single-trade query → null', () => {
    const r = detectMultiTrade('بغيت بلومبي يصلح صنبور');
    assert.strictEqual(r, null);
  });

  test('off-topic query → null', () => {
    const r = detectMultiTrade('بغيت طاجين');
    assert.strictEqual(r, null);
  });
});

// =============================================================================
// 6. EDGE CASES (6 tests)
// =============================================================================

describe('edge cases', () => {
  test('empty query → regexClassify returns null', () => {
    assert.strictEqual(regexClassify(''), null);
  });

  test('off-topic query "بغيت طاجين" → regexClassify returns null', () => {
    assert.strictEqual(regexClassify('بغيت طاجين'), null);
  });

  test('gibberish → regexClassify returns null', () => {
    assert.strictEqual(regexClassify('xkjsfh sdkfjh skdfh'), null);
  });

  test('VERY long query with trade keyword → still classifies', () => {
    const longQ = 'السلام عليكم '.repeat(50) + ' بغيت بلومبي فطنجة باش يصلح صنبور';
    const r = regexClassify(longQ);
    assert.ok(r);
    assert.strictEqual(r.trade, 'بلومبي');
  });

  test('mixed Arabic + Latin + French → primary trade wins', () => {
    const r = regexClassify('Salam, je cherche un electricien à fes parce que la lumière طايحة');
    assert.ok(r);
    assert.strictEqual(r.trade, 'طريسيان');
  });

  test('urgency detected from "عاجل"', () => {
    const r = regexClassify('بغيت معلم لصنبور كيقطر عاجل فطنجة');
    assert.ok(r);
    assert.strictEqual(r.urgency, 'high');
  });
});

// =============================================================================
// 7. SANITIZER (3 tests)
// =============================================================================

describe('sanitizeWorkers', () => {
  test('produces stable shape for the frontend', () => {
    const w = fakeWorker({ id: oid(1) });
    const s = sanitizeWorkers([w])[0];
    const expectedKeys = [
      '_id', 'name', 'category', 'secondary_categories',
      'city', 'zone', 'phone', 'rating', 'rating_count',
      'experience', 'price', 'price_min', 'price_max', 'price_unit',
      'description', 'verified', 'featured',
    ];
    for (const k of expectedKeys) assert.ok(k in s, `missing key: ${k}`);
  });

  test('truncates description to 120 chars', () => {
    const long = 'ا'.repeat(500);
    const s = sanitizeWorkers([fakeWorker({ description: long })])[0];
    assert.ok(s.description.length <= 120);
  });

  test('handles missing fields gracefully', () => {
    const partial = { _id: { toString: () => oid(1) }, name: 'x' };
    const s = sanitizeWorkers([partial])[0];
    assert.strictEqual(s.name, 'x');
    assert.strictEqual(s.rating, 0);
  });
});
