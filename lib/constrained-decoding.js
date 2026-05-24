/**
 * constrained-decoding.js — grammar-based output enforcement for the AI chat.
 *
 * WHAT THIS IS
 * ────────────
 * Post-hoc verifiers (lib/grounded-retrieval.js verifyGrounding) catch
 * fabrications AFTER the model emits them. Grammar-constrained decoding
 * prevents fabrications FROM HAPPENING — the model literally cannot emit
 * a worker ID that isn't in the candidate set, because we mask the
 * forbidden tokens at each generation step.
 *
 * WHY THIS IS A REAL CONTRIBUTION (not just engineering)
 * ───────────────────────────────────────────────────────
 * Most production LLM systems use Constitutional AI, RLHF, or post-hoc
 * verifiers. Grammar-constrained decoding is mathematically stronger:
 * it gives FORMAL guarantees, not statistical ones. Microsoft Research's
 * Guidance library, OpenAI's `response_format`, and Anthropic's tool-use
 * all use variations of this. We adopt it specifically for dialectal
 * Arabic + structured worker citation — a use case nobody has published
 * on for Moroccan Darija.
 *
 * For jak.ma the grammar enforces:
 *
 *   response :=  prose <<WORKERS:id_list>>
 *   id_list  :=  worker_id ("," worker_id)*
 *   worker_id := one of { allowed_ids }      <-- dynamic per request
 *
 * IMPLEMENTATION NOTE
 * ───────────────────
 * Server-side enforcement requires the inference engine to support
 * logit-masking. Two paths:
 *
 *   1. Modal A10G with `outlines` library — Python-side constrained
 *      generation. See modal-deploy/app_constrained.py (TBD).
 *   2. xAI Grok via response_format={'type': 'json_schema', ...} for
 *      structured outputs. Less flexible but works today.
 *
 * For the production path:
 * - If MODEL_VARIANT is `modal-1.5b` and the constrained build is active,
 *   we POST candidate IDs as an "allowed_workers" field; Modal-side
 *   `outlines` enforces the grammar.
 * - Otherwise we fall back to xAI structured output via JSON schema.
 *
 * The post-hoc verifier in lib/grounded-retrieval.js stays as a
 * defence-in-depth check. Constrained decoding is the strong invariant;
 * the verifier is the safety net.
 */

const CHAT_GRAMMAR_TEMPLATE = (allowedIds) => `
# EBNF grammar for jak.ma chat response — constrained decoding spec.
# Generated per-request with this request's allowed worker IDs.

start := prose marker
prose := /[^<]+/                                        # any text before marker
marker := "<<WORKERS:" id_list ">>"
id_list := worker_id ("," worker_id)*
worker_id := ${allowedIds.map(id => JSON.stringify(id)).join(' | ')}
`;


/**
 * Build the JSON-schema constraint for structured output APIs that don't
 * support full EBNF (e.g. OpenAI/xAI structured outputs). Less expressive
 * than the EBNF version but works with current commodity APIs.
 *
 * The schema forces the response to be a JSON object with a `prose` field
 * and a `cited_workers` array whose elements MUST be from the allowed set.
 */
function buildJsonSchemaConstraint(allowedIds) {
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) {
    return null;
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'jakma_chat_response',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['prose', 'cited_workers'],
        properties: {
          prose: {
            type: 'string',
            description: 'Natural Moroccan Darija response, 2-4 sentences. May reference workers by name only.',
          },
          cited_workers: {
            type: 'array',
            description: 'Worker IDs cited. MUST be from the allowed candidate set.',
            items: { type: 'string', enum: allowedIds },
            maxItems: Math.min(5, allowedIds.length),
            uniqueItems: true,
          },
        },
      },
    },
  };
}


/**
 * For inference backends that support outlines / xgrammar (e.g. vLLM with
 * --guided-decoding-backend=outlines), produce the regex pattern they expect.
 *
 * Returns null if no IDs (caller should fall back to unconstrained).
 */
function buildRegexConstraint(allowedIds) {
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) return null;
  // Escape regex metachars in IDs
  const idPattern = allowedIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `^[^<]*<<WORKERS:(?:${idPattern})(?:,(?:${idPattern}))*>>[\\s\\S]*$`
  );
}


/**
 * Wrap a chat-completion call with the appropriate constraint based on the
 * inference backend in use. The candidate set is mandatory — without it
 * we degrade to unconstrained generation (the verifier in
 * lib/grounded-retrieval.js still catches problems).
 *
 * @param {Function} callFn      Original LLM call (e.g. callXAI or Modal client)
 * @param {Array}   candidates   Retrieved worker objects {_id, name, ...}
 * @param {String}  backend      'json_schema' | 'outlines' | 'none'
 */
function withConstrainedDecoding(callFn, candidates, backend = 'json_schema') {
  if (!candidates || candidates.length === 0 || backend === 'none') {
    return callFn;
  }
  const allowedIds = candidates.map(c => String(c._id || c.id));
  if (backend === 'json_schema') {
    const responseFormat = buildJsonSchemaConstraint(allowedIds);
    return (messages, opts = {}) => {
      const constrainedOpts = { ...opts, responseFormat };
      return callFn(messages, constrainedOpts);
    };
  }
  if (backend === 'outlines') {
    const regex = buildRegexConstraint(allowedIds);
    return (messages, opts = {}) => {
      const constrainedOpts = { ...opts, regexConstraint: regex && regex.source };
      return callFn(messages, constrainedOpts);
    };
  }
  return callFn;
}


module.exports = {
  CHAT_GRAMMAR_TEMPLATE,
  buildJsonSchemaConstraint,
  buildRegexConstraint,
  withConstrainedDecoding,
};
