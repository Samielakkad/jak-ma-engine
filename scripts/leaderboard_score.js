#!/usr/bin/env node
/**
 * leaderboard_score.js — daily scoring loop for the public leaderboard.
 *
 * For each active submission:
 *   1. Pull a rotating sample of ~50 recent real queries from eval_logs
 *   2. Call the submitted model's endpoint with each query
 *   3. Multi-judge the response (Grok + GPT + Claude) via the 5-dim rubric
 *   4. Persist scores + latency to leaderboard_results
 *
 * Run nightly via Vercel Cron, GitHub Action, or cron on any box.
 * Vercel Cron example (in vercel.json):
 *   "crons": [{ "path": "/api/leaderboard/run-eval", "schedule": "0 3 * * *" }]
 *
 * Manual run for testing:
 *   node scripts/leaderboard_score.js --limit 1  # only score the first submission
 */

const { MongoClient } = require('mongodb');
const { decryptApiKey, RUBRIC_DIMS } = require('../lib/leaderboard');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'brikoul';
const XAI_API_KEY = process.env.XAI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const EVAL_SAMPLE_SIZE = 50;     // queries per submission per run
const PER_QUERY_TIMEOUT_MS = 30000;


async function main() {
  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '999');
  if (!MONGODB_URI) {
    console.error('[lb-score] MONGODB_URI not set');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);

  console.log('[lb-score] connected');

  // 1. Pull active submissions
  const submissions = await db.collection('leaderboard_submissions')
    .find({ is_active: true, is_banned: false })
    .limit(limit)
    .toArray();
  console.log(`[lb-score] ${submissions.length} active submissions`);

  // 2. Pull a rotating sample of real queries from eval_logs
  const evalSample = await db.collection('eval_logs')
    .aggregate([
      { $match: { 'classification.trade': { $ne: null } } },
      { $sample: { size: EVAL_SAMPLE_SIZE } },
      { $project: { query: 1, classification: 1, _id: 0 } },
    ])
    .toArray();
  console.log(`[lb-score] sampled ${evalSample.length} real queries`);

  if (evalSample.length === 0) {
    console.warn('[lb-score] no real queries to evaluate yet. Drive more traffic through /api/ai/chat first.');
    await client.close();
    return;
  }

  // 3. Score each submission
  for (const sub of submissions) {
    console.log(`\n[lb-score] scoring "${sub.model_name}" (${sub.organization || 'unknown'})`);
    const apiKey = sub.encrypted_api_key ? decryptApiKey(sub.encrypted_api_key) : null;

    const perQueryResults = [];
    for (const sample of evalSample) {
      try {
        const t0 = Date.now();
        const response = await callSubmittedEndpoint(sub.endpoint, sub.model_id, sample.query, apiKey);
        const latency = Date.now() - t0;
        if (!response) continue;

        // Multi-judge scoring
        const judges = [
          { name: 'grok-3', scorer: () => judgeGrok(sample.query, response) },
          { name: 'gpt-4o-mini', scorer: () => judgeOpenAI(sample.query, response) },
          { name: 'claude-3-5-haiku', scorer: () => judgeClaude(sample.query, response) },
        ];
        const judgeScores = [];
        for (const j of judges) {
          try {
            const s = await j.scorer();
            if (s) judgeScores.push(s);
          } catch (err) {
            console.warn(`  judge ${j.name} failed: ${err.message}`);
          }
        }
        if (judgeScores.length === 0) continue;

        const avgScores = {};
        for (const d of RUBRIC_DIMS) {
          const vals = judgeScores.map(s => s[d]).filter(v => Number.isFinite(v));
          avgScores[d] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        }
        perQueryResults.push({ query: sample.query, response, latency_ms: latency, scores: avgScores, n_judges: judgeScores.length });
      } catch (err) {
        console.warn(`  query failed: ${err.message}`);
      }
    }

    if (perQueryResults.length === 0) {
      console.warn(`[lb-score] no successful queries for "${sub.model_name}" — skipping`);
      continue;
    }

    // Aggregate
    const overallScores = {};
    for (const d of RUBRIC_DIMS) {
      const vals = perQueryResults.map(r => r.scores[d]).filter(v => Number.isFinite(v));
      overallScores[d] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    const latencies = perQueryResults.map(r => r.latency_ms).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length / 2)];

    // Persist
    await db.collection('leaderboard_results').insertOne({
      submission_id: sub.submission_id,
      evaluated_at: new Date(),
      n_queries: perQueryResults.length,
      scores: overallScores,
      latency_p50_ms: p50,
      latency_p95_ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
    });
    await db.collection('leaderboard_submissions').updateOne(
      { submission_id: sub.submission_id },
      { $set: { last_evaluated_at: new Date() }, $inc: { eval_count: 1 } }
    );
    console.log(`[lb-score]   ${perQueryResults.length} queries scored.  scores:`, overallScores, `  p50=${p50}ms`);
  }

  await client.close();
  console.log('[lb-score] done.');
}


// ── Helpers ─────────────────────────────────────────────────────────────────

async function callSubmittedEndpoint(endpoint, modelId, query, apiKey) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const body = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: 'أنت مساعد جاك.ما — منصة الخدمات المنزلية المغربية.' },
        { role: 'user', content: query },
      ],
      temperature: 0.4,
      max_tokens: 300,
    });
    const r = await fetchWithTimeout(endpoint, { method: 'POST', headers, body }, PER_QUERY_TIMEOUT_MS);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

const JUDGE_PROMPT = `أنت محكم خبير فالدارجة المغربية. كتقيم جواب AI على 5 محاور (0-5):
factuality, naturalness, trade_fit, price_fairness, geographic.
رجع JSON ONLY: {"factuality":N,"naturalness":N,"trade_fit":N,"price_fairness":N,"geographic":N}`;


async function judgeGrok(query, response) {
  if (!XAI_API_KEY) return null;
  const r = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${XAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-3',
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: `Query: ${query}\nResponse: ${response}` },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  }, 15000);
  if (!r.ok) return null;
  const data = await r.json();
  return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

async function judgeOpenAI(query, response) {
  if (!OPENAI_API_KEY) return null;
  const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: `Query: ${query}\nResponse: ${response}` },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  }, 15000);
  if (!r.ok) return null;
  const data = await r.json();
  return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

async function judgeClaude(query, response) {
  if (!ANTHROPIC_API_KEY) return null;
  const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      system: JUDGE_PROMPT,
      messages: [{ role: 'user', content: `Query: ${query}\nResponse: ${response}\n\nReturn JSON only.` }],
    }),
  }, 15000);
  if (!r.ok) return null;
  const data = await r.json();
  let txt = data?.content?.[0]?.text || '';
  if (txt.includes('```')) txt = txt.split('```')[1].replace(/^json/, '').trim();
  return JSON.parse(txt);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}


if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
