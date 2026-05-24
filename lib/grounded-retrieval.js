/**
 * grounded-retrieval.js
 *
 * Two-pass grounded retrieval for jak.ma AI chat.
 *
 * ARCHITECTURE
 * ────────────
 * Pass 0 — Pre-filter (deterministic):
 *   Regex match against KEYWORD_TO_CAT / KEYWORD_TO_CITY (lib/text-classifier.js).
 *   On a confident hit we SKIP Pass 1's LLM call and save ~1s p50 + Grok cost.
 *   Falls through to Pass 1 only on ambiguous / unknown queries.
 *
 * Pass 0.5 — Multi-trade project detection (deterministic):
 *   Patterns like "تجديد الحمام" expand to ['بلومبي','كلامبيستري','طريسيان','صباغة'].
 *   When matched, we run retrieval N times (one per trade) and Pass 2 produces
 *   an ordered project plan.
 *
 * Pass 0.75 — Image classification (optional, Grok-2-Vision):
 *   If req.body.image is a data URL, classify the visual trade via Grok-2-Vision.
 *   The result feeds into Pass 1 as a hint. If text + image disagree, text wins.
 *
 * Pass 1 — Classification + retrieval:
 *   - Classify via Grok-3-mini in JSON mode (4s budget) ONLY if Pass 0 missed.
 *   - Retrieve N candidates from MongoDB matching trade + city + radius.
 *
 * Pass 2 — Constrained generation + streaming:
 *   - Prompt Grok-3-mini with the candidate list, conversation history, and
 *     STRICT instruction to reference workers only by their _id.
 *   - Stream tokens to client via SSE in the {text} envelope used by the
 *     existing frontend.
 *
 * Verifier — Grounding check:
 *   - Cited IDs must exist in the candidate set.
 *   - Prices must fall within plausible ranges.
 *   - Proper-noun heuristic flags unverified names.
 *   - On hard failure: append a Darija advisory pointing the user to the
 *     worker cards rather than the prose.
 *
 * SSE WIRE FORMAT (compatible with the legacy /api/ai/chat consumer):
 *   data: {"text":"تمارة..."}    — token chunks during streaming
 *   data: {"done":true,"workers":[...],"workersByTrade":{...},"verifier":{...}}
 *   data: {"error":"..."}        — Darija error string on catastrophic failure
 *
 * VERCEL CONSTRAINTS
 * ──────────────────
 * Function timeout: 30s (vercel.json maxDuration). Per-pass budgets sum to 25s.
 * AbortController on every LLM call so a hanging Grok call cannot hold the
 * function hostage.
 *
 * @author Sami EL AKKAD <sam25@mails.tsinghua.edu.cn>
 */

const { ObjectId } = require('mongodb');
const {
  KEYWORD_TO_CAT,
  KEYWORD_TO_CITY,
  detectFromText,
  detectMultiTrade,
  VALID_CATS,
} = require('./text-classifier');
const DARIJA = require('./darija-strings');
const { evaluatePriceFairness } = require('./price-fairness');
const { getCached, setCached, speculativeIntro } = require('./semantic-cache');
const { anthropicTools } = require('./tools');
const { runAgentLoop } = require('./agent-loop');

// =============================================================================
// CONFIGURATION
// =============================================================================

const TRADE_CATEGORIES = VALID_CATS;

const CITIES = [
  'طنجة', 'الدار البيضاء', 'الرباط', 'مراكش', 'فاس',
  'أكادير', 'وجدة', 'مكناس', 'سلا', 'تطوان',
  'القنيطرة', 'الجديدة', 'بني ملال', 'خريبكة', 'سطات',
];

// Vercel function budget — total
const TOTAL_BUDGET_MS = 25_000;
// Per-pass budgets (must sum under TOTAL_BUDGET_MS)
const VISION_BUDGET_MS = 4_000;
const PASS_1_BUDGET_MS = 4_000;
const PASS_2_BUDGET_MS = 16_000;
const VERIFIER_BUDGET_MS = 1_000;

const MAX_CANDIDATES = 8;
const MAX_HISTORY_TURNS = 6;  // truncate conversation history to last N turns

// =============================================================================
// AGENT-PATH — follow-up tool-calling (lib/agent-loop.js)
// =============================================================================
// The agent path fires for FOLLOW-UP queries that reference workers already
// recommended in this conversation. It's strictly opt-in via two gates:
//   1. allowedWorkerIds is non-empty (i.e. prior assistant turn emitted
//      <<WORKERS:>> markers we can scope tool calls against)
//   2. the latest user query matches a follow-up intent regex
// Both must be true. Otherwise we fall through to the standard grounded path.

// Extract every worker ID the model previously cited. Reads from two sources
// (defense in depth — the frontend strips <<WORKERS:>> markers from assistant
// text before saving to history, so we ALSO accept an explicit workers_cited
// sidecar array on each assistant message):
//   1. <<WORKERS:id1,id2>> markers in raw assistant text (if not stripped)
//   2. m.workers_cited[] array (frontend-provided allow-list)
// Plus an optional req.body.workerContext seed for chats started fresh on a
// worker detail page (string ID, or array of IDs).
// Hex24 only — anything else is dropped defensively.
const HEX24 = /^[a-f0-9]{24}$/i;
function _extractAllowedWorkerIds(messages, workerContext) {
  const ids = new Set();

  // Source 1 + 2: per-message marker + sidecar
  for (const m of messages || []) {
    if (m.role !== 'assistant' && m.role !== 'ai') continue;

    // (1) parse <<WORKERS:>> markers in text
    const txt = m.text || (typeof m.content === 'string' ? m.content : '');
    if (txt) {
      const re = /<<WORKERS:([^>]+)>>/g;
      let match;
      while ((match = re.exec(txt)) !== null) {
        for (const id of match[1].split(',')) {
          const trimmed = id.trim();
          if (HEX24.test(trimmed)) ids.add(trimmed.toLowerCase());
        }
      }
    }

    // (2) frontend-provided sidecar array
    if (Array.isArray(m.workers_cited)) {
      for (const id of m.workers_cited) {
        const trimmed = String(id).trim();
        if (HEX24.test(trimmed)) ids.add(trimmed.toLowerCase());
      }
    }
  }

  // Source 3: explicit workerContext (chat started on a worker detail page)
  if (workerContext) {
    const ctxIds = Array.isArray(workerContext) ? workerContext : [workerContext];
    for (const id of ctxIds) {
      const trimmed = String(id).trim();
      if (HEX24.test(trimmed)) ids.add(trimmed.toLowerCase());
    }
  }

  return Array.from(ids);
}

// Detect a follow-up intent that benefits from tool calling. Three signal
// families:
//   - anaphoric: user refers to a previously recommended worker by ordinal
//     ("the first one", "الأول") or by name (substring match handled
//     dynamically in the caller, this regex catches the universal case)
//   - price intent: "how much / shchhal / السعر / fair price"
//   - reviews intent: "what do people say / تقييم / chno gultu / feedback"
//   - details intent: "tell me more / details / تفاصيل / أكثر"
// Four intent families (any match → agent path):
//   1. anaphoric reference: "the first", "him/her", "الأول", "ديك"
//   2. price intent:        "how much", "shchhal", "كم", "سعر", "fair price"
//   3. opinion / reviews:   "good/bad", "reliable", "reviews", "تقييم", "مزيان"
//   4. details intent:      "more", "tell me about", "تفاصيل", "أكثر"
const FOLLOWUP_INTENT_RE = new RegExp(
  // anaphoric
  '(?:\\bfirst\\b|\\bsecond\\b|\\bthird\\b|الأول|الثاني|الثالث|اللي\\s*قبل|ديك|عيطو|عيطي|عيطوا|عيط|\\bhe\\b|\\bhim\\b|\\bher\\b|\\bshe\\b|\\bthem\\b|\\bthat\\s+one\\b|\\bthis\\s+one\\b)' +
  // price
  '|(?:شحال|كم\\s|combien|cost|prix|price|سعر|fair|مناسب|غالي|رخيص|cher|expensive|cheap|fair\\s*price|how\\s+much|how\\s+many)' +
  // opinion / reviews
  '|(?:تقييم|reviews?|feedback|opinion|chno\\s*gultu|عرفت|عرفتو|تقييمات|أراء|آراء|\\bgood\\b|\\bbad\\b|\\breliable\\b|\\btrustworthy\\b|\\brecommend\\b|مزيان|واعر|خايب|موثوق|كيفاش)' +
  // details
  '|(?:تفاصيل|details?|\\bmore\\b|أكثر|3afak\\s+gulli|tell\\s+me\\s+about|أخبرني|كولي|قولي|\\bcontact\\b|\\bcall\\b|واتساب)',
  'i'
);

function _isFollowupNeedingTools(query, allowedWorkerIds) {
  if (!query || typeof query !== 'string') return false;
  if (!Array.isArray(allowedWorkerIds) || allowedWorkerIds.length === 0) return false;
  return FOLLOWUP_INTENT_RE.test(query);
}

// System prompt used for the agent path. Kept short — the model gets the
// conversation history (which already contains the prior recommendation),
// and the tools self-describe via their schemas.
function _buildAgentSystemPrompt(allowedWorkerIds) {
  return [
    'أنت "جاك ذكي" 🤖، المساعد الذكي لمنصة جاك.ما — منصة مغربية للخدمات المنزلية.',
    'هاد المحادثة هي متابعة لتوصية سابقة — المستخدم كيسولك على تفاصيل أكثر، تقييمات، ولا أسعار.',
    '',
    'القواعد:',
    '1. استعمل الأدوات (tools) باش تجاوب — ماتخترعش معلومات.',
    '2. الأدوات خاصها تتسمى فقط على المعلمين هذايا (workerId allow-list):',
    '   ' + (allowedWorkerIds.length ? allowedWorkerIds.join(', ') : '(فارغ)'),
    '3. لا تكشف أبدا الرقم الكامل ديال الهاتف. تقدر تذكر آخر 3 أرقام فقط إذا رجعتهم لك الأداة.',
    '4. الجواب النهائي يكون قصير (3-5 جمل)، بالدارجة المغربية.',
    '5. إيلا الأداة رجعت خطأ، اعترف بصراحة وقول شنو تقدر دير بدالها.',
  ].join('\n');
}

// =============================================================================
// PASS 0 — REGEX PRE-FILTER (deterministic)
// =============================================================================

/**
 * Try to classify with deterministic regex first. Returns null if no confident
 * match — caller should fall through to Pass 1 LLM classification.
 */
function regexClassify(query, context = {}) {
  const trade = context.category || detectFromText(query, KEYWORD_TO_CAT);
  const city = context.city || detectFromText(query, KEYWORD_TO_CITY);
  if (!trade) return null;  // need at least a trade — let Pass 1 decide on ambiguous
  return {
    trade,
    city: city || null,
    urgency: /عاجل|urgent|دابا|ضروري/i.test(query) ? 'high' : 'normal',
    budget: /رخيص|pas cher|abordable/i.test(query) ? 'low' : (/luxe|premium|haut.de.gamme/i.test(query) ? 'premium' : 'normal'),
    confidence: 0.85,
    source: 'regex',
  };
}

// =============================================================================
// PASS 0.75 — IMAGE CLASSIFICATION (Grok-2-Vision)
// =============================================================================

async function classifyImage(callXAI, imageDataUrl) {
  if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_BUDGET_MS);
  try {
    const response = await callXAI(
      [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: `قول ليا فقط: ما هي الفئة المناسبة من هذه القائمة: ${VALID_CATS.join('، ')} — جاوب بكلمة واحدة فقط` },
        ],
      }],
      // Vision classifier: single-label task, no reasoning needed. Force the
      // cheap fast Gemini Flash path even though there's an image — sending
      // single-label vision classification to Sonnet would burn budget for
      // no quality gain.
      { model: 'gemini-3-flash', temperature: 0, maxTokens: 20, signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await response.json();
    const raw = (data?.choices?.[0]?.message?.content || '').trim().replace(/[.،\s]/g, '');
    return VALID_CATS.includes(raw) ? raw : null;
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

// =============================================================================
// PASS 1 — LLM CLASSIFICATION (fallback when regex misses)
// =============================================================================

async function classifyAndExtract(callXAI, query, context = {}, imageHint = null) {
  // Try regex first
  const regexResult = regexClassify(query, context);
  if (regexResult) {
    if (imageHint && imageHint !== regexResult.trade) {
      regexResult.image_disagreement = imageHint;
    }
    return regexResult;
  }

  // Regex missed → use the LLM (slower, more expensive, more flexible).
  // The prompt below is intentionally LONG — it documents every Arabizi
  // convention, every common neighborhood, and provides 25+ examples covering
  // the trickiest inputs (mixed scripts, problem nouns without trade name,
  // neighborhood-only references). The trade-off: Pass-1 LLM hit cost goes
  // up by ~300 tokens per call (cached after first hit via the provider's
  // prompt caching). Worth it because Pass-1 only fires on the ~15% of
  // queries the regex doesn't catch.
  const systemPrompt = `You are a trade classifier for jak.ma, a Moroccan home services marketplace.

INPUT FORMS to handle (any combination, freely mixed in one query):
  1. Standard Arabic / MSA
  2. Moroccan Darija in Arabic script
  3. ROMANIZED Darija ("Arabizi" — Latin script with number-letter substitutes)
  4. French loanwords (plombier, électricien, peintre, fuite, panne, ...)
  5. English (plumber, painter, carpenter, ...)

ARABIZI CONVENTIONS (numeric → Arabic letter):
  3 = ع   (e.g. 3afsh = عفش)
  7 = ح   (e.g. 7eddad = حداد · 7mam = حمام)
  9 = ق   (e.g. 9hraba = كهرباء (sic) · 9nitra = قنيطرة)
  8 = غ   (e.g. 8aribi = غريب)
  5 = خ   (e.g. 5ribga = خريبكة · 5ayyat = خياط)
  6 = ط   (e.g. 6anja = طنجة · 6walit = طواليت)
  Plus letter conventions: kh=خ, ch/sh=ش, gh=غ, dh=ذ, q=ق

OUTPUT JSON object with these fields:
- trade: ONE of these 12 categories (Arabic ONLY in the output): ${TRADE_CATEGORIES.join(', ')}, OR null if off-topic / unclear.
- city: ONE of: ${CITIES.join(', ')}, or null if not in this list
- urgency: "high" | "normal" | "low"
- budget: "low" | "normal" | "premium"
- confidence: 0.0-1.0

EXAMPLES (mixed-script, problem-noun-only, neighborhood-only):
  // Trade-name explicit:
  "الماء كيقطر" / "lma kayktar" / "water dripping" → trade: بلومبي
  "الضو طايح" / "ddow tayh" / "lights out" / "panne courant" → trade: طريسيان
  "الباب مكسور" / "lbab mksor" / "broken door" → trade: نجارة
  "كانخدم بـ enduit" / "kankhdem b enduit" → trade: صباغة
  "bghit plombier f tanja" → trade: بلومبي, city: طنجة, confidence: 0.95
  "kanchad sba8 f casa" → trade: صباغة, city: الدار البيضاء, confidence: 0.95
  "shchhal kayseweh l9ahrabaji f rbat" → trade: طريسيان, city: الرباط, confidence: 0.95
  "wash kayn 7eddad f marrakech" → trade: حدادة, city: مراكش, confidence: 0.95
  "ndafa ldar f sla" → trade: نقاوة, city: سلا, confidence: 0.9
  "carro bali baghi nzlij" → trade: كلامبيستري, confidence: 0.85

  // Problem-noun-only (no trade keyword mentioned):
  "lavabo kasar f maarif" → trade: بلومبي, city: الدار البيضاء (lavabo = sink)
  "chauffao kharbat f anfa" → trade: بلومبي, city: الدار البيضاء (water heater broken)
  "fuite stah f atlas fes" → trade: بناء + multi (roof leak), city: فاس
  "compteur kayt9tar f gueliz" → trade: طريسيان, city: مراكش
  "fissure f hit dyalna" → trade: بناء (wall crack)
  "moustiquaire f chambre" → trade: حدادة (window screen)
  "broderie f caftan" → trade: خياطة (caftan embroidery)
  "tnaqil 3afsh f mohammedia" → trade: نقل, city: الدار البيضاء (NOT نجارة — meuble alone is ambiguous; tnaqil = moving)
  "cctv f villa" → trade: حراسة (camera surveillance)

  // Neighborhood-only city detection:
  "f maarif" / "f anfa" / "f mohammedia" / "f bouskoura" → city: الدار البيضاء
  "f gueliz" / "f medina marrakech" / "f menara" → city: مراكش
  "f agdal" / "f hay riyad" / "f hassan" → city: الرباط
  "f atlas fes" / "f fes el bali" → city: فاس
  "f inezgane" / "f ait melloul" → city: أكادير
  "f hamria" → city: مكناس
  "f mazagan" → city: الجديدة

  // Multi-trade renovation phrases:
  "jded l7mam" / "nrm l7mam" / "sallat l7mam" → multi-trade (bathroom reno)
  "nbeddel kuzina" / "kitchen renovation" → multi-trade (kitchen reno)
  "nbni dar" / "build house" → multi-trade (house construction)

  // Off-topic — must return trade: null:
  "بغيت طاجين" / "bghit tajine" / "I want tagine" → trade: null (food)
  "shchhal kaykellef driving lesson" → trade: null (driving school, not a home service)
  "salam" / "salam khoya" / "merci" / "okay" → trade: null (no intent)

RULES:
- Be conservative on confidence. <0.6 means you genuinely cannot tell. >0.85 means trade is explicit or strongly implied by a problem noun.
- If the user mentions a non-Moroccan city, city=null.
- If only a city is mentioned (no service intent), trade=null but city should still be filled.
- If only a problem noun is mentioned with no city, fill trade but city=null.
- Latin "f" / "fi" / Arabic "في" before a city or neighborhood is a strong locative cue.

Output ONLY the JSON object, no markdown, no explanation, no commentary.`;

  const userPrompt = `Query: "${query}"
Known context: ${JSON.stringify(context)}
${imageHint ? `Visual hint from image: ${imageHint}` : ''}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PASS_1_BUDGET_MS);

  try {
    const response = await callXAI(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        // Pass-1 classifier: structured JSON output, no vision, simple task.
        // Force Gemini Flash (cheap, fast, native responseSchema/JSON mode).
        // This is the hot path that fires on ~40% of queries (after regex
        // catches the rest) — keeping it on Gemini is what makes the
        // $0.0009/query blended cost achievable.
        model: 'gemini-3-flash',
        temperature: 0.1,
        maxTokens: 200,
        jsonMode: true,
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    if (parsed.trade !== null && !TRADE_CATEGORIES.includes(parsed.trade)) {
      return { trade: null, city: parsed.city || context.city || null, urgency: 'normal', budget: 'normal', confidence: 0, source: 'llm' };
    }
    return {
      trade: parsed.trade || null,
      city: CITIES.includes(parsed.city) ? parsed.city : (context.city || null),
      urgency: ['high', 'normal', 'low'].includes(parsed.urgency) ? parsed.urgency : 'normal',
      budget: ['low', 'normal', 'premium'].includes(parsed.budget) ? parsed.budget : 'normal',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      source: 'llm',
      image_disagreement: imageHint && imageHint !== parsed.trade ? imageHint : undefined,
    };
  } catch (err) {
    clearTimeout(timeout);
    // Log the real error so we don't silently degrade. Status code (if any)
    // is set by callClaude → e.g. 401 = missing/bad ANTHROPIC_API_KEY,
    // 404 = wrong model name, 429 = rate limit, abort = timeout.
    console.warn('[classify] LLM call failed → fallback:', err.status || '', err.message);
    return { trade: imageHint || null, city: context.city || null, urgency: 'normal', budget: 'normal', confidence: imageHint ? 0.5 : 0, source: 'fallback', error: err.message };
  }
}

// =============================================================================
// PASS 1.5 — CANDIDATE RETRIEVAL
// =============================================================================

async function retrieveCandidates(db, classification, limit = MAX_CANDIDATES) {
  if (!classification?.trade) return [];

  const baseFilter = {
    $or: [
      { category: classification.trade },
      { secondary_categories: classification.trade },
    ],
    approved: { $ne: false },
    available: { $ne: false },
  };

  // Layered city fallback: exact city → drop to any city
  const filters = classification.city
    ? [{ ...baseFilter, city: classification.city }, baseFilter]
    : [baseFilter];

  for (const f of filters) {
    const docs = await db.collection('workers')
      .find(f)
      .project({
        _id: 1, name: 1, category: 1, secondary_categories: 1,
        city: 1, zone: 1, phone: 1, description: 1,
        price_min: 1, price_max: 1, price_unit: 1, price: 1,
        rating: 1, rating_count: 1, experience: 1,
        verified: 1, featured: 1, tags: 1,
      })
      .sort({ featured: -1, verified: -1, rating: -1, rating_count: -1 })
      .limit(limit)
      .toArray();
    if (docs.length) return docs;
  }
  return [];
}

async function retrieveMultiTradeCandidates(db, trades, city) {
  const results = await Promise.all(
    trades.map(trade => retrieveCandidates(db, { trade, city }, 4))
  );
  const workersByTrade = {};
  trades.forEach((trade, i) => { workersByTrade[trade] = results[i] || []; });
  const flat = Object.values(workersByTrade).flat();
  return { workersByTrade, flat };
}

// =============================================================================
// PASS 2 — CONSTRAINED GENERATION + STREAMING
// =============================================================================

async function streamConstrainedResponse({
  callXAI, res, query, history, classification, candidates, workersByTrade, hasImage,
}) {
  if (!candidates || candidates.length === 0) {
    const msg = classification.trade
      ? DARIJA.NO_CANDIDATES(classification.city, classification.trade)
      : DARIJA.ASK_CLARIFICATION;
    streamWrite(res, msg);
    return { rawOutput: msg, citedIds: [] };
  }

  const candidatesForPrompt = candidates.map((c) => ({
    id: c._id.toString(),
    name: c.name,
    city: c.city,
    zone: c.zone || '',
    price: c.price_min && c.price_max
      ? `${c.price_min}-${c.price_max} درهم / ${c.price_unit || 'اليوم'}`
      : (c.price ? `${c.price} درهم${c.price_unit ? ' / ' + c.price_unit : ''}` : 'حسب الاتفاق'),
    rating: c.rating || null,
    experience: c.experience || null,
    description: c.description ? c.description.slice(0, 120) : '',
    verified: !!c.verified,
    category: c.category,
  }));

  const isMultiTrade = workersByTrade && Object.keys(workersByTrade).length > 1;
  const tradeList = Object.keys(workersByTrade || {}).join(' → ');

  const systemPrompt = `أنت "جاك ذكي" 🤖، المساعد الذكي لمنصة جاك.ما — منصة مغربية للخدمات المنزلية بلا عمولة. تتحدث الدارجة المغربية، العربية، والفرنسية. رد دائماً بنفس لغة المستخدم.

═══════════════════════════════════════════
🚨 قواعد حرجة (CRITICAL — لا تتجاوزها)
═══════════════════════════════════════════
1. تقدر تذكر فقط الخدامة اللي فالقائمة CANDIDATES تحت — بالأسم والمدينة الصحيحين.
2. ⛔ ممنوع تخترع أسماء، أو أرقام هاتف، أو أحياء، أو أسعار. خَتى واحد.
3. ⛔ ممنوع تَعِد بالتوفر — قول فقط ما هو فالداتا.
4. عند الترشيح: اقترح 1-3 خدامة بالاسم، واشرح ليه باختصار.
5. ⛔ ممنوع تذكر _id الخدام فالنص الظاهر.
6. في آخر الرد، **اكتب دائماً** الـ IDs اللي رجعت ليهم بهاد الفورمات بالضبط:
   <<WORKERS:id1,id2,id3>>
7. ${isMultiTrade ? 'بما أنه مشروع متعدد التخصصات، **اكتب أيضاً** هاد الماركر بالترتيب الصحيح:\n   <<MULTI:cat1|cat2|cat3|cat4>>' : 'استعمل <<WORKERS:>> فقط (ماشي <<MULTI:>>).'}
8. خلي الرد قصير (3-5 جمل). المغاربة بغيو جواب سريع، ماشي مقال.

═══════════════════════════════════════════
${isMultiTrade ? `📋 مشروع متعدد التخصصات
الترتيب الصحيح: ${tradeList}
1) اشرح الترتيب باختصار (سطر واحد)
2) اقترح خدام مفتاحي من كل تخصص
3) اكتب <<MULTI:${tradeList.replace(/ → /g, '|')}>>
4) اكتب <<WORKERS:id1,id2,id3>>
` : `📌 طلب خدمة فردية
اقترح أحسن 1-3 خدامة من القائمة
اكتب <<WORKERS:id1,id2,id3>> فالاخر
`}═══════════════════════════════════════════

السياق:
- الخدمة (مكتشفة): ${classification.trade || 'غير محدد'}
- المدينة: ${classification.city || 'غير محددة'}
- الاستعجال: ${classification.urgency}
- الميزانية: ${classification.budget}
${hasImage ? '- 📷 المستخدم بعث صورة' : ''}

CANDIDATES (الوحيدون اللي تقدر تذكرهم):
${JSON.stringify(candidatesForPrompt, null, 2)}`;

  // Build conversation messages: system + truncated history + current query
  const xaiMessages = [{ role: 'system', content: systemPrompt }];
  const trimmedHistory = (history || []).slice(-MAX_HISTORY_TURNS * 2);
  for (const m of trimmedHistory) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    xaiMessages.push({ role: m.role, content: (m.text || '').slice(0, 500) });
  }
  xaiMessages.push({ role: 'user', content: query });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PASS_2_BUDGET_MS);

  let rawOutput = '';
  let citedIds = [];

  // Routing hints for the multi-provider router (server.js callLLM).
  // - hasImage:      image upload  → Sonnet (vision quality)
  // - multiTrade:    workersByTrade has >1 trade  → Sonnet (multi-step reasoning)
  // - lowConfidence: classification confidence < 0.7  → Sonnet (ambiguous intent)
  // - longHistory:   >5 prior turns  → Sonnet (context understanding)
  // Otherwise default → gemini-3-flash.
  const routing = {
    hasImage: !!hasImage,
    multiTrade: !!isMultiTrade,
    lowConfidence: typeof classification.confidence === 'number' && classification.confidence < 0.7,
    longHistory: (history || []).length > 5,
  };

  try {
    const response = await callXAI(xaiMessages, {
      routing,
      temperature: 0.4,
      maxTokens: 450,
      stream: true,
      signal: controller.signal,
    });

    // Streaming via for-await-of (node-fetch v2 response.body is a Readable)
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        try {
          const json = JSON.parse(payload);
          const token = json?.choices?.[0]?.delta?.content || '';
          if (token) {
            rawOutput += token;
            // Pass the token through unchanged — the frontend already strips
            // <<WORKERS:>>, <<MULTI:>>, <<DRAFT:>> markers from the displayed
            // bubble. We DO strip raw 24-char ObjectIds as a defense-in-depth
            // measure in case the model leaks one outside a marker.
            const userVisible = token.replace(/\b[a-f0-9]{24}\b/g, '');
            if (userVisible) streamWrite(res, userVisible);
          }
        } catch { /* skip malformed chunks */ }
      }
    }

    // Extract cited IDs. Primary: <<WORKERS:id1,id2>> marker (frontend contract).
    // Fallback: <cited>id1,id2</cited> in case the model uses the older format.
    const wMatch = rawOutput.match(/<<WORKERS:([^>]+)>>/);
    const cMatch = rawOutput.match(/<cited>([^<]*)<\/cited>/);
    const idsRaw = wMatch ? wMatch[1] : (cMatch ? cMatch[1] : '');
    if (idsRaw) {
      citedIds = idsRaw.split(',').map(s => s.trim()).filter(s => /^[a-f0-9]{24}$/.test(s));
    }

    clearTimeout(timeout);
  } catch (err) {
    clearTimeout(timeout);
    streamWrite(res, DARIJA.STREAM_ERROR);
  }

  return { rawOutput, citedIds };
}

// =============================================================================
// GROUNDING VERIFIER
// =============================================================================

function verifyGrounding(output, candidates) {
  const violations = [];
  const candidateNames = new Set(candidates.map(c => c.name?.trim().toLowerCase()).filter(Boolean));
  const candidateIds = new Set(candidates.map(c => c._id.toString()));

  // 1. Cited IDs must exist in the candidate set.
  //    Primary marker is <<WORKERS:id1,id2>> (matches frontend contract).
  //    Fallback to <cited>...</cited> for older outputs.
  const wMatch = output.match(/<<WORKERS:([^>]+)>>/);
  const cMatch = output.match(/<cited>([^<]*)<\/cited>/);
  const idsRaw = wMatch ? wMatch[1] : (cMatch ? cMatch[1] : '');
  const citedIds = idsRaw
    ? idsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  for (const id of citedIds) {
    if (!candidateIds.has(id)) {
      violations.push(`cited_id_not_in_candidates:${id}`);
    }
  }

  // 2. Price plausibility — extract numbers followed by درهم/dh/dirham/MAD
  // Match 1-6 digits so a single-digit "5 درهم" (clearly implausible) is caught.
  const priceMatches = [...output.matchAll(/(\d{1,6})\s*(درهم|dh|dirham|MAD|د\.م)/gi)];
  for (const m of priceMatches) {
    const num = parseInt(m[1], 10);
    if (num < 30 || num > 50_000) {
      violations.push(`implausible_price:${num}`);
    }
  }

  // 3. Latin-script proper nouns not in candidate set (soft signal)
  const properNouns = output.match(/\b[A-Z][a-zA-Z]{3,}\b/g) || [];
  const ALLOWLIST = new Set(['MA', 'WhatsApp', 'PVC', 'WC', 'MAD', 'TV', 'GPS', 'AC', 'JSON']);
  for (const noun of properNouns) {
    if (ALLOWLIST.has(noun)) continue;
    const lower = noun.toLowerCase();
    const matchesCandidate = [...candidateNames].some(name => name.includes(lower) || lower.includes(name));
    if (!matchesCandidate) {
      violations.push(`unverified_proper_noun:${noun}`);
    }
  }

  const hardViolations = violations.filter(v =>
    v.startsWith('cited_id_not') || v.startsWith('implausible_price')
  );

  const score = Math.max(0, 1 - violations.length / 8);
  return {
    ok: hardViolations.length === 0,
    violations,
    score,
    cited_ids: citedIds,
  };
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Wire this into the /api/ai/chat route.
 *
 * Expected req.body shape:
 *   {
 *     messages: [{ role: 'user'|'assistant', text: '...' }, ...],
 *     city?: '...',         // optional context hint
 *     category?: '...',     // optional context hint
 *     image?: 'data:image/jpeg;base64,...',  // optional
 *   }
 *
 * Or for backwards-compat tests:
 *   { query: '...' }
 *
 * Emits SSE (compatible with legacy chat handler):
 *   data: {"text":"..."}     — token chunks
 *   data: {"done":true,"workers":[...],"workersByTrade":{...},"verifier":{...}}
 *   data: {"error":"..."}    — on catastrophic failure (Darija)
 */
async function handleGroundedChat({ callXAI, callClaude, db, req, res, logger = console }) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const explicitQuery = typeof body.query === 'string' ? body.query : null;
  const image = body.image;
  const context = { city: body.city, category: body.category };

  const userMessages = messages.filter(m => m.role === 'user');
  const latestUserText = userMessages[userMessages.length - 1]?.text || '';
  const query = explicitQuery || latestUserText;
  const fullHistoryText = messages.map(m => m.text || '').join(' ');

  if (!query && !image) {
    streamWrite(res, DARIJA.EMPTY_QUERY);
    streamEnd(res, { workers: [] });
    return;
  }

  const tStart = Date.now();
  // Per-request ID for tracing in eval_logs. 16 hex chars = ~64 bits of entropy,
  // enough for collision-free lookups within a typical retention window.
  const requestId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 16);
  const log = {
    request_id: requestId,
    path: 'grounded', // overwritten to 'agent' inside _runAgentPath on success
    query,
    context,
    hasImage: !!image,
    historyTurns: messages.length,
    timings: {},
    classification: null,
    candidatesCount: 0,
    citedIds: [],
    verifier: null,
    // Agent path telemetry (populated by _runAgentPath; null on grounded path)
    agent_iterations: null,
    tools_called: null,
    allowedWorkerIds: null,
    agent_error: null,
  };
  // Surface the request ID in response headers so the client can include it
  // in support tickets / debugging when a turn went wrong.
  try { res.setHeader('X-Request-Id', requestId); } catch {}

  try {
    // ── AGENT PATH (follow-up tool calls) ──────────────────────────────────
    // Only fires when: (a) prior turn cited workers (allow-list non-empty)
    // (b) current query matches a follow-up intent regex (c) callClaude is
    // available. Any error falls through silently to the grounded path so
    // we never strand the user mid-conversation.
    const allowedWorkerIds = _extractAllowedWorkerIds(messages, body.workerContext);
    if (
      typeof callClaude === 'function' &&
      _isFollowupNeedingTools(query, allowedWorkerIds)
    ) {
      try {
        const handled = await _runAgentPath({
          query,
          history: messages,
          allowedWorkerIds,
          callClaude,
          db,
          res,
          log,
          tStart,
          logger,
        });
        if (handled) {
          // Agent path streamed the response + persisted eval_logs. Done.
          return;
        }
      } catch (err) {
        logger.warn && logger.warn('[agent] failed, falling back to grounded:', err.message);
        log.agent_error = String(err.message || err).slice(0, 200);
        // Important: we have NOT yet written response body in the agent path
        // (it only writes thinking events + final answer on success), so the
        // grounded path can take over from here. If headers are written we're
        // still safe — SSE allows multiple chunks.
      }
    }

    // ── Pass 0.5: multi-trade project detection ───────────────────────────
    const multiTradeCats = detectMultiTrade(fullHistoryText);

    // ── Pass 0.75: image classification (optional) ────────────────────────
    let imageHint = null;
    if (image) {
      const tImg = Date.now();
      imageHint = await classifyImage(callXAI, image);
      log.timings.image = Date.now() - tImg;
      log.imageHint = imageHint;
    }

    // ── Pass 1: classification ─────────────────────────────────────────────
    const t1 = Date.now();
    const classification = await classifyAndExtract(callXAI, query, context, imageHint);
    log.timings.pass1 = Date.now() - t1;
    log.classification = classification;

    streamThinking(res, 'classify', {
      trade: classification.trade,
      city: classification.city,
      urgency: classification.urgency,
      confidence: classification.confidence,
      source: classification.source,
      elapsed_ms: log.timings.pass1,
      multi_trade: multiTradeCats || null,
    });

    if (multiTradeCats) {
      classification.multi_trade = multiTradeCats;
      classification.trade = classification.trade || multiTradeCats[0];
    }

    if (!classification.trade && !multiTradeCats) {
      streamWrite(res, classification.confidence < 0.4 ? DARIJA.LOW_CONFIDENCE : DARIJA.ASK_CLARIFICATION);
      streamEnd(res, { workers: [], verifier: { ok: true, score: 1, violations: [] } });
      log.timings.total = Date.now() - tStart;
      persistEvalLog(db, log);
      return;
    }

    // ── Retrieval ──────────────────────────────────────────────────────────
    const tR = Date.now();
    let candidates = [];
    let workersByTrade = null;
    if (multiTradeCats) {
      const result = await retrieveMultiTradeCandidates(db, multiTradeCats, classification.city);
      workersByTrade = result.workersByTrade;
      candidates = result.flat;
    } else {
      candidates = await retrieveCandidates(db, classification);
    }
    log.timings.retrieval = Date.now() - tR;
    log.candidatesCount = candidates.length;

    streamThinking(res, 'retrieve', {
      candidates_count: candidates.length,
      elapsed_ms: log.timings.retrieval,
      sample_names: candidates.slice(0, 3).map(c => c.name).filter(Boolean),
      trades_pulled: workersByTrade ? Object.keys(workersByTrade) : [classification.trade].filter(Boolean),
    });

    // Speculative intro — stream a Darija pre-amble IMMEDIATELY so the user
    // sees text within ~100ms instead of waiting for Pass-2 to start emitting.
    // The actual LLM response follows. Latency-of-first-paint win.
    if (classification.source === 'regex' && candidates.length > 0) {
      const intro = speculativeIntro(classification, candidates.length);
      if (intro) streamWrite(res, intro);
    }

    // ── Cache lookup (skips Pass 2 LLM call on hit) ────────────────────────
    let rawOutput, citedIds;
    const cached = (!image && messages.length === 1) ? await getCached(db, query) : null;
    if (cached && cached.candidate_ids && candidates.some(c => cached.candidate_ids.includes(c._id.toString()))) {
      // Cache hit. Replay text but only if the cited candidates are still in
      // the fresh retrieval set — guards against stale recommendations after
      // worker availability changes.
      log.cache_hit = true;
      // Re-emit the cached text token-stream-style (chunk it so the UI still
      // animates rather than dumping the whole reply at once).
      const chunks = cached.rawOutput.match(/.{1,12}/gs) || [cached.rawOutput];
      for (const ch of chunks) {
        const visible = ch.replace(/<<WORKERS:[^>]*>>/g, '').replace(/<<MULTI:[^>]*>>/g, '');
        if (visible) streamWrite(res, visible);
      }
      rawOutput = cached.rawOutput;
      citedIds = cached.cited_ids || [];
      log.timings.pass2 = 0;
    } else {
      // ── Pass 2: constrained generation + streaming ──────────────────────
      const t2 = Date.now();
      const result = await streamConstrainedResponse({
        callXAI, res, query,
        history: messages.slice(0, -1),
        classification, candidates, workersByTrade,
        hasImage: !!image,
      });
      rawOutput = result.rawOutput;
      citedIds = result.citedIds;
      log.timings.pass2 = Date.now() - t2;
      log.cache_hit = false;

      // Cache for future repeat queries (best-effort, ignore errors)
      if (rawOutput && rawOutput.length > 20 && classification.trade) {
        setCached(db, query, {
          rawOutput,
          cited_ids: citedIds,
          candidate_ids: candidates.map(c => c._id.toString()),
          classification,
        }).catch(() => {});
      }
    }
    log.citedIds = citedIds;
    log.rawOutputLen = rawOutput ? rawOutput.length : 0;

    // ── Verifier ───────────────────────────────────────────────────────────
    const tV = Date.now();
    const verification = verifyGrounding(rawOutput, candidates);
    log.timings.verifier = Date.now() - tV;
    log.verifier = verification;

    streamThinking(res, 'verify', {
      ok: verification.ok,
      score: verification.score,
      violations: verification.violations.slice(0, 5),
      cited_ids_count: verification.cited_ids.length,
      elapsed_ms: log.timings.verifier,
    });

    if (!verification.ok) {
      streamWrite(res, DARIJA.VERIFIER_WARNING);
    }

    // Pick final workers to surface: cited (model picked them on purpose)
    // falling back to top candidates if cited is empty or all invalid.
    const finalWorkerIds = verification.cited_ids.length
      ? verification.cited_ids.filter(id => candidates.some(c => c._id.toString() === id))
      : candidates.slice(0, 3).map(c => c._id.toString());
    const finalCandidates = finalWorkerIds.map(id => candidates.find(c => c._id.toString() === id)).filter(Boolean);

    // ── Price-fairness hook (Integration B from upgrade plan) ──────────────
    // If the AI response mentions prices AND a cited candidate has a known
    // price_min/price_max, run the hard-rule fairness check (free, no LLM).
    // Append a short Darija note for any flagged candidates.
    const priceMentioned = /\d{2,6}\s*(?:درهم|dh|dirham|MAD|د\.م)/i.test(rawOutput);
    if (priceMentioned && finalCandidates.length) {
      const tPF = Date.now();
      const fairnessFlags = [];
      for (const c of finalCandidates) {
        for (const quoted of [c.price_min, c.price_max].filter(p => Number.isFinite(p) && p > 0)) {
          // No LLM (callXAI: null) and no cache — hard-rule path only, ~0 ms
          const ev = await evaluatePriceFairness({ callXAI: null, db: null, worker: c, quotedPrice: quoted });
          if (ev.verdict === 'wildly_off') {
            fairnessFlags.push({ name: c.name, verdict: ev.verdict, quoted, baseline: ev.baseline });
            break;
          }
        }
      }
      log.timings.price_fairness = Date.now() - tPF;
      log.priceFairnessFlags = fairnessFlags.length;
      if (fairnessFlags.length) {
        streamWrite(res, '\n');
        for (const f of fairnessFlags) {
          streamWrite(res, DARIJA.VERIFIER_PRICE_FLAG(f.name) + '\n');
        }
      }
    }

    const finalWorkers = sanitizeWorkers(finalCandidates);

    const sanitizedByTrade = workersByTrade
      ? Object.fromEntries(Object.entries(workersByTrade).map(([k, v]) => [k, sanitizeWorkers(v)]))
      : null;

    streamEnd(res, {
      workers: finalWorkers,
      workersByTrade: sanitizedByTrade,
      verifier: { ok: verification.ok, score: verification.score, violations_count: verification.violations.length },
    });

    log.timings.total = Date.now() - tStart;
    persistEvalLog(db, log);
  } catch (err) {
    log.error = err.message;
    log.timings.total = Date.now() - tStart;
    persistEvalLog(db, log);
    logger.error?.('[grounded] fatal:', err);
    if (!res.writableEnded) {
      try { res.write(`data: ${JSON.stringify({ error: DARIJA.GENERIC_ERROR })}\n\n`); res.end(); } catch {}
    }
  }
}

// =============================================================================
// HELPERS
// =============================================================================

// SSE writers — emit the legacy `{text}` / `{done, workers}` envelope so the
// frontend chat drawer uses one parser.
// ─── Agent path runner (called from handleGroundedChat agent branch) ────────
// Returns true on success (response fully streamed + eval_logs persisted),
// throws on failure (caller catches → falls back to grounded path).
//
// Design: we run the entire agent loop in-memory, BUFFERING thinking events,
// and only flush to the SSE wire after we have a valid final answer. This
// gives clean fall-back semantics: if the agent fails mid-loop, nothing has
// been written to the client yet, so the grounded path can take over without
// the user seeing torn output.
async function _runAgentPath({
  query, history, allowedWorkerIds,
  callClaude, db, res, log, tStart, logger,
}) {
  const tAgent = Date.now();

  // Build the LLM message stack: agent system prompt + truncated history +
  // current user query. We rely on the regex pre-check to gate this path,
  // so we don't redo classification here.
  const systemPrompt = _buildAgentSystemPrompt(allowedWorkerIds);
  const trimmedHistory = (history || []).slice(-MAX_HISTORY_TURNS * 2);
  const llmMessages = [
    { role: 'system', content: systemPrompt },
    ...trimmedHistory
      .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'ai')
      .map(m => ({
        role: m.role === 'ai' ? 'assistant' : m.role,
        content: String(m.text || m.content || '').slice(0, 500),
      })),
    { role: 'user', content: query },
  ];

  // Buffer thinking events — don't write to SSE until we know we succeeded.
  const thinkingBuffer = [];
  const onThinking = (text) => thinkingBuffer.push({ text, t: Date.now() });

  const result = await runAgentLoop({
    messages: llmMessages,
    tools: anthropicTools(),
    callClaude,
    ctx: { db, allowedWorkerIds },
    onThinking,
    llmOpts: {
      model: 'claude-sonnet-4-5',
      temperature: 0.4,
      maxTokens: 500,
    },
  });

  if (!result || !result.response) {
    throw new Error('agent_loop_returned_no_response');
  }
  const data = await result.response.json();
  const finalText = (data?.choices?.[0]?.message?.content || '').toString();
  if (!finalText.trim()) {
    throw new Error('agent_loop_returned_empty_answer');
  }

  // ── COMMIT POINT — past here we're streaming, no more silent fallback ──

  // Flush each buffered thinking event in order (frontend renders them as
  // expandable agent-reasoning chips).
  for (const t of thinkingBuffer) {
    streamThinking(res, 'agent', { text: t.text, ts: t.t });
  }

  // Emit the final answer as a single text chunk.
  streamWrite(res, finalText);

  // Telemetry
  log.path = 'agent';
  log.agent_iterations = result.iterations;
  log.tools_called = result.toolsCalled;
  log.allowedWorkerIds = allowedWorkerIds;
  log.timings.agent_total = Date.now() - tAgent;
  log.timings.total = Date.now() - tStart;
  log.verifier = { ok: true, score: 1, violations: [], source: 'agent_path' };

  // Close stream. No worker cards (the prior turn already showed them).
  streamEnd(res, {
    workers: [],
    verifier: log.verifier,
    agent: {
      iterations: result.iterations,
      tools_called: result.toolsCalled.map(tc => tc.name),
    },
  });

  // Persist log (fire-and-forget — never blocks the response).
  persistEvalLog(db, log);
  return true;
}

function streamWrite(res, text) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ text })}\n\n`);
}

function streamEnd(res, finalPayload = {}) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ done: true, ...finalPayload })}\n\n`);
  res.end();
}

// Emit a "thinking" event the chat drawer can render as a collapsible
// inspector. Frontends that don't know about it ignore the unknown field.
// This is intentional show-your-work UX — recruiters poking at the system
// can SEE the agent pipeline working under the hood instead of trusting a
// claim in the README.
function streamThinking(res, stage, data) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ thinking: { stage, ...data, t: Date.now() } })}\n\n`);
}

// Sanitize worker objects before sending to the client. The phone number IS
// included because the UI needs it for "call" / "WhatsApp" buttons (already
// public on the listing page).
function sanitizeWorkers(workers) {
  return (workers || []).map(w => ({
    _id: String(w._id || w.id),
    name: w.name,
    category: w.category,
    secondary_categories: w.secondary_categories || [],
    city: w.city,
    zone: w.zone || '',
    phone: w.phone,
    rating: w.rating || 0,
    rating_count: w.rating_count || 0,
    experience: w.experience || 0,
    price: w.price || '',
    price_min: w.price_min || null,
    price_max: w.price_max || null,
    price_unit: w.price_unit || '',
    description: (w.description || '').slice(0, 120),
    verified: !!w.verified,
    featured: !!w.featured,
  }));
}

// Fire-and-forget eval log persistence. Failure here must NOT crash the
// response (we already streamed it).
function persistEvalLog(db, log) {
  if (!db) return;
  try {
    db.collection('eval_logs').insertOne({ ...log, ts: new Date() }).catch(err => {
      console.error('[eval_logs] insert failed:', err.message);
    });
  } catch (err) {
    console.error('[eval_logs] sync failed:', err.message);
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  handleGroundedChat,
  classifyAndExtract,
  classifyImage,
  retrieveCandidates,
  retrieveMultiTradeCandidates,
  streamConstrainedResponse,
  verifyGrounding,
  regexClassify,
  sanitizeWorkers,
  // Agent-path internals (exported for tests + observability)
  _extractAllowedWorkerIds,
  _isFollowupNeedingTools,
  _buildAgentSystemPrompt,
  TRADE_CATEGORIES,
  CITIES,
  MAX_CANDIDATES,
  PASS_1_BUDGET_MS,
  PASS_2_BUDGET_MS,
};
