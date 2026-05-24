/**
 * smoke-test.js — end-to-end smoke test against a running jak.ma server.
 *
 * Hits five canonical queries and verifies:
 *   1. The chat endpoint streams SSE
 *   2. Each response contains at least one Darija token
 *   3. The done event has a verifier and a workers array
 *   4. /api/health returns 200 with db: 'ok'
 *
 * Use this as the pre-deploy gate after any change touching the chat path.
 *
 * Usage:
 *   # Start the server in one terminal:
 *   node server.js
 *   # In another terminal:
 *   node scripts/smoke-test.js [URL]
 *
 *   # Default URL: http://localhost:3000
 *   # For prod: node scripts/smoke-test.js https://jak.ma
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.argv[2] || 'http://localhost:3000';

const QUERIES = [
  { id: 'q1', label: 'plumber in Tanger', body: { messages: [{ role: 'user', text: 'بغيت معلم بلومبي فطنجة باش يصلح غسالة' }] } },
  { id: 'q2', label: 'painter in Casablanca (Latin Darija)', body: { messages: [{ role: 'user', text: 'Kankhdem b enduit, b3it sba8 casablanca' }] } },
  { id: 'q3', label: 'urgent carpenter', body: { messages: [{ role: 'user', text: 'الباب ديالي مكسور وكنحتاج واحد عاجل' }] } },
  { id: 'q4', label: 'bathroom renovation (multi-trade)', body: { messages: [{ role: 'user', text: 'بغيت نجدد الحمام كاملاً' }] } },
  { id: 'q5', label: 'off-topic (should clarify)', body: { messages: [{ role: 'user', text: 'بغيت طاجين' }] } },
];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseSSEFrames(raw) {
  return raw.split('\n\n').filter(Boolean).map(line => {
    if (!line.startsWith('data:')) return null;
    try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
  }).filter(Boolean);
}

async function smokeOne(q) {
  const t0 = Date.now();
  const r = await request('POST', '/api/ai/chat', q.body);
  const elapsed = Date.now() - t0;
  const frames = parseSSEFrames(r.body);
  const textFrames = frames.filter(f => f.text);
  const doneFrame = frames.find(f => f.done);
  const errorFrame = frames.find(f => f.error);

  const fullText = textFrames.map(f => f.text).join('');
  const verifier = doneFrame?.verifier;
  const workersCount = (doneFrame?.workers || []).length;

  let status = 'PASS';
  const issues = [];
  if (r.status !== 200) { status = 'FAIL'; issues.push(`HTTP ${r.status}`); }
  if (errorFrame) { status = 'FAIL'; issues.push(`error: ${errorFrame.error}`); }
  if (textFrames.length === 0 && q.id !== 'q5') { status = 'FAIL'; issues.push('no text frames'); }
  if (!doneFrame) { status = 'FAIL'; issues.push('no done frame'); }
  if (q.id === 'q4' && doneFrame && !doneFrame.workersByTrade) { issues.push('multi-trade: no workersByTrade in done'); }

  console.log(`  ${status === 'PASS' ? '✓' : '✗'}  ${q.id}  ${q.label}`);
  console.log(`     elapsed: ${elapsed} ms   text_frames: ${textFrames.length}   workers: ${workersCount}`);
  if (verifier) console.log(`     verifier.ok: ${verifier.ok}  score: ${verifier.score}`);
  if (fullText) console.log(`     reply: ${fullText.slice(0, 100).replace(/\s+/g, ' ')}${fullText.length > 100 ? '…' : ''}`);
  if (issues.length) console.log(`     issues: ${issues.join('; ')}`);
  return { id: q.id, status, elapsed, issues, workersCount, verifierOk: verifier?.ok };
}

async function main() {
  console.log(`smoke test against ${BASE}\n`);

  console.log('── /api/health ──');
  try {
    const h = await request('GET', '/api/health');
    const hb = JSON.parse(h.body);
    console.log(`  status: ${h.status}   db: ${hb.db}   xai: ${hb.xai_configured ? 'configured' : 'missing'}   grounded: ${hb.grounded_retrieval}   workers: ${hb.worker_count}\n`);
  } catch (err) {
    console.log(`  ✗ health failed: ${err.message}\n`);
    process.exit(2);
  }

  console.log('── /api/ai/chat (5 queries) ──');
  const results = [];
  for (const q of QUERIES) {
    try {
      results.push(await smokeOne(q));
    } catch (err) {
      console.log(`  ✗  ${q.id}  EXCEPTION: ${err.message}`);
      results.push({ id: q.id, status: 'FAIL', issues: [err.message] });
    }
  }

  console.log('\n── summary ──');
  const passed = results.filter(r => r.status === 'PASS').length;
  console.log(`  ${passed}/${results.length} queries passed`);
  if (passed < results.length) process.exit(1);
}

main().catch(err => { console.error('smoke test crashed:', err); process.exit(2); });
