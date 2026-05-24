/**
 * leaderboard.js — backend for the public Moroccan-Darija AI leaderboard.
 *
 * Why this exists: most NLP benchmarks are static + synthetic. This one is
 * LIVE, uses REAL production queries from jak.ma's eval_logs, scored daily
 * by three judges. Anyone can submit a model and get scored. It's the kind
 * of community infrastructure that turns a single project into a research
 * artifact other people cite.
 *
 * Endpoints handled here (wired in server.js):
 *   POST /api/leaderboard/submit  — register a new model for daily eval
 *   GET  /api/leaderboard/scores  — current leaderboard, all models
 *   GET  /api/leaderboard/history — score-over-time per model
 *
 * MongoDB collections used:
 *   leaderboard_submissions — registered models + endpoint + contact
 *   leaderboard_results     — per-eval-run scores with judge breakdown
 *
 * The actual daily scoring loop lives in scripts/leaderboard_score.js
 * (run via Vercel Cron or a periodic GitHub Action).
 */

const crypto = require('crypto');

const SUBMISSION_FIELDS = ['model_name', 'organization', 'endpoint', 'model_id', 'contact', 'description'];
const RUBRIC_DIMS = ['factuality', 'naturalness', 'trade_fit', 'price_fairness', 'geographic'];

const MAX_PER_DAY = 50;          // calls per submission per day
const RATE_LIMIT_PER_IP = 5;     // submissions per IP per day


/**
 * Validate + persist a leaderboard submission.
 * @param {Object} db        MongoDB database
 * @param {Object} body      Request body
 * @param {String} ip        Client IP for rate-limit
 * @returns {Promise<{ok, error?, id?}>}
 */
async function registerSubmission(db, body, ip) {
  // Field validation
  for (const f of ['model_name', 'endpoint', 'model_id', 'contact']) {
    if (!body[f] || typeof body[f] !== 'string' || body[f].length < 2 || body[f].length > 200) {
      return { ok: false, error: `missing or invalid ${f}` };
    }
  }
  // URL sanity
  try {
    const u = new URL(body.endpoint);
    if (u.protocol !== 'https:') return { ok: false, error: 'endpoint must be HTTPS' };
  } catch {
    return { ok: false, error: 'endpoint is not a valid URL' };
  }
  // Email sanity for contact
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contact)) {
    return { ok: false, error: 'contact must be a valid email' };
  }

  // Rate limit per IP
  if (db) {
    try {
      const count = await db.collection('leaderboard_submissions').countDocuments({
        ip_hash: hashIp(ip),
        created_at: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
      });
      if (count >= RATE_LIMIT_PER_IP) {
        return { ok: false, error: 'rate limit: too many submissions from this IP today' };
      }
    } catch {}
  }

  // Encrypt the API key (if provided) before storage
  const encryptedApiKey = body.api_key ? encryptApiKey(body.api_key) : null;

  const doc = {
    submission_id: crypto.randomBytes(8).toString('hex'),
    model_name: body.model_name.slice(0, 100),
    organization: (body.organization || '').slice(0, 100),
    endpoint: body.endpoint,
    model_id: body.model_id.slice(0, 100),
    contact: body.contact.slice(0, 100),
    description: (body.description || '').slice(0, 500),
    encrypted_api_key: encryptedApiKey,
    is_jakma: false,
    is_active: true,
    is_banned: false,
    ip_hash: hashIp(ip),
    created_at: new Date(),
    last_evaluated_at: null,
    eval_count: 0,
  };

  if (db) {
    try {
      await db.collection('leaderboard_submissions').insertOne(doc);
    } catch (err) {
      return { ok: false, error: 'failed to persist submission' };
    }
  }

  return { ok: true, id: doc.submission_id, message: 'Submission registered. First evaluation runs within 24 hours.' };
}


/**
 * Get current leaderboard. Returns the most recent score per active model.
 */
async function getLeaderboard(db) {
  if (!db) return { entries: [], message: 'DB unavailable', last_eval_at: null };
  try {
    const submissions = await db.collection('leaderboard_submissions')
      .find({ is_active: true, is_banned: false })
      .toArray();
    if (submissions.length === 0) {
      return { entries: [], message: 'No submissions yet', last_eval_at: null };
    }

    // For each submission, pull the most recent result
    const entries = [];
    let latestEval = null;
    for (const sub of submissions) {
      const latest = await db.collection('leaderboard_results')
        .find({ submission_id: sub.submission_id })
        .sort({ evaluated_at: -1 })
        .limit(1)
        .toArray();
      const r = latest[0];
      if (!r) {
        // No eval yet — show as pending
        entries.push({
          submission_id: sub.submission_id,
          model_name: sub.model_name,
          organization: sub.organization,
          avg_score: null,
          factuality: null, naturalness: null, trade_fit: null,
          price_fairness: null, geographic: null,
          latency_p50_ms: null,
          is_jakma: !!sub.is_jakma,
          is_new: true,
        });
        continue;
      }
      const avg = RUBRIC_DIMS
        .map(d => r.scores?.[d])
        .filter(v => Number.isFinite(v))
        .reduce((a, b, _, arr) => a + b / arr.length, 0) || null;
      entries.push({
        submission_id: sub.submission_id,
        model_name: sub.model_name,
        organization: sub.organization,
        avg_score: avg,
        factuality: r.scores?.factuality,
        naturalness: r.scores?.naturalness,
        trade_fit: r.scores?.trade_fit,
        price_fairness: r.scores?.price_fairness,
        geographic: r.scores?.geographic,
        latency_p50_ms: r.latency_p50_ms,
        is_jakma: !!sub.is_jakma,
        is_new: false,
      });
      if (!latestEval || new Date(r.evaluated_at) > new Date(latestEval)) {
        latestEval = r.evaluated_at;
      }
    }
    entries.sort((a, b) => (b.avg_score || 0) - (a.avg_score || 0));
    return { entries, last_eval_at: latestEval };
  } catch (err) {
    return { entries: [], error: err.message };
  }
}


/**
 * Get score-over-time per submission for the time chart.
 * Returns last 30 days of evaluations, grouped per submission.
 */
async function getHistory(db) {
  if (!db) return { series: [] };
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const results = await db.collection('leaderboard_results')
      .find({ evaluated_at: { $gte: since } })
      .sort({ evaluated_at: 1 })
      .toArray();
    const bySubmission = {};
    for (const r of results) {
      bySubmission[r.submission_id] = bySubmission[r.submission_id] || [];
      const avg = RUBRIC_DIMS
        .map(d => r.scores?.[d])
        .filter(v => Number.isFinite(v))
        .reduce((a, b, _, arr) => a + b / arr.length, 0) || null;
      bySubmission[r.submission_id].push({
        t: r.evaluated_at,
        avg,
      });
    }
    return { series: bySubmission };
  } catch (err) {
    return { series: [], error: err.message };
  }
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 16);
}

function encryptApiKey(apiKey) {
  // AES-256-GCM with SESSION_SECRET derived key. Stored as base64(iv|tag|ct).
  const secret = process.env.SESSION_SECRET || 'jak-ma-edit-2025-secret';
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(apiKey, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptApiKey(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.from(blob, 'base64');
    const secret = process.env.SESSION_SECRET || 'jak-ma-edit-2025-secret';
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}


module.exports = {
  registerSubmission,
  getLeaderboard,
  getHistory,
  encryptApiKey,
  decryptApiKey,
  hashIp,
  RUBRIC_DIMS,
};
