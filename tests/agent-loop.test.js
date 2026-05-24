/**
 * tests/agent-loop.test.js
 *
 * Covers the tool-calling agent stack end-to-end with a mocked LLM (no
 * Anthropic round-trip). Real MongoDB is mocked via an in-memory shim.
 *
 * Run: `node --test tests/agent-loop.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TOOL_MAP,
  anthropicTools,
  geminiTools,
  executeTool,
} = require('../lib/tools');
const { runAgentLoop } = require('../lib/agent-loop');
const {
  _extractAllowedWorkerIds,
  _isFollowupNeedingTools,
} = require('../lib/grounded-retrieval');

// ─── Mocks ──────────────────────────────────────────────────────────────────

const SAMPLE_WORKER = {
  _id: { toString: () => 'aabbccddeeff00112233aabb' },
  name: 'Hassan Plumbing',
  category: 'بلومبي',
  secondary_categories: [],
  city: 'طنجة',
  zone: 'Souani',
  phone: '0612345678',
  description: 'بلومبي محترف فطنجة، 8 سنين خبرة',
  rating: 4.5,
  rating_count: 6,
  experience: 8,
  verified: true,
  featured: false,
  available: true,
  reviews: [
    { reviewer_name: 'م.ب', stars: 5, text: 'كان واعر' },
    { reviewer_name: 'ع.ك', stars: 4, text: 'مزيان' },
    { reviewer_name: 'س.ل', stars: 5, text: 'صراحة احترافي' },
  ],
};

function mockDb() {
  return {
    collection() {
      return {
        async findOne(query) {
          // Accept either ObjectId or string IDs
          const qid = query._id?.toString?.() || query._id;
          if (qid === 'aabbccddeeff00112233aabb') return SAMPLE_WORKER;
          return null;
        },
        async countDocuments() { return 7; },
      };
    },
  };
}

// ─── Tests: tool registry shape ─────────────────────────────────────────────

test('tool registry exposes the three tools', () => {
  assert.deepEqual(
    Object.keys(TOOL_MAP).sort(),
    ['estimatePrice', 'getRecentReviews', 'lookupWorkerById']
  );
});

test('anthropicTools() returns 3 valid schemas', () => {
  const ts = anthropicTools();
  assert.equal(ts.length, 3);
  for (const t of ts) {
    assert.ok(t.name, 'name required');
    assert.ok(t.description, 'description required');
    assert.equal(t.input_schema.type, 'object');
    assert.ok(Array.isArray(t.input_schema.required), 'required array');
  }
});

test('geminiTools() returns one wrapper with three function declarations', () => {
  const ts = geminiTools();
  assert.equal(ts.length, 1);
  assert.equal(ts[0].functionDeclarations.length, 3);
});

// ─── Tests: tool implementations ────────────────────────────────────────────

test('lookupWorkerById rejects invalid hex id', async () => {
  const r = await executeTool('lookupWorkerById', { workerId: 'not-hex' }, {
    db: mockDb(),
    allowedWorkerIds: ['aabbccddeeff00112233aabb'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_worker_id');
});

test('lookupWorkerById refuses worker not in allow-list', async () => {
  const r = await executeTool('lookupWorkerById', { workerId: 'aabbccddeeff00112233aabb' }, {
    db: mockDb(),
    allowedWorkerIds: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'worker_not_in_context');
});

test('lookupWorkerById returns full worker with last-3 phone only', async () => {
  const r = await executeTool('lookupWorkerById', { workerId: 'aabbccddeeff00112233aabb' }, {
    db: mockDb(),
    allowedWorkerIds: ['aabbccddeeff00112233aabb'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.name, 'Hassan Plumbing');
  assert.equal(r.result.phone_last3, '678');
  assert.equal(r.result.rating, 4.5);
  assert.equal(r.result.experience_years, 8);
  // Critical: full phone must NOT be in the response
  assert.equal(r.result.phone, undefined);
  assert.equal(r.result.phone_full, undefined);
  // Privacy note must be present
  assert.match(r.result.privacy_note, /hidden|never reveal/);
});

test('getRecentReviews returns N most recent in reverse order', async () => {
  const r = await executeTool('getRecentReviews', {
    workerId: 'aabbccddeeff00112233aabb',
    limit: 2,
  }, {
    db: mockDb(),
    allowedWorkerIds: ['aabbccddeeff00112233aabb'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.reviews.length, 2);
  // Last review in array is most recent → first in returned reviews
  assert.equal(r.result.reviews[0].text, 'صراحة احترافي');
  assert.equal(r.result.avg_rating, 4.5);
});

test('estimatePrice computes Casa plumber urgent 10y range', async () => {
  const r = await executeTool('estimatePrice', {
    trade: 'بلومبي',
    city: 'الدار البيضاء',
    options: { experience_years: 10, urgency: 'urgent' },
  }, { db: mockDb() });
  assert.equal(r.ok, true);
  assert.equal(r.result.currency, 'MAD');
  assert.equal(r.result.trade, 'بلومبي');
  assert.equal(r.result.city, 'الدار البيضاء');
  // Sanity: should be a sensible positive range
  assert.ok(r.result.price_min > 0);
  assert.ok(r.result.price_max > r.result.price_min);
  // urgent + 10y → at least 150 MAD/hr floor expected (urgent +25% min)
  assert.ok(r.result.price_min >= 100, `min ${r.result.price_min} too low`);
});

test('estimatePrice rejects unknown trade with valid options listed', async () => {
  const r = await executeTool('estimatePrice', { trade: 'fake-trade', city: 'طنجة' }, {
    db: mockDb(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_trade');
  assert.match(r.message, /بلومبي/);
});

test('executeTool refuses unknown tool name', async () => {
  const r = await executeTool('nonexistent', {}, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_tool');
});

// ─── Tests: intent detection ────────────────────────────────────────────────

const ALLOW_IDS = ['aabbccddeeff00112233aabb', '1122334455667788aabbccdd'];

test('_extractAllowedWorkerIds parses <<WORKERS:>> markers', () => {
  const history = [
    { role: 'user', text: 'بغيت بلومبي' },
    { role: 'assistant', text: 'هاد المعلمين: <<WORKERS:aabbccddeeff00112233aabb,1122334455667788aabbccdd>>' },
  ];
  const ids = _extractAllowedWorkerIds(history);
  assert.deepEqual(ids.sort(), ALLOW_IDS.slice().sort());
});

test('_extractAllowedWorkerIds drops malformed hex', () => {
  const history = [
    { role: 'assistant', text: '<<WORKERS:short,aabbccddeeff00112233aabb,not-hex-id-here-zz>>' },
  ];
  const ids = _extractAllowedWorkerIds(history);
  assert.deepEqual(ids, ['aabbccddeeff00112233aabb']);
});

test('_isFollowupNeedingTools fires on price intent', () => {
  for (const q of ['شحال السعر؟', 'how much', 'كم بزاف', 'fair price', 'غالي بزاف']) {
    assert.equal(_isFollowupNeedingTools(q, ALLOW_IDS), true, q);
  }
});

test('_isFollowupNeedingTools fires on review/opinion intent', () => {
  for (const q of ['reviews please', 'تقييمات', 'is he good', 'is that reliable', 'كيفاش هاد المعلم', 'واش مزيان']) {
    assert.equal(_isFollowupNeedingTools(q, ALLOW_IDS), true, q);
  }
});

test('_isFollowupNeedingTools fires on details/anaphoric intent', () => {
  for (const q of ['tell me more', 'the first one', 'تفاصيل', 'الأول', 'ديك المعلم', 'this one']) {
    assert.equal(_isFollowupNeedingTools(q, ALLOW_IDS), true, q);
  }
});

test('_isFollowupNeedingTools does NOT fire on new search queries', () => {
  for (const q of ['بغيت طريسيان فالدار البيضاء', 'salam', 'merci', 'okay', '', 'بغيت كلامبيستري']) {
    assert.equal(_isFollowupNeedingTools(q, ALLOW_IDS), false, `"${q}"`);
  }
});

test('_isFollowupNeedingTools always blocks when allow-list empty', () => {
  for (const q of ['شحال السعر؟', 'reviews', 'tell me more']) {
    assert.equal(_isFollowupNeedingTools(q, []), false, q);
  }
});

// ─── Tests: agent loop end-to-end with mocked LLM ───────────────────────────

test('agent loop calls tool then returns final answer', async () => {
  let callIdx = 0;
  async function mockCallClaude(messages, opts) {
    callIdx++;
    if (callIdx === 1) {
      // First call: trigger estimatePrice
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'toolu_1',
                type: 'function',
                function: {
                  name: 'estimatePrice',
                  arguments: JSON.stringify({ trade: 'بلومبي', city: 'طنجة' }),
                },
              }],
              anthropic_content_blocks: [
                { type: 'tool_use', id: 'toolu_1', name: 'estimatePrice', input: { trade: 'بلومبي', city: 'طنجة' } },
              ],
            },
            finish_reason: 'tool_use',
          }],
        }),
      };
    }
    // Second call: final answer
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: { role: 'assistant', content: 'السعر العادل: 100-220 درهم/الساعة.' },
          finish_reason: 'stop',
        }],
      }),
    };
  }

  const thinking = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'شحال كيتكلف؟' }],
    tools: anthropicTools(),
    callClaude: mockCallClaude,
    ctx: { db: mockDb(), allowedWorkerIds: [] },
    onThinking: (t) => thinking.push(t),
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.toolsCalled.length, 1);
  assert.equal(result.toolsCalled[0].name, 'estimatePrice');
  assert.equal(result.toolsCalled[0].ok, true);
  assert.ok(thinking.length >= 2, 'should emit thinking for call + result');
  const finalJson = await result.response.json();
  assert.match(finalJson.choices[0].message.content, /100-220/);
});

test('agent loop terminates if first call already returns text', async () => {
  async function mockClaude() {
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: { role: 'assistant', content: 'سلام' },
          finish_reason: 'stop',
        }],
      }),
    };
  }
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'سلام' }],
    tools: anthropicTools(),
    callClaude: mockClaude,
    ctx: { db: null, allowedWorkerIds: [] },
  });
  assert.equal(result.iterations, 1);
  assert.equal(result.toolsCalled.length, 0);
});

test('agent loop refuses unknown tool name with allow-list defense', async () => {
  let callIdx = 0;
  async function mockClaude() {
    callIdx++;
    if (callIdx === 1) {
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'toolu_hack',
                type: 'function',
                function: { name: 'exfiltrateData', arguments: '{}' },
              }],
              anthropic_content_blocks: [{ type: 'tool_use', id: 'toolu_hack', name: 'exfiltrateData', input: {} }],
            },
            finish_reason: 'tool_use',
          }],
        }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: { role: 'assistant', content: 'I cannot.' },
          finish_reason: 'stop',
        }],
      }),
    };
  }
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do bad thing' }],
    tools: anthropicTools(),
    callClaude: mockClaude,
    ctx: { db: mockDb(), allowedWorkerIds: [] },
  });
  // The fake tool was refused but the loop still terminated with a real answer
  assert.equal(result.toolsCalled.length, 1);
  assert.equal(result.toolsCalled[0].ok, false);
  assert.equal(result.toolsCalled[0].error, 'unknown_tool');
});

test('agent loop wraps callClaude errors with iteration context', async () => {
  async function mockClaudeBroken() {
    const e = new Error('Anthropic API 429: rate limited');
    e.status = 429;
    throw e;
  }
  await assert.rejects(
    () => runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: anthropicTools(),
      callClaude: mockClaudeBroken,
      ctx: { db: null, allowedWorkerIds: [] },
    }),
    /agent-loop: callClaude failed at iter 0/
  );
});
