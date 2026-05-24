/**
 * lib/tools.js — tool registry for the jak.ma follow-up agent.
 *
 * Three tools the LLM can call (Anthropic + Gemini native tool calling):
 *   - lookupWorkerById  : full details of a worker (only if cited earlier)
 *   - getRecentReviews  : last N reviews for a worker (only if cited earlier)
 *   - estimatePrice     : fair price range for trade × city via price-engine.js
 *
 * Allow-list philosophy: the lookup tools refuse worker IDs that haven't
 * appeared in a <<WORKERS:>> marker in the current conversation. This
 * prevents the LLM from being tricked into enumerating arbitrary workers.
 *
 * Each tool exports:
 *   - name              : provider-agnostic identifier
 *   - description       : short description for the registry / logs
 *   - anthropicSchema   : entry for the Anthropic /v1/messages `tools[]` array
 *   - geminiSchema      : entry for Gemini `tools[0].functionDeclarations[]`
 *   - impl(input, ctx)  : async function returning the tool result object
 *
 * Tools NEVER throw — they return { error, message } on graceful failure so
 * the LLM can recover and try a different approach. `executeTool` adds a
 * hard timeout envelope on top.
 */

const { ObjectId } = require('mongodb');
const { computePriceRange } = require('../scripts/price-engine');
const { VALID_CATS } = require('./text-classifier');

const TOOL_TIMEOUT_MS = 1500;

// ─── Validators ──────────────────────────────────────────────────────────────

const isHex24 = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);

function inAllowList(workerId, allowedWorkerIds) {
  if (!Array.isArray(allowedWorkerIds) || allowedWorkerIds.length === 0) return false;
  const target = String(workerId).toLowerCase();
  return allowedWorkerIds.some(id => String(id).toLowerCase() === target);
}

// ─── Tool 1: lookupWorkerById ───────────────────────────────────────────────

const lookupWorkerById = {
  name: 'lookupWorkerById',
  description: 'Fetch full details of a worker previously cited in this conversation.',
  anthropicSchema: {
    name: 'lookupWorkerById',
    description:
      'Get full details about a specific service worker by their MongoDB ID. ' +
      'Use this when the user asks for more information about a worker that was previously recommended ' +
      '(e.g. "tell me more about Hassan", "the first one", "details on worker X"). ' +
      'Returns name, city, zone, full description, computed price range in MAD, star rating, ' +
      'years of experience, verification status, and the last 3 digits of the worker\'s phone ' +
      '(the user contacts the worker directly via the UI\'s WhatsApp button — the LLM should ' +
      'never reveal full phone numbers). ' +
      'Only works for workers already cited in this conversation; otherwise returns ' +
      '{ error: "worker_not_in_context" }.',
    input_schema: {
      type: 'object',
      properties: {
        workerId: {
          type: 'string',
          description:
            '24-character MongoDB ObjectId of the worker. Must be a worker previously cited ' +
            'in this conversation via the <<WORKERS:>> marker.',
        },
      },
      required: ['workerId'],
    },
  },
  geminiSchema: {
    name: 'lookupWorkerById',
    description:
      'Get full details about a specific worker by their MongoDB ID. Returns name, city, zone, ' +
      'full description, computed price range, star rating, years of experience, verification status, ' +
      'and the last 3 digits of the worker\'s phone. Only works for workers already cited in this ' +
      'conversation.',
    parameters: {
      type: 'object',
      properties: {
        workerId: {
          type: 'string',
          description: '24-character MongoDB ObjectId of the worker, previously cited in this conversation.',
        },
      },
      required: ['workerId'],
    },
  },
  async impl({ workerId }, { db, allowedWorkerIds }) {
    if (!isHex24(workerId)) {
      return {
        error: 'invalid_worker_id',
        message: 'workerId must be a 24-character hexadecimal MongoDB ObjectId.',
      };
    }
    if (!inAllowList(workerId, allowedWorkerIds)) {
      return {
        error: 'worker_not_in_context',
        message:
          'I can only look up workers that have already been recommended in this conversation. ' +
          'Ask me to find workers for a specific trade and city first.',
      };
    }
    if (!db) {
      return { error: 'db_unavailable', message: 'Database is not available right now.' };
    }

    let doc;
    try {
      doc = await db.collection('workers').findOne(
        { _id: new ObjectId(workerId), approved: { $ne: false } },
        {
          projection: {
            name: 1, category: 1, secondary_categories: 1,
            city: 1, zone: 1, description: 1,
            price: 1, price_unit: 1, rating: 1, rating_count: 1,
            reviews: 1, experience: 1,
            verified: 1, featured: 1, available: 1, phone: 1,
          },
        }
      );
    } catch (e) {
      return { error: 'lookup_failed', message: String(e.message || e).slice(0, 200) };
    }
    if (!doc) return { error: 'worker_not_found', message: `No worker with id ${workerId}` };

    const range = computePriceRange(doc) || { min: null, max: null, unit: doc.price_unit || null };
    const phoneDigits = doc.phone ? String(doc.phone).replace(/\D/g, '') : '';
    const phoneLast3 = phoneDigits ? phoneDigits.slice(-3) : null;

    return {
      worker_id: workerId,
      name: doc.name,
      category: doc.category,
      secondary_categories: Array.isArray(doc.secondary_categories) ? doc.secondary_categories : [],
      city: doc.city || null,
      zone: doc.zone || null,
      description: (doc.description || '').slice(0, 800),
      price_min: range.min,
      price_max: range.max,
      price_unit: range.unit,
      currency: 'MAD',
      rating: doc.rating || 0,
      rating_count: doc.rating_count || 0,
      reviews_count: Array.isArray(doc.reviews) ? doc.reviews.length : 0,
      experience_years: Number.isFinite(doc.experience)
        ? doc.experience
        : (parseInt(doc.experience) || 0),
      verified: !!doc.verified,
      featured: !!doc.featured,
      available: doc.available !== false,
      phone_last3: phoneLast3,
      privacy_note:
        'Full phone number is intentionally hidden — the end user contacts the worker via the ' +
        'WhatsApp button in the UI. Do NOT try to invent or reveal the full phone.',
    };
  },
};

// ─── Tool 2: getRecentReviews ───────────────────────────────────────────────

const getRecentReviews = {
  name: 'getRecentReviews',
  description: 'Fetch recent reviews for a worker previously cited in this conversation.',
  anthropicSchema: {
    name: 'getRecentReviews',
    description:
      'Get recent customer reviews for a specific worker. Returns reviewer initials (for privacy), ' +
      'star rating (0-5), and review text. Use this when the user asks "what do people say about X" / ' +
      '"any reviews" / "is X good" / "تقييمات" / "chno gultu nas". ' +
      'Only works for workers already cited in this conversation; otherwise returns ' +
      '{ error: "worker_not_in_context" }.',
    input_schema: {
      type: 'object',
      properties: {
        workerId: {
          type: 'string',
          description: '24-character MongoDB ObjectId of the worker, previously cited in this conversation.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of reviews to return. Default 3, max 5.',
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['workerId'],
    },
  },
  geminiSchema: {
    name: 'getRecentReviews',
    description:
      'Get recent customer reviews for a worker previously cited in this conversation. ' +
      'Returns reviewer initials, star rating, and review text.',
    parameters: {
      type: 'object',
      properties: {
        workerId: {
          type: 'string',
          description: '24-char MongoDB ObjectId, previously cited in this conversation.',
        },
        limit: { type: 'integer', description: 'Max reviews to return (1-5). Default 3.' },
      },
      required: ['workerId'],
    },
  },
  async impl({ workerId, limit }, { db, allowedWorkerIds }) {
    if (!isHex24(workerId)) {
      return {
        error: 'invalid_worker_id',
        message: 'workerId must be a 24-character hexadecimal MongoDB ObjectId.',
      };
    }
    if (!inAllowList(workerId, allowedWorkerIds)) {
      return {
        error: 'worker_not_in_context',
        message: 'I can only fetch reviews for workers already recommended in this conversation.',
      };
    }
    if (!db) return { error: 'db_unavailable', message: 'Database is not available right now.' };

    const n = Math.max(1, Math.min(5, parseInt(limit) || 3));

    let doc;
    try {
      doc = await db.collection('workers').findOne(
        { _id: new ObjectId(workerId), approved: { $ne: false } },
        { projection: { name: 1, reviews: 1, rating: 1, rating_count: 1 } }
      );
    } catch (e) {
      return { error: 'lookup_failed', message: String(e.message || e).slice(0, 200) };
    }
    if (!doc) return { error: 'worker_not_found' };

    const all = Array.isArray(doc.reviews) ? doc.reviews : [];
    // Reviews lack timestamps — slice from the end to bias toward "most recent"
    // since they are appended chronologically.
    const recent = all.slice(-n).reverse();

    return {
      worker_id: workerId,
      worker_name: doc.name,
      reviews: recent.map(r => ({
        reviewer_name: r.reviewer_name || 'مجهول',
        stars: Math.max(0, Math.min(5, parseInt(r.stars) || 0)),
        text: (r.text || '').slice(0, 400),
      })),
      avg_rating: doc.rating || 0,
      total_reviews: doc.rating_count || all.length,
      note: all.length === 0 ? 'No reviews yet for this worker.' : null,
    };
  },
};

// ─── Tool 3: estimatePrice ──────────────────────────────────────────────────

const estimatePrice = {
  name: 'estimatePrice',
  description: 'Fair price range estimate for a trade × city via price-engine.js.',
  anthropicSchema: {
    name: 'estimatePrice',
    description:
      'Estimate the fair price range for a service (trade) in a specific Moroccan city, in ' +
      'Moroccan dirhams (MAD). Returns { price_min, price_max, price_unit, baseline_n }. ' +
      'price_unit is "اليوم" / "الساعة" / "المرة" / "القطعة" / "الليلة" depending on trade. ' +
      'baseline_n is how many real workers we have indexed in this trade+city — use it as a ' +
      'confidence signal (low number = estimate is less reliable). ' +
      'Use this when the user asks about pricing ("how much should X cost in Y?", "shchhal ' +
      'kayseweh", "السعر المعقول") or wants to check if a quoted price is fair.',
    input_schema: {
      type: 'object',
      properties: {
        trade: {
          type: 'string',
          enum: VALID_CATS,
          description: 'Arabic trade name from the 12-category list.',
        },
        city: {
          type: 'string',
          description: 'Moroccan city name in Arabic (e.g. الدار البيضاء, طنجة, مراكش, الرباط).',
        },
        options: {
          type: 'object',
          description: 'Optional refinements that affect the estimate.',
          properties: {
            experience_years: {
              type: 'integer',
              minimum: 0,
              maximum: 50,
              description: 'Years of experience the worker has (raises max ceiling).',
            },
            urgency: {
              type: 'string',
              enum: ['normal', 'urgent'],
              description: '"urgent" adds a 24/7 emergency premium (~25-35%).',
            },
            company: {
              type: 'boolean',
              description: 'True if estimating for a registered company (SARL/SAS) vs solo worker.',
            },
          },
        },
      },
      required: ['trade', 'city'],
    },
  },
  geminiSchema: {
    name: 'estimatePrice',
    description: 'Estimate fair price range (MAD) for a trade in a Moroccan city.',
    parameters: {
      type: 'object',
      properties: {
        trade: { type: 'string', enum: VALID_CATS, description: 'Arabic trade name.' },
        city: { type: 'string', description: 'Moroccan city name in Arabic.' },
        options: {
          type: 'object',
          properties: {
            experience_years: { type: 'integer' },
            urgency: { type: 'string', enum: ['normal', 'urgent'] },
            company: { type: 'boolean' },
          },
        },
      },
      required: ['trade', 'city'],
    },
  },
  async impl({ trade, city, options = {} }, { db }) {
    if (!VALID_CATS.includes(trade)) {
      return {
        error: 'invalid_trade',
        message: `trade must be one of: ${VALID_CATS.join(', ')}`,
      };
    }
    if (!city || typeof city !== 'string') {
      return { error: 'invalid_city', message: 'city is required and must be an Arabic city name string.' };
    }

    const isCompany = !!options.company;
    const isUrgent = options.urgency === 'urgent';
    const synthDescription = [
      isUrgent ? '24/7 طوارئ urgence' : '',
      isCompany ? 'SARL شركة مؤسسة' : '',
    ].filter(Boolean).join(' ');
    const expYears = Math.max(0, Math.min(50, parseInt(options.experience_years) || 0));

    const syntheticWorker = {
      category: trade,
      city,
      name: isCompany ? 'Société' : '',
      description: synthDescription,
      tags: [],
      experience: expYears,
      // _id seeds the deterministic price-engine spread so the same inputs
      // return the same number every time (idempotent tool).
      _id: `estimate:${trade}:${city}:${expYears}:${isUrgent ? '1' : '0'}:${isCompany ? '1' : '0'}`,
    };

    const range = computePriceRange(syntheticWorker);
    if (!range) {
      return { error: 'unsupported_trade', message: `Price engine has no base range for "${trade}".` };
    }

    // Ground the estimate against real marketplace supply (best-effort).
    let baselineN = 0;
    if (db) {
      try {
        baselineN = await db.collection('workers').countDocuments({
          $or: [{ category: trade }, { secondary_categories: trade }],
          city,
          approved: { $ne: false },
          available: { $ne: false },
        });
      } catch { /* baseline is best-effort */ }
    }

    return {
      trade,
      city,
      price_min: range.min,
      price_max: range.max,
      price_unit: range.unit,
      currency: 'MAD',
      baseline_n: baselineN,
      options_applied: {
        experience_years: expYears,
        urgency: options.urgency || 'normal',
        company: isCompany,
      },
      note: baselineN === 0
        ? `No active workers indexed for ${trade} in ${city} — estimate is from base ranges + city multiplier only.`
        : null,
    };
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

const TOOLS = [lookupWorkerById, getRecentReviews, estimatePrice];

const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.name, t]));

/**
 * Anthropic-shape tools array, ready to pass as `tools` in /v1/messages.
 */
function anthropicTools() {
  return TOOLS.map(t => t.anthropicSchema);
}

/**
 * Gemini-shape tools array, ready to nest under generateContent's `tools` field.
 * Gemini packs all functions inside a single { functionDeclarations: [...] } entry.
 */
function geminiTools() {
  return [{ functionDeclarations: TOOLS.map(t => t.geminiSchema) }];
}

/**
 * Execute a tool by name with timeout + try/catch envelope.
 *  - ctx must contain { db, allowedWorkerIds, logger? }
 *  - returns { ok: true, name, result, latency_ms }
 *           | { ok: false, name, error, message, latency_ms, result? }
 *  - never throws.
 */
async function executeTool(name, input, ctx) {
  const tool = TOOL_MAP[name];
  const start = Date.now();
  if (!tool) {
    return {
      ok: false,
      name,
      error: 'unknown_tool',
      message: `No tool named "${name}".`,
      latency_ms: 0,
    };
  }

  let result;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('tool_timeout')), TOOL_TIMEOUT_MS)
    );
    result = await Promise.race([tool.impl(input || {}, ctx || {}), timeoutPromise]);
  } catch (err) {
    return {
      ok: false,
      name,
      error: err.message === 'tool_timeout' ? 'timeout' : 'exception',
      message: String(err.message || err).slice(0, 200),
      latency_ms: Date.now() - start,
    };
  }
  const latency_ms = Date.now() - start;

  // Tools return { error, message } on graceful failure — surface that.
  if (result && typeof result === 'object' && result.error) {
    return {
      ok: false,
      name,
      error: result.error,
      message: result.message || null,
      latency_ms,
      result,
    };
  }
  return { ok: true, name, result, latency_ms };
}

module.exports = {
  TOOLS,
  TOOL_MAP,
  anthropicTools,
  geminiTools,
  executeTool,
  TOOL_TIMEOUT_MS,
};
