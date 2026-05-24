/**
 * lib/agent-loop.js — single-round tool-calling agent for jak.ma follow-ups.
 *
 * Provider: Claude (Anthropic native tool calling). The loop deliberately
 * does NOT switch providers mid-conversation because mixing tool-call state
 * across Anthropic and Gemini formats is brittle. If Claude is unavailable,
 * the caller should catch and fall back to the existing grounded path.
 *
 * Loop shape: ReAct-flavored, single-round.
 *   Iter 0  : LLM with tools → either final answer OR tool_use blocks
 *   Tools   : execute up to N tools in parallel-ish (sequential here for
 *             clarity and predictable DB load), with per-tool timeout
 *   Iter 1  : LLM final answer with tools dropped (so it MUST produce text)
 *
 * onThinking callback: emits short Darija + emoji status strings between
 * tool calls. Wired by the caller to SSE thinking events so the UI shows
 * agent reasoning in real time.
 */

const { executeTool } = require('./tools');

const DEFAULT_MAX_ITERATIONS = 2;   // 1 round of tool calls + 1 final answer
const MAX_TOOLS_PER_ITERATION = 3;
// Hard allow-list of tool names. Defense-in-depth against the LLM
// hallucinating tool names. Must match lib/tools.js.
const ALLOWED_NAMES = new Set(['lookupWorkerById', 'getRecentReviews', 'estimatePrice']);

/**
 * Run a single-round tool-calling agent loop.
 *
 * @param {object} params
 * @param {Array}   params.messages       OpenAI-shape conversation history
 * @param {Array}   params.tools          Anthropic-shape tools[] (lib/tools.js#anthropicTools())
 * @param {Function} params.callClaude    LLM caller (server.js#callClaude)
 * @param {object}  params.ctx            { db, allowedWorkerIds }
 * @param {Function?} params.onThinking   onThinking(text) called between tool calls
 * @param {object?} params.llmOpts        Extra opts forwarded to callClaude (model, temperature, maxTokens, stream)
 * @param {number?} params.maxIterations  Default 2
 *
 * @returns {Promise<{ response, iterations, toolsCalled }>}
 *   response   : final OpenAI-shape response from callClaude
 *   iterations : number of LLM round-trips actually performed
 *   toolsCalled: [{ name, input_summary, ok, error, latency_ms }]
 */
async function runAgentLoop({
  messages,
  tools,
  callClaude,
  ctx,
  onThinking,
  llmOpts = {},
  maxIterations = DEFAULT_MAX_ITERATIONS,
}) {
  if (typeof callClaude !== 'function') {
    throw new Error('runAgentLoop: callClaude must be a function');
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('runAgentLoop: tools array required');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('runAgentLoop: messages array required');
  }
  const _think = typeof onThinking === 'function' ? onThinking : () => {};

  const conversation = [...messages];
  const toolsCalled = [];
  let iter = 0;

  for (iter = 0; iter < maxIterations; iter++) {
    const isLastIter = iter === maxIterations - 1;
    const opts = { ...llmOpts };

    // On the LAST iteration, drop the tools array so the model is forced
    // to produce a text answer rather than another tool call. This guarantees
    // termination with a user-visible response.
    if (!isLastIter) opts.tools = tools;
    // Final-iter responses are not streamed by this loop (caller can stream
    // them itself if desired by inspecting the response shape).

    let response;
    try {
      response = await callClaude(conversation, opts);
    } catch (err) {
      const wrapErr = new Error(`agent-loop: callClaude failed at iter ${iter}: ${err.message}`);
      wrapErr.status = err.status;
      wrapErr.cause = err;
      wrapErr.iteration = iter;
      wrapErr.toolsCalled = toolsCalled;
      throw wrapErr;
    }

    const data = await response.json();
    const msg = data?.choices?.[0]?.message;
    const tool_calls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls : [];

    // Path 1: no tool calls → final answer. Return it.
    if (tool_calls.length === 0) {
      return { response, iterations: iter + 1, toolsCalled };
    }

    // Path 2: we have tool calls but this is the last iteration — model
    // should not have been able to call tools (opts.tools was unset). Safety
    // net: ignore the calls and return what we have.
    if (isLastIter) {
      _think('⚠️ model attempted tool call on terminal iteration; returning current answer');
      return { response, iterations: iter + 1, toolsCalled };
    }

    // Echo the assistant turn back into the conversation. Use the raw
    // Anthropic content blocks so tool_use_id values match the next user
    // turn's tool_result blocks.
    if (msg.anthropic_content_blocks) {
      conversation.push({ role: 'assistant', content: msg.anthropic_content_blocks });
    } else {
      // Defensive fallback: synthesize blocks from the OpenAI-shape data.
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: _parseJsonSafe(tc.function.arguments),
        });
      }
      conversation.push({ role: 'assistant', content: blocks });
    }

    // Execute each tool (cap at MAX_TOOLS_PER_ITERATION). Tools run sequentially
    // to keep DB load predictable; latency budget is bounded by per-tool timeout
    // (see lib/tools.js#TOOL_TIMEOUT_MS).
    const toolResultBlocks = [];
    const capped = tool_calls.slice(0, MAX_TOOLS_PER_ITERATION);

    for (const tc of capped) {
      const name = tc.function?.name;
      const args = _parseJsonSafe(tc.function?.arguments);

      // Refuse anything not in the static allow-list (defense in depth).
      if (!ALLOWED_NAMES.has(name)) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: JSON.stringify({ error: 'unknown_tool', message: `No tool named "${name}".` }),
          is_error: true,
        });
        toolsCalled.push({
          name,
          input_summary: _summarize(args),
          ok: false,
          error: 'unknown_tool',
          latency_ms: 0,
        });
        _think(`⚠️ unknown tool: ${name}`);
        continue;
      }

      _think(_describeToolCall(name, args));

      const result = await executeTool(name, args, ctx);

      const block = {
        type: 'tool_result',
        tool_use_id: tc.id,
        // Stringify the tool result so Anthropic sees it as a content string.
        // (Anthropic also accepts content arrays, but string is simpler.)
        content: JSON.stringify(
          result.result != null ? result.result : { error: result.error, message: result.message }
        ),
      };
      if (!result.ok) block.is_error = true;
      toolResultBlocks.push(block);

      toolsCalled.push({
        name,
        input_summary: _summarize(args),
        ok: result.ok,
        error: result.ok ? null : result.error,
        latency_ms: result.latency_ms,
      });

      _think(_describeToolResult(name, result));
    }

    if (tool_calls.length > MAX_TOOLS_PER_ITERATION) {
      _think(`(capped ${tool_calls.length - MAX_TOOLS_PER_ITERATION} additional tool call(s) — limit ${MAX_TOOLS_PER_ITERATION}/iter)`);
    }

    // Push the user turn containing tool_result blocks. The next iteration
    // will then ask the model to use these results to produce a final answer.
    conversation.push({ role: 'user', content: toolResultBlocks });
  }

  // Defensive: should never reach here because the loop always returns inside.
  return { response: null, iterations: iter, toolsCalled };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _parseJsonSafe(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch { return {}; }
}

function _summarize(args) {
  // Compact one-line summary of tool inputs for the eval_logs record.
  if (!args || typeof args !== 'object') return null;
  const keys = Object.keys(args);
  return keys.slice(0, 4).map(k => {
    const v = args[k];
    let s;
    if (typeof v === 'string') s = v.slice(0, 30);
    else if (typeof v === 'object') s = JSON.stringify(v).slice(0, 30);
    else s = String(v);
    return `${k}=${s}`;
  }).join(', ');
}

function _describeToolCall(name, args) {
  // User-facing Darija + emoji description for SSE thinking events.
  switch (name) {
    case 'lookupWorkerById':
      return `🔍 كنشوف تفاصيل المعلم (${(args.workerId || '').slice(-6)})…`;
    case 'getRecentReviews':
      return `⭐ كنقلب على التقييمات الأخيرة…`;
    case 'estimatePrice':
      return `💰 كنحسب السعر العادل ل${args.trade || ''} ف${args.city || ''}…`;
    default:
      return `🔧 calling ${name}…`;
  }
}

function _describeToolResult(name, result) {
  const latency = result.latency_ms != null ? `${result.latency_ms}ms` : '';
  if (!result.ok) {
    return `⚠️ ${name} → ${result.error} (${latency})`;
  }
  switch (name) {
    case 'lookupWorkerById':
      return `✅ تم الحصول على التفاصيل (${latency})`;
    case 'getRecentReviews': {
      const n = result.result?.reviews?.length ?? 0;
      return `✅ جبت ${n} تقييم (${latency})`;
    }
    case 'estimatePrice': {
      const r = result.result || {};
      return `✅ ${r.price_min ?? '?'}-${r.price_max ?? '?'} ${r.currency || 'MAD'} / ${r.price_unit || ''} (${latency})`;
    }
    default:
      return `✅ ${name} (${latency})`;
  }
}

module.exports = {
  runAgentLoop,
  DEFAULT_MAX_ITERATIONS,
  MAX_TOOLS_PER_ITERATION,
};
