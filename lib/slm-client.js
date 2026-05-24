/**
 * slm-client.js — OpenAI-compatible client for a self-hosted small language model.
 *
 * Drop-in replacement for callXAI when MODEL_VARIANT=local. Targets a llama.cpp
 * llama-server (or Ollama) endpoint exposing the OpenAI chat-completions API.
 *
 * Recommended setup (see docs/slm-runbook.md):
 *   - Hetzner CX22 ($5/mo, 2 vCPU + 4 GB RAM)
 *   - Qwen2.5-1.5B-Instruct quantized to Q4_K_M (~1.2 GB on disk)
 *   - llama-server bound to 0.0.0.0:8080 behind a reverse proxy with HTTPS
 *
 * Set env vars:
 *   SLM_ENDPOINT=https://slm.jak.ma/v1   (your self-hosted server)
 *   SLM_MODEL=qwen2.5-1.5b-darija         (or the GGUF filename)
 *   SLM_API_KEY=any                       (llama-server ignores it; set to "any")
 *   MODEL_VARIANT=local|grok|hybrid       (routing)
 *
 * Routing strategies (server.js wires these via MODEL_VARIANT):
 *   - "local"  → ALL requests go to the SLM. Cheap, lower quality on hard queries.
 *   - "grok"   → ALL requests go to xAI Grok (default).
 *   - "hybrid" → easy queries (regex-classified, high-confidence) go to SLM;
 *                hard queries (image input, multi-trade, low confidence,
 *                SLM unavailable) go to Grok. Best cost/quality trade-off.
 */

const nodeFetch = require('node-fetch');

const SLM_ENDPOINT = process.env.SLM_ENDPOINT;
const SLM_MODEL = process.env.SLM_MODEL || 'qwen2.5-1.5b-instruct';
const SLM_API_KEY = process.env.SLM_API_KEY || 'any';
const MODEL_VARIANT = process.env.MODEL_VARIANT || 'grok';

/**
 * OpenAI-compatible chat-completions call against the SLM.
 * Matches the shape of server.js's callXAI so it's a drop-in.
 */
async function callSLM(messages, opts = {}) {
  if (!SLM_ENDPOINT) {
    const err = new Error('SLM_ENDPOINT not configured');
    err.code = 'SLM_DISABLED';
    throw err;
  }
  const body = {
    model: SLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 400,
    stream: !!opts.stream,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  const url = `${SLM_ENDPOINT.replace(/\/$/, '')}/chat/completions`;
  return nodeFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

/**
 * Hybrid router. Decides between SLM and Grok based on:
 *   - MODEL_VARIANT env (forces one path if set to "local" or "grok")
 *   - Presence of image input (always Grok — SLM has no vision)
 *   - Classification confidence (low confidence → Grok for quality)
 *   - Multi-trade complexity (Grok for nuanced planning)
 *   - SLM endpoint availability (fall back to Grok on error)
 *
 * @returns {{ call: Function, variant: 'local'|'grok' }}
 */
function pickModel({ callXAI, hasImage, classification, multiTrade }) {
  // Hard routes
  if (MODEL_VARIANT === 'grok' || !SLM_ENDPOINT) return { call: callXAI, variant: 'grok' };
  if (MODEL_VARIANT === 'local') return { call: callSLM, variant: 'local' };

  // Hybrid: route by signal
  if (hasImage) return { call: callXAI, variant: 'grok' };
  if (multiTrade) return { call: callXAI, variant: 'grok' };
  if (classification && classification.confidence != null && classification.confidence < 0.7) {
    return { call: callXAI, variant: 'grok' };
  }
  // Easy query → SLM. If SLM is down, the caller will get an error and we
  // could retry on Grok; the wrapper below handles that.
  return { call: withGrokFallback(callXAI), variant: 'local' };
}

function withGrokFallback(callXAI) {
  return async (messages, opts) => {
    try {
      return await callSLM(messages, opts);
    } catch (err) {
      console.warn('[slm] failed, falling back to Grok:', err.message);
      return callXAI(messages, opts);
    }
  };
}

/**
 * Health-check the SLM endpoint. Returns {ok, latency_ms, model} or {ok:false, error}.
 * Used by /api/health.
 */
async function pingSLM(timeoutMs = 2000) {
  if (!SLM_ENDPOINT) return { ok: false, configured: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await nodeFetch(`${SLM_ENDPOINT.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${SLM_API_KEY}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ok: r.ok, latency_ms: Date.now() - t0, status: r.status, configured: true, model: SLM_MODEL };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, configured: true, error: err.message };
  }
}

module.exports = { callSLM, pickModel, pingSLM, MODEL_VARIANT, SLM_ENDPOINT, SLM_MODEL };
