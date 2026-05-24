/**
 * grounded_integration.test.js
 *
 * End-to-end integration tests for handleGroundedChat — exercises the full
 * pipeline (regex pre-filter → retrieval → constrained streaming → verifier)
 * with mocked callXAI + mocked res to capture the SSE stream and assert on
 * what the frontend will actually receive.
 *
 * Categories:
 *   1. Single-trade happy path → text chunks + done event with workers
 *   2. Multi-trade renovation → workersByTrade populated
 *   3. Empty candidates → graceful Darija fallback
 *   4. Verifier failure → verifier.ok=false in done event
 *   5. Price-fairness hook → Darija flag appended when candidate price is wildly off
 *
 * Run:
 *   node --test tests/grounded_integration.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const { handleGroundedChat } = require('../lib/grounded-retrieval');

// =============================================================================
// FIXTURES
// =============================================================================

const oid = (n) => String(n).padStart(24, '0');

function makeWorker(over = {}) {
  return {
    _id: over.id || oid(1),  // keep as plain string; toString() will return same
    name: over.name || 'محمد العمراني',
    category: over.category || 'بلومبي',
    secondary_categories: over.secondary_categories || [],
    city: over.city || 'طنجة',
    zone: over.zone || 'المدينة',
    phone: over.phone || '0612345678',
    description: over.description || 'معلم بلومبي',
    price_min: over.price_min ?? 100,
    price_max: over.price_max ?? 200,
    price_unit: over.price_unit || 'الساعة',
    rating: over.rating ?? 4.5,
    rating_count: over.rating_count ?? 25,
    experience: over.experience ?? 8,
    verified: over.verified !== false,
    featured: !!over.featured,
    approved: over.approved !== undefined ? over.approved : true,
    available: over.available !== undefined ? over.available : true,
    tags: over.tags || [],
  };
}

// MongoDB-shape stub that supports find/project/sort/limit/toArray and findOne
function makeDb(workers) {
  let insertedEvalLogs = [];
  return {
    collection: (name) => {
      if (name === 'eval_logs') {
        return { insertOne: async (doc) => { insertedEvalLogs.push(doc); return { acknowledged: true }; } };
      }
      // workers collection
      return {
        find: (filter) => {
          let results = workers.filter(w => {
            if (filter.$or) {
              const ok = filter.$or.some(cl =>
                (cl.category && w.category === cl.category) ||
                (cl.secondary_categories && (w.secondary_categories || []).includes(cl.secondary_categories))
              );
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
                return { limit: (n) => ({ toArray: async () => results.slice(0, n) }) };
              },
            }),
          };
        },
      };
    },
    _evalLogs: () => insertedEvalLogs,
  };
}

// Mock Express response — captures everything that would be sent to the
// browser. Exposes `frames` (parsed SSE events) for assertions.
function makeRes() {
  const chunks = [];
  let headersSent = false;
  let ended = false;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead: (status, headers) => { headersSent = true; res.headersSent = true; res._status = status; res._headers = headers; },
    write: (data) => { chunks.push(data); return true; },
    end: () => { ended = true; res.writableEnded = true; },
    setHeader: () => {},
  };
  res._frames = () => {
    const raw = chunks.join('');
    return raw.split('\n\n').filter(Boolean).map(line => {
      if (!line.startsWith('data: ')) return null;
      try { return JSON.parse(line.slice(6).trim()); } catch { return null; }
    }).filter(Boolean);
  };
  res._raw = () => chunks.join('');
  return res;
}

// Mock callXAI — returns a streaming response shaped like node-fetch v2's
// response with .body as a Readable. Each chunk is an SSE "data: ..." frame
// mimicking the OpenAI/xAI streaming format.
function makeStreamingCallXAI(rawTokens, finalCitedIds = []) {
  return async (messages, opts = {}) => {
    if (opts.jsonMode && !opts.stream) {
      // Pass 1 classification — return canned JSON
      return {
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            trade: 'بلومبي', city: 'طنجة', urgency: 'normal', budget: 'normal', confidence: 0.85,
          }) } }],
        }),
      };
    }
    if (opts.stream) {
      // Build SSE frames from `rawTokens` (one token per frame)
      const finalText = rawTokens.join('') + (finalCitedIds.length ? `<<WORKERS:${finalCitedIds.join(',')}>>` : '');
      const tokens = finalText.split(/(.{1,5})/).filter(Boolean);
      const frames = tokens.map(t =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`
      );
      frames.push('data: [DONE]\n\n');
      const body = Readable.from(frames.map(f => Buffer.from(f, 'utf-8')));
      return { body };
    }
    return { json: async () => ({ choices: [{ message: { content: '' } }] }) };
  };
}

// =============================================================================
// 1. SINGLE-TRADE HAPPY PATH
// =============================================================================

describe('integration — single-trade happy path', () => {
  test('regex hit → retrieve → stream → done event with worker', async () => {
    const w = makeWorker({ id: oid(1), category: 'بلومبي', city: 'طنجة', name: 'علي' });
    const db = makeDb([w]);
    const callXAI = makeStreamingCallXAI(
      ['نقترح ', 'ليك ', 'علي ', 'بلومبي ', 'محترف. '],
      [oid(1)],
    );
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت بلومبي فطنجة' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {}, info: () => {} } });

    const frames = res._frames();
    const doneFrame = frames.find(f => f.done);
    assert.ok(doneFrame, 'should emit a done frame');
    assert.strictEqual(doneFrame.workers.length, 1);
    assert.strictEqual(doneFrame.workers[0].name, 'علي');
    assert.ok(doneFrame.verifier);
    assert.strictEqual(doneFrame.verifier.ok, true);
  });

  test('streamed text contains <<WORKERS:>> marker for frontend', async () => {
    const w = makeWorker({ id: oid(1) });
    const db = makeDb([w]);
    const callXAI = makeStreamingCallXAI(['نقترح علي.'], [oid(1)]);
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت بلومبي فطنجة' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {} } });

    // SSE frames split tokens across many `data: {text:"..."}` events. The
    // frontend re-concatenates them, so we do the same here before asserting.
    const fullText = res._frames().filter(f => f.text).map(f => f.text).join('');
    assert.ok(fullText.includes('<<WORKERS:'), `extracted stream should contain the marker, got: ${fullText.slice(-100)}`);
  });
});

// =============================================================================
// 2. MULTI-TRADE PROJECT
// =============================================================================

describe('integration — multi-trade renovation', () => {
  test('"تجديد الحمام كاملاً" → workersByTrade has 4 trades', async () => {
    const workers = [
      makeWorker({ id: oid(1), category: 'بلومبي',     city: 'الرباط' }),
      makeWorker({ id: oid(2), category: 'كلامبيستري', city: 'الرباط' }),
      makeWorker({ id: oid(3), category: 'طريسيان',   city: 'الرباط' }),
      makeWorker({ id: oid(4), category: 'صباغة',      city: 'الرباط' }),
    ];
    const db = makeDb(workers);
    const callXAI = makeStreamingCallXAI(
      ['تجديد الحمام يحتاج 4 خدامة. '],
      [oid(1), oid(2), oid(3), oid(4)],
    );
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت تجديد الحمام كاملاً فالرباط' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {} } });

    const doneFrame = res._frames().find(f => f.done);
    assert.ok(doneFrame, 'should emit done');
    assert.ok(doneFrame.workersByTrade, 'should have workersByTrade');
    const trades = Object.keys(doneFrame.workersByTrade);
    assert.deepStrictEqual(trades, ['بلومبي', 'كلامبيستري', 'طريسيان', 'صباغة']);
    for (const trade of trades) {
      assert.ok(doneFrame.workersByTrade[trade].length > 0, `${trade} should have at least one worker`);
    }
  });
});

// =============================================================================
// 3. EMPTY CANDIDATES — graceful fallback
// =============================================================================

describe('integration — no candidates available', () => {
  test('trade detected but DB empty → Darija "no candidates" message + workers=[]', async () => {
    const db = makeDb([]);  // empty DB
    const callXAI = makeStreamingCallXAI([], []);
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت بلومبي فطنجة' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {} } });

    const frames = res._frames();
    const textFrames = frames.filter(f => f.text);
    const doneFrame = frames.find(f => f.done);
    assert.ok(textFrames.length > 0, 'should have streamed at least a Darija message');
    const joined = textFrames.map(f => f.text).join('');
    assert.ok(joined.includes('ما لقيتلكش') || joined.includes('فهمتش'),
      `expected Darija fallback in stream, got: ${joined.slice(0, 100)}`);
    assert.ok(doneFrame);
    assert.deepStrictEqual(doneFrame.workers, []);
  });

  test('completely off-topic query → ASK_CLARIFICATION', async () => {
    const db = makeDb([]);
    // Pass 1 LLM call should return null trade for off-topic
    const callXAI = async (msgs, opts) => {
      if (opts?.jsonMode) {
        return { json: async () => ({ choices: [{ message: { content: JSON.stringify({ trade: null, confidence: 0.1 }) } }] }) };
      }
      return { body: Readable.from([]) };
    };
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت طاجين' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {} } });

    const doneFrame = res._frames().find(f => f.done);
    assert.ok(doneFrame);
    assert.deepStrictEqual(doneFrame.workers, []);
  });
});

// =============================================================================
// 4. VERIFIER CATCHES FABRICATED ID
// =============================================================================

describe('integration — verifier catches fabricated citation', () => {
  test('model cites an ID not in candidates → verifier.ok=false in done event', async () => {
    const w = makeWorker({ id: oid(1), category: 'بلومبي', city: 'طنجة' });
    const db = makeDb([w]);
    // Model fabricates an ID
    const callXAI = makeStreamingCallXAI(
      ['نقترح ليك معلم وهمي. '],
      ['ffffffffffffffffffffffff'],
    );
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت بلومبي فطنجة' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {} } });

    const doneFrame = res._frames().find(f => f.done);
    assert.ok(doneFrame);
    assert.strictEqual(doneFrame.verifier.ok, false);
    assert.ok(doneFrame.verifier.violations_count > 0);
  });
});

// =============================================================================
// 5. EVAL LOG PERSISTENCE
// =============================================================================

describe('integration — eval_logs are persisted', () => {
  test('successful turn writes one doc with timings + classification + verifier', async () => {
    const w = makeWorker({ id: oid(1) });
    const db = makeDb([w]);
    const callXAI = makeStreamingCallXAI(['ok'], [oid(1)]);
    const res = makeRes();
    const req = { body: { messages: [{ role: 'user', text: 'بغيت بلومبي فطنجة' }] } };

    await handleGroundedChat({ callXAI, db, req, res, logger: { error: () => {} } });

    // Give the fire-and-forget insertOne a moment to land
    await new Promise(r => setTimeout(r, 20));

    const logs = db._evalLogs();
    assert.ok(logs.length >= 1, 'should have persisted at least one eval_log');
    const log = logs[0];
    assert.ok(log.timings, 'log should have timings');
    assert.ok(log.classification, 'log should have classification');
    assert.ok(typeof log.candidatesCount === 'number');
    assert.ok(log.ts instanceof Date);
  });
});
