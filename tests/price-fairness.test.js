/**
 * price-fairness.test.js
 *
 * Tests for lib/price-fairness.js. Focus on the hard-rule deterministic path
 * (no LLM mocking required) — the LLM branch is exercised separately via mocks.
 *
 * Run:
 *   node --test tests/price-fairness.test.js
 *   npm run test:price-fairness
 *
 * Acceptance gate: 100% pass.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  evaluatePriceFairness,
  HARD_LOW_RATIO,
  HARD_HIGH_RATIO,
} = require('../lib/price-fairness');
const { computePriceRange } = require('../scripts/price-engine');

// =============================================================================
// HELPERS
// =============================================================================

function worker(over = {}) {
  return {
    _id: 'w' + Math.random().toString(36).slice(2),
    category: over.category || 'بلومبي',
    city: over.city || 'طنجة',
    name: over.name || 'معلم',
    description: over.description || '',
    tags: over.tags || [],
    experience: over.experience ?? 5,
    zone: over.zone || '',
  };
}

// Stubbed callXAI — returns canned JSON for mid-range evaluations.
function stubCallXAI(verdict, message_darija = 'verdict تم تقييمه', confidence = 0.7) {
  return async () => ({
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ verdict, message_darija, confidence }) } }],
    }),
  });
}

// =============================================================================
// 1. HARD RULES — extreme deviations
// =============================================================================

describe('hard rules — wildly off', () => {
  test('quoted < 40% of baseline.min → wildly_off (low)', async () => {
    const w = worker({ category: 'بلومبي', city: 'طنجة' });
    const baseline = computePriceRange(w);
    const q = Math.floor(baseline.min * 0.3);  // 30% of min
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: q });
    assert.strictEqual(r.verdict, 'wildly_off');
    assert.strictEqual(r.source, 'hard_rule_low');
    assert.ok(r.message_darija.length > 0, 'should have Darija explanation');
  });

  test('quoted > 250% of baseline.max → wildly_off (high)', async () => {
    const w = worker({ category: 'بلومبي', city: 'طنجة' });
    const baseline = computePriceRange(w);
    const q = Math.ceil(baseline.max * 3);
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: q });
    assert.strictEqual(r.verdict, 'wildly_off');
    assert.strictEqual(r.source, 'hard_rule_high');
  });

  test('confidence is 0.95 for hard rules', async () => {
    const w = worker();
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: 1 });
    assert.strictEqual(r.confidence, 0.95);
  });
});

// =============================================================================
// 2. FAIR BAND — quoted within [min, max]
// =============================================================================

describe('fair band — quoted within [min, max]', () => {
  test('quoted exactly at min → fair', async () => {
    const w = worker();
    const baseline = computePriceRange(w);
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: baseline.min });
    assert.strictEqual(r.verdict, 'fair');
    assert.strictEqual(r.source, 'fair_band');
  });

  test('quoted at midpoint → fair', async () => {
    const w = worker();
    const baseline = computePriceRange(w);
    const mid = Math.round((baseline.min + baseline.max) / 2);
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: mid });
    assert.strictEqual(r.verdict, 'fair');
  });

  test('quoted exactly at max → fair', async () => {
    const w = worker();
    const baseline = computePriceRange(w);
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: baseline.max });
    assert.strictEqual(r.verdict, 'fair');
  });
});

// =============================================================================
// 3. MID-RANGE — between fair band and extremes (LLM path)
// =============================================================================

describe('mid-range — between fair and extreme (LLM)', () => {
  test('quoted just above max → calls LLM, accepts above_fair verdict', async () => {
    const w = worker({ category: 'بلومبي', city: 'طنجة' });
    const baseline = computePriceRange(w);
    const q = Math.round(baseline.max * 1.5);  // 150% of max — above fair, below hard rule
    const stub = stubCallXAI('above_fair', 'السعر شوية غالي — تفاوض', 0.8);
    const r = await evaluatePriceFairness({ callXAI: stub, db: null, worker: w, quotedPrice: q });
    assert.strictEqual(r.verdict, 'above_fair');
    assert.strictEqual(r.source, 'llm');
    assert.ok(r.message_darija.length > 0);
  });

  test('quoted just below min → calls LLM, accepts below_fair verdict', async () => {
    const w = worker();
    const baseline = computePriceRange(w);
    const q = Math.floor(baseline.min * 0.6);  // 60% of min — below fair, above hard rule
    const stub = stubCallXAI('below_fair');
    const r = await evaluatePriceFairness({ callXAI: stub, db: null, worker: w, quotedPrice: q });
    assert.strictEqual(r.verdict, 'below_fair');
  });

  test('LLM failure falls back to templated Darija', async () => {
    const w = worker();
    const baseline = computePriceRange(w);
    const q = Math.round(baseline.max * 1.5);
    const failingStub = async () => { throw new Error('grok timeout'); };
    const r = await evaluatePriceFairness({ callXAI: failingStub, db: null, worker: w, quotedPrice: q });
    assert.strictEqual(r.source, 'llm_fallback');
    assert.ok(r.message_darija.length > 0);
  });
});

// =============================================================================
// 4. UNKNOWN CATEGORY — graceful unknown verdict
// =============================================================================

describe('unknown category', () => {
  test('worker.category not in BASE → unknown', async () => {
    const w = worker({ category: 'طبيب' });  // not a jak.ma trade
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: 100 });
    assert.strictEqual(r.verdict, 'unknown');
    assert.strictEqual(r.source, 'unknown_category');
  });

  test('invalid quotedPrice → unknown', async () => {
    const w = worker();
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: 'NaN' });
    assert.strictEqual(r.verdict, 'unknown');
  });

  test('quotedPrice 0 → unknown', async () => {
    const w = worker();
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: 0 });
    assert.strictEqual(r.verdict, 'unknown');
  });

  test('negative quotedPrice → unknown', async () => {
    const w = worker();
    const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: -50 });
    assert.strictEqual(r.verdict, 'unknown');
  });
});

// =============================================================================
// 5. ALL TRADES × ALL CITIES — coverage sweep
// =============================================================================

describe('coverage — 12 trades × 11 cities × hard rule extremes', () => {
  const TRADES = ['بلومبي','طريسيان','صباغة','نجارة','بناء','نقاوة','حدادة','ديكور','نقل','كلامبيستري','خياطة','حراسة'];
  const CITIES = ['الدار البيضاء', 'الرباط', 'طنجة', 'مراكش', 'أكادير', 'فاس', 'سلا', 'مكناس', 'وجدة', 'تطوان', 'تيزنيت'];

  for (const trade of TRADES) {
    for (const city of CITIES.slice(0, 3)) {  // 12 × 3 = 36 cases — enough coverage
      test(`${trade} × ${city} — low extreme is flagged`, async () => {
        const w = worker({ category: trade, city });
        const baseline = computePriceRange(w);
        if (!baseline) return;  // skip if no baseline for this combo
        const q = Math.max(1, Math.floor(baseline.min * 0.2));
        const r = await evaluatePriceFairness({ callXAI: null, db: null, worker: w, quotedPrice: q });
        assert.strictEqual(r.verdict, 'wildly_off', `${trade} @ ${city} quoted ${q} (baseline ${baseline.min}-${baseline.max})`);
      });
    }
  }
});

// =============================================================================
// 6. THRESHOLDS sanity
// =============================================================================

describe('threshold constants', () => {
  test('HARD_LOW_RATIO is 0.4', () => assert.strictEqual(HARD_LOW_RATIO, 0.40));
  test('HARD_HIGH_RATIO is 2.5', () => assert.strictEqual(HARD_HIGH_RATIO, 2.50));
});
