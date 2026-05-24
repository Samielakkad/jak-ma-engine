/**
 * darija-strings.js — user-facing UX strings for the AI layer, in Moroccan Darija.
 *
 * Quality bar: every string here is checked against a native-speaker rubric. No
 * English stack traces, no MSA when Darija is natural, no over-formal phrasing.
 * Users see Darija — they don't see "Error: ECONNREFUSED".
 *
 * Integration point: imported by lib/grounded-retrieval.js, lib/price-fairness.js,
 * and the new /api/ai/vision endpoint in server.js. Centralized so we can
 * iterate on tone without touching the call sites.
 *
 * Notes for future Darija edits:
 *   - Prefer Arabic script. Latin Arabizi is fine when natural (e.g. "kifach").
 *   - Use second-person familiar (نتا/نتي) — jak.ma's voice is friendly, not formal.
 *   - Keep messages short. Moroccan users on mobile want fast answers, not essays.
 *   - End advisories with a constructive next step ("جرب...", "قارن قبل...") not just bad news.
 */

const DARIJA = {
  // ── Classification / understanding ─────────────────────────────────────────
  ASK_CLARIFICATION:
    'ما فهمتش بالضبط شنو الخدمة لي محتاج. واش تقدر تعطيني تفاصيل اكتر — بلومبي، طريسيان، نجارة، ولا شي حاجة أخرى؟',

  LOW_CONFIDENCE:
    'الطلب ديالك ما واضح ليا 100%. وضح ليا شوية المشكل باش نلقالك المعلم المناسب.',

  EMPTY_QUERY:
    'وضح ليا السؤال ديالك.',

  // ── Retrieval results ──────────────────────────────────────────────────────
  NO_CANDIDATES: (city, trade) =>
    `ما لقيتلكش خدامين ف${city || 'الناحية ديالك'} فمجال ${trade}. جرب مدينة قريبة أو وضح المنطقة.`,

  NO_CANDIDATES_NO_CITY: (trade) =>
    `ما لقيتلكش خدامين فمجال ${trade} دابا. واش تقدر تعطيني المدينة باش ندورو فيها؟`,

  NO_CATEGORY_FOR_TRADE:
    'هاد الخدمة ما عندنا فيها خدامين فالقاعدة دابا. حاول تطلب خدمة قريبة أو سجل أنت كمعلم 🙂',

  // ── Streaming / errors ─────────────────────────────────────────────────────
  STREAM_ERROR:
    '\n\n[خطأ مؤقت — حاول مرة أخرى من فضلك]',

  TIMEOUT:
    'الجواب طول بزاف. عاود المحاولة بسؤال أقصر من فضلك.',

  GENERIC_ERROR:
    'مشكل تقني مؤقت. عاود المحاولة بعد شوية.',

  AI_UNAVAILABLE:
    'الذكاء الاصطناعي ما متاحش دابا. شوف الخدامة فالصفحة الرئيسية مباشرة.',

  // ── Verifier outputs ───────────────────────────────────────────────────────
  VERIFIER_WARNING:
    '\n\n[ملاحظة: شوف الكارد ديال الخدامة فالاسفل للتأكد من الأسعار والاتصال]',

  VERIFIER_PRICE_FLAG: (name) =>
    `[ملاحظة الذكاء: السعر ديال ${name} فيه شك — قارن قبل ما تخلص]`,

  // ── Price fairness ─────────────────────────────────────────────────────────
  PRICE_TOO_LOW: ({ quoted, currency, unit, min, max, city, trade }) =>
    `هاد الثمن (${quoted} ${currency}/${unit}) قليل بزاف. المعدل ف${city} ل${trade} كيدور بين ${min}-${max} درهم. ممكن غلطة فالكتابة.`,

  PRICE_TOO_HIGH: ({ quoted, currency, unit, min, max, city, trade }) =>
    `هاد الثمن (${quoted} ${currency}/${unit}) عالي بزاف. المعدل ف${city} ل${trade} كيدور بين ${min}-${max} درهم. تأكد قبل ما تخلص.`,

  PRICE_FAIR: (range) =>
    `السعر معقول ✅ (المعدل ${range.min}-${range.max} ${range.unit ? 'درهم/' + range.unit : 'درهم'})`,

  PRICE_BELOW_FAIR: (range) =>
    `السعر شوية قليل من المعدل — ممكن جودة أقل. قارن (المعدل ${range.min}-${range.max} درهم).`,

  PRICE_ABOVE_FAIR: (range) =>
    `السعر شوية غالي من المعدل — تفاوض شوية (المعدل ${range.min}-${range.max} درهم).`,

  // ── Vision endpoint ────────────────────────────────────────────────────────
  VISION_NO_IMAGE: 'بعت ليا الصورة باش نشوف المشكل.',
  VISION_FAILED: 'ما عرفتش نقرا الصورة. جرب صورة واضحة شوية.',
};

module.exports = DARIJA;
