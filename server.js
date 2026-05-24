require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');
// Anthropic Claude — primary and only LLM provider (swapped from xAI Grok 2026-05)
const { PNG } = require('pngjs');
const nodeFetch = require('node-fetch');
const { PassThrough } = require('stream');
const escHtml = require('escape-html');
const { computePriceRange } = require('./scripts/price-engine');

const SESSION_SECRET = process.env.SESSION_SECRET || 'jak-ma-edit-2025-secret';
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;

// ─── SIGNED EDIT TOKEN (stateless, works across serverless instances) ──────
function signEditToken(workerId, phone) {
  const exp = Date.now() + 30 * 60 * 1000; // 30 min
  const payload = `${workerId}|${phone}|${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex').slice(0, 20);
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}
function verifyEditToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const last = decoded.lastIndexOf('|');
    const payload = decoded.slice(0, last);
    const sig = decoded.slice(last + 1);
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex').slice(0, 20);
    if (sig !== expectedSig) return null;
    const parts = payload.split('|');
    const [workerId, phone, exp] = parts;
    if (Date.now() > parseInt(exp)) return null;
    return { workerId, phone };
  } catch { return null; }
}

// ─── SMS OTP VIA TWILIO ───────────────────────────────────────────────────
// ─── INDEXNOW — ping Bing instantly when new content is added ────────────────
const INDEXNOW_KEY = '5628e6b83f50401da754a16b5a6c265e';
async function pingIndexNow(urls) {
  try {
    const host = 'jak.ma';
    const keyLocation = `https://${host}/${INDEXNOW_KEY}.txt`;
    const body = { host, key: INDEXNOW_KEY, keyLocation, urlList: Array.isArray(urls) ? urls : [urls] };
    await nodeFetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
  } catch (e) { /* non-critical — don't crash on ping failure */ }
}

async function sendSmsOtp(phone, code) {
  const intl = phone.startsWith('0') ? '+212' + phone.slice(1) : (phone.startsWith('+') ? phone : '+212' + phone);
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.log(`[DEV OTP] ${intl} → ${code}`); // check Vercel logs during dev
    return;
  }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  await nodeFetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: intl, From: TWILIO_FROM, Body: `رمز تأكيد جاك.ما: ${code}\nالرمز صالح 10 دقايق ⏱` }).toString()
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
// SECURITY: production deployments MUST set ADMIN_PASSWORD as an env var.
// The fallback string is intentionally a clearly-invalid placeholder in this
// public mirror — the production deploy uses a strong env-var value not
// committed to git. If you fork this repo, replace the fallback with your
// own strong secret or (recommended) require the env var to be present.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'set-ADMIN_PASSWORD-env-var-do-not-deploy-without-it';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const HF_TOKEN          = process.env.HF_TOKEN || '';
// Self-hosted Darija LoRA on HuggingFace Spaces (Qwen2.5-1.5B fine-tuned on
// 53k Darija examples). Used as the LAST-RESORT fallback when both Gemini
// and Anthropic fail (rate limit, outage, billing). Free tier on HF Spaces
// sleeps after idle so cold-start can be 20-60s — keep timeout short.
const HF_SPACE_URL      = process.env.HF_SPACE_URL || 'https://samielakkad1-jakma-darija-chat.hf.space';
const HF_FALLBACK_TIMEOUT_MS = parseInt(process.env.HF_FALLBACK_TIMEOUT_MS || '15000', 10);
const ANTHROPIC_VERSION = '2023-06-01';

// ─── Model selection ─────────────────────────────────────────────────────────
// Two-provider routing as of May 2026:
//   - DEFAULT  → gemini-3-flash   (cheap, fast, strong on Darija per AA Arabic=92)
//   - HARD     → claude-sonnet-4-5 (multi-trade, low-confidence, vision, long history)
//
// Why split: Gemini Flash hits the $0.0009/query CV target and has the best
// dialect coverage in the sub-$1 input tier. Claude Sonnet is the quality floor
// for cases where regex couldn't classify, an image was uploaded, the user
// asked for multiple trades at once, or the conversation has run long enough
// that context understanding matters more than cost.
//
// Both wrappers return OpenAI-shape responses so lib/grounded-retrieval.js and
// lib/price-fairness.js don't need to know which provider answered.
const GEMINI_MODEL_DEFAULT  = 'gemini-3-flash';
const GEMINI_MODEL_VISION   = 'gemini-3-flash';
const CLAUDE_MODEL_HARD     = 'claude-sonnet-4-5';
const CLAUDE_MODEL_DEFAULT  = 'claude-haiku-4-5'; // kept for back-compat with explicit model: opts in lib/
const CLAUDE_MODEL_VISION   = 'claude-haiku-4-5'; // kept for back-compat

// True when ANY LLM provider is configured. Endpoints gate on this since the
// router can fall back to whichever provider has a key.
const LLM_CONFIGURED = !!(ANTHROPIC_API_KEY || GEMINI_API_KEY);

// Feature flag: set GROUNDED_RETRIEVAL=1 in env to route /api/ai/chat through
// the new two-pass grounded retrieval pipeline (lib/grounded-retrieval.js).
// When OFF, the legacy chat handler below serves traffic. Flip to 1 after
// smoke tests + eval_logs review.
const USE_GROUNDED = process.env.GROUNDED_RETRIEVAL === '1';
const { handleGroundedChat } = require('./lib/grounded-retrieval');
const { evaluatePriceFairness, batchEvaluate } = require('./lib/price-fairness');
const { pingSLM, MODEL_VARIANT } = require('./lib/slm-client');

// ─── Anthropic Claude helper (returns OpenAI-shape so call sites are unchanged) ───
// Translates OpenAI-format input → Anthropic /v1/messages, then translates the
// response back into OpenAI shape (`data.choices[0].message.content` for non-
// streaming, OpenAI-style `data: {choices:[{delta:{content}}]}` SSE for streaming).
// This is intentional so the lib/ modules and downstream consumers don't need
// to know we swapped providers.

function _toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.type === 'text' && b.text) systemParts.push(b.text);
      }
      continue;
    }
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(b => {
        if (!b) return b;
        // OpenAI vision block → Anthropic image block
        if (b.type === 'image_url' && b.image_url && b.image_url.url) {
          const url = b.image_url.url;
          const match = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (match) {
            return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
          }
          return { type: 'image', source: { type: 'url', url } };
        }
        return b; // {type:"text", text:"..."} passes through
      });
    }
    out.push({ role: m.role, content });
  }
  return { system: systemParts.join('\n\n') || undefined, messages: out };
}

function _stripJsonFences(text) {
  // Claude often wraps JSON output in ```json ... ``` fences despite system
  // instructions saying no markdown. Strip them defensively so callers can
  // JSON.parse the result directly.
  return String(text || '')
    .trim()
    .replace(/^```(?:json|JSON)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function _wrapClaudeResponse(json, { jsonMode = false } = {}) {
  const blocks = json.content || [];
  let text = blocks
    .filter(b => b && b.type === 'text')
    .map(b => b.text)
    .join('');
  if (jsonMode) text = _stripJsonFences(text);

  // Extract tool_use blocks → OpenAI-shape tool_calls array. Surfacing both
  // formats lets agent-loop.js stay provider-agnostic: it reads
  // .choices[0].message.tool_calls without caring about Anthropic vs Gemini.
  // We also stash the raw blocks under .anthropic_content_blocks so the agent
  // loop can echo them back verbatim as the assistant turn (required by the
  // Anthropic tool-use protocol — the next user turn must contain matching
  // tool_use_id values).
  const toolUseBlocks = blocks.filter(b => b && b.type === 'tool_use');
  const tool_calls = toolUseBlocks.map(b => ({
    id: b.id,
    type: 'function',
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input || {}),
    },
  }));

  const message = { role: 'assistant', content: text };
  if (tool_calls.length > 0) {
    message.tool_calls = tool_calls;
    message.anthropic_content_blocks = blocks; // for echo-back on next turn
  }

  const openaiShape = {
    choices: [{ message, finish_reason: json.stop_reason || null }],
    usage: json.usage || null,
    model: json.model || null,
  };
  return { ok: true, status: 200, json: async () => openaiShape };
}

function _wrapClaudeStream(upstreamResp) {
  const pt = new PassThrough();
  (async () => {
    let buf = '';
    try {
      for await (const chunk of upstreamResp.body) {
        buf += chunk.toString('utf-8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
              pt.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.delta.text } }] })}\n\n`);
            } else if (ev.type === 'message_stop') {
              pt.write('data: [DONE]\n\n');
            }
          } catch { /* skip malformed events */ }
        }
      }
      pt.end();
    } catch (e) {
      pt.destroy(e);
    }
  })();
  return { ok: true, status: 200, body: pt };
}

async function callClaude(messages, {
  model = CLAUDE_MODEL_DEFAULT, temperature = 0.3, maxTokens = 400,
  jsonMode = false, stream = false, signal,
  tools, toolChoice,
} = {}) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set');
    err.status = 0;
    throw err;
  }
  const { system, messages: anthMessages } = _toAnthropicMessages(messages);
  const finalSystem = jsonMode
    ? `${system ? system + '\n\n' : ''}Respond with valid JSON only. No prose, no markdown fences, no commentary.`
    : system;

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: anthMessages,
    stream,
  };
  if (finalSystem) body.system = finalSystem;

  // Tool calling — Anthropic native format. Caller passes the Anthropic-shape
  // schemas directly (lib/tools.js#anthropicTools()). `toolChoice` is rare;
  // default is "auto" (model decides). Pass "any" to force a tool call, or
  // {type:"tool", name:"X"} to pin a specific tool.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  const resp = await nodeFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }

  if (stream) return _wrapClaudeStream(resp);
  const json = await resp.json();
  return _wrapClaudeResponse(json, { jsonMode });
}

// ─── Google Gemini helper (returns the same OpenAI-shape) ────────────────────
// Mirror of callClaude. Translates OpenAI-format messages to Gemini's
// {contents:[{role, parts:[{text|inlineData}]}], systemInstruction, generationConfig}
// shape, and translates Gemini responses (and SSE streams) back to OpenAI shape
// so all downstream code stays identical.

function _toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.type === 'text' && b.text) systemParts.push(b.text);
      }
      continue;
    }
    // Gemini uses "user" and "model" roles (not "assistant")
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (Array.isArray(m.content)) {
      parts = m.content.map(b => {
        if (!b) return null;
        if (b.type === 'text' && b.text) return { text: b.text };
        if (b.type === 'image_url' && b.image_url && b.image_url.url) {
          const url = b.image_url.url;
          const match = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
          // Gemini also accepts file_data for remote URIs
          return { fileData: { fileUri: url } };
        }
        // Tool-calling blocks: translate Anthropic-shape tool_use / tool_result
        // into Gemini's functionCall / functionResponse parts. Note: tool_result
        // carries tool_use_id (Anthropic) but Gemini binds by function name.
        // Caller must pass `name` alongside tool_use_id when targeting Gemini.
        if (b.type === 'tool_use' && b.name) {
          return { functionCall: { name: b.name, args: b.input || {} } };
        }
        if (b.type === 'tool_result' && (b.name || b._gemini_name)) {
          return {
            functionResponse: {
              name: b.name || b._gemini_name,
              response: { result: b.content },
            },
          };
        }
        return null;
      }).filter(Boolean);
    } else if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else {
      parts = [{ text: '' }];
    }
    contents.push({ role, parts });
  }
  const system = systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined;
  return { system, contents };
}

function _geminiTextFromCandidate(cand) {
  const parts = cand?.content?.parts || [];
  return parts.filter(p => p && typeof p.text === 'string').map(p => p.text).join('');
}

function _wrapGeminiResponse(json, { jsonMode = false } = {}) {
  const cand = (json.candidates || [])[0] || {};
  const parts = cand?.content?.parts || [];

  let text = parts.filter(p => p && typeof p.text === 'string').map(p => p.text).join('');
  if (jsonMode) text = _stripJsonFences(text);

  // Extract functionCall parts → OpenAI-shape tool_calls. Gemini doesn't
  // return its own call id; synthesize a stable one so agent-loop can echo
  // matching tool_result blocks back.
  const fnCalls = parts.filter(p => p && p.functionCall);
  const tool_calls = fnCalls.map((p, i) => ({
    id: `gemini-call-${i}-${p.functionCall.name}`,
    type: 'function',
    function: {
      name: p.functionCall.name,
      arguments: JSON.stringify(p.functionCall.args || {}),
    },
  }));

  const message = { role: 'assistant', content: text };
  if (tool_calls.length > 0) {
    message.tool_calls = tool_calls;
    message.gemini_parts = parts; // echo-back for next agent turn
  }

  const openaiShape = {
    choices: [{ message, finish_reason: cand.finishReason || null }],
    usage: json.usageMetadata || null,
    model: json.modelVersion || null,
  };
  return { ok: true, status: 200, json: async () => openaiShape };
}

function _wrapGeminiStream(upstreamResp) {
  const pt = new PassThrough();
  (async () => {
    let buf = '';
    try {
      for await (const chunk of upstreamResp.body) {
        buf += chunk.toString('utf-8');
        // Gemini streamGenerateContent with ?alt=sse emits SSE lines
        // ("data: {...}\n\n") just like OpenAI. Parse them.
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload);
            const token = _geminiTextFromCandidate((ev.candidates || [])[0] || {});
            if (token) {
              pt.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
            }
            const finish = (ev.candidates || [])[0]?.finishReason;
            if (finish) pt.write('data: [DONE]\n\n');
          } catch { /* skip malformed events */ }
        }
      }
      pt.end();
    } catch (e) {
      pt.destroy(e);
    }
  })();
  return { ok: true, status: 200, body: pt };
}

async function callGemini(messages, {
  model = GEMINI_MODEL_DEFAULT, temperature = 0.3, maxTokens = 400,
  jsonMode = false, stream = false, signal,
  tools, toolChoice,
} = {}) {
  if (!GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not set');
    err.status = 0;
    throw err;
  }
  const { system, contents } = _toGeminiContents(messages);
  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
  };
  if (jsonMode) generationConfig.responseMimeType = 'application/json';

  const body = { contents, generationConfig };
  if (system) body.systemInstruction = system;

  // Tool calling — Gemini native function calling. Caller passes Gemini-shape
  // tools (lib/tools.js#geminiTools()), which is an array containing a single
  // { functionDeclarations: [...] } entry.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    // toolChoice → toolConfig.functionCallingConfig.mode in Gemini:
    //   'auto' (default) | 'any' (force one) | 'none' (forbid)
    if (toolChoice === 'any') {
      body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (toolChoice === 'none') {
      body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    }
  }

  const endpoint = stream
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await nodeFetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(`Gemini API ${resp.status}: ${errText.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }

  if (stream) return _wrapGeminiStream(resp);
  const json = await resp.json();
  return _wrapGeminiResponse(json, { jsonMode });
}

// ─── HuggingFace Space helper (Gradio /generate endpoint) ────────────────────
// Last-resort fallback. The Space is a Qwen2.5-1.5B model fine-tuned on
// 53k Darija examples — so it's actually GOOD at Darija but tiny, no vision,
// no system prompt, no JSON mode, no streaming back to the user. We extract
// the last user message, send it as a single string, and wrap the response
// in OpenAI shape so downstream code doesn't care.
//
// Gradio 4.x HTTP API:
//   1. POST  /gradio_api/call/generate    body: {"data":["msg"]}  → {event_id}
//   2. GET   /gradio_api/call/generate/<event_id>  → SSE: data: [...], event: complete

function _extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
      if (text) return text;
    }
  }
  return '';
}

async function callHF(messages, { signal } = {}) {
  const userText = _extractLastUserText(messages).trim();
  if (!userText) {
    const err = new Error('HF fallback: no user text to send');
    err.status = 0;
    throw err;
  }
  const ctrl = signal ? null : new AbortController();
  const sig = signal || ctrl?.signal;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HF_FALLBACK_TIMEOUT_MS) : null;

  try {
    // Step 1: kick off the job
    const headers = { 'content-type': 'application/json' };
    if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;
    const postResp = await nodeFetch(`${HF_SPACE_URL}/gradio_api/call/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: [userText] }),
      signal: sig,
    });
    if (!postResp.ok) {
      const t = await postResp.text().catch(() => '');
      throw new Error(`HF Space POST ${postResp.status}: ${t.slice(0, 200)}`);
    }
    const postJson = await postResp.json();
    const eventId = postJson?.event_id;
    if (!eventId) throw new Error('HF Space: no event_id in response');

    // Step 2: poll the SSE stream
    const getResp = await nodeFetch(`${HF_SPACE_URL}/gradio_api/call/generate/${eventId}`, {
      method: 'GET',
      headers,
      signal: sig,
    });
    if (!getResp.ok) {
      const t = await getResp.text().catch(() => '');
      throw new Error(`HF Space GET ${getResp.status}: ${t.slice(0, 200)}`);
    }

    // Parse SSE — find the last `event: complete` block's data line
    let buf = '';
    let lastData = null;
    let currentEvent = null;
    for await (const chunk of getResp.body) {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload);
          // Gradio returns an array of outputs; /generate has one output so it's parsed[0]
          if (currentEvent === 'complete' || currentEvent === 'generating') {
            lastData = Array.isArray(parsed) ? parsed[0] : parsed;
          }
        } catch { /* skip malformed */ }
      }
    }
    if (lastData == null) throw new Error('HF Space: no data event received');

    const text = String(lastData);
    const openaiShape = {
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: null,
      model: 'jakma-darija-qwen2.5-1.5b-lora',
    };
    return { ok: true, status: 200, json: async () => openaiShape };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function _isHFConfigured() {
  return !!HF_SPACE_URL;
}

// ─── Provider router ─────────────────────────────────────────────────────────
// Picks Claude Sonnet for "hard" queries, Gemini Flash for everything else.
// Callers pass routing hints; the router decides provider + model.
//
// Hard signals (any of these → Sonnet):
//   - hasImage:        image upload (vision quality matters)
//   - multiTrade:      MULTI_TRADE_PATTERNS hit (multi-step reasoning)
//   - lowConfidence:   regex/LLM classifier confidence < 0.7
//   - longHistory:     conversation history > 5 turns
//   - forceProvider:   explicit override ('claude' | 'gemini')
//
// Explicit `model` in opts always wins (back-compat for libs that pin a model).

function _isHardQuery(routing = {}) {
  if (routing.forceProvider === 'claude') return true;
  if (routing.forceProvider === 'gemini') return false;
  return !!(routing.hasImage || routing.multiTrade || routing.lowConfidence || routing.longHistory);
}

async function callLLM(messages, opts = {}) {
  const { routing = {}, model: explicitModel, ...rest } = opts;

  // Pick the intended (provider, model) pair.
  let intent;
  if (explicitModel) {
    intent = /^gemini-/i.test(explicitModel)
      ? { provider: 'gemini', model: explicitModel }
      : { provider: 'claude', model: explicitModel };
  } else if (_isHardQuery(routing)) {
    intent = { provider: 'claude', model: CLAUDE_MODEL_HARD };
  } else {
    intent = { provider: 'gemini', model: GEMINI_MODEL_DEFAULT };
  }

  // Build the try-order chain. Primary first, then the other commercial
  // provider, then the HF Darija LoRA Space as final fallback.
  //   - primary    = whatever the router picked
  //   - secondary  = the other commercial provider (if configured)
  //   - tertiary   = HF Space (Qwen2.5-1.5B Darija LoRA, no streaming, no JSON)
  const chain = [];

  if (intent.provider === 'gemini') {
    if (GEMINI_API_KEY) chain.push({ name: 'gemini', fn: () => callGemini(messages, { ...rest, model: intent.model }) });
    if (ANTHROPIC_API_KEY) chain.push({ name: 'claude', fn: () => callClaude(messages, { ...rest, model: CLAUDE_MODEL_DEFAULT }) });
  } else {
    if (ANTHROPIC_API_KEY) chain.push({ name: 'claude', fn: () => callClaude(messages, { ...rest, model: intent.model }) });
    if (GEMINI_API_KEY) chain.push({ name: 'gemini', fn: () => callGemini(messages, { ...rest, model: GEMINI_MODEL_DEFAULT }) });
  }

  // HF Space tertiary fallback. Skip when:
  //   - stream:  HF wrapper is fire-and-poll, no real streaming
  //   - jsonMode: small Darija LoRA isn't reliable at JSON output
  //   - tools:   HF model has no tool-calling training
  const hasTools = Array.isArray(rest.tools) && rest.tools.length > 0;
  if (_isHFConfigured() && !rest.stream && !rest.jsonMode && !hasTools) {
    chain.push({ name: 'hf-darija-lora', fn: () => callHF(messages, { signal: rest.signal }) });
  }

  if (chain.length === 0) {
    const err = new Error('No LLM provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY)');
    err.status = 0;
    throw err;
  }

  // Walk the chain — return the first success, log every failure so we can
  // see degradation in production logs.
  let lastErr = null;
  for (const tier of chain) {
    try {
      const resp = await tier.fn();
      if (tier !== chain[0]) {
        console.warn(`[router] degraded to ${tier.name} after primary failed: ${lastErr?.message}`);
      }
      return resp;
    } catch (err) {
      lastErr = err;
      console.warn(`[router] ${tier.name} failed (${err.status || 'no-status'}): ${(err.message || '').slice(0, 200)}`);
    }
  }
  throw lastErr || new Error('All LLM providers failed');
}

// Back-compat alias — older code paths still call the function as `callXAI`.
// Now routes through the multi-provider router by default. Lib modules that
// pass explicit `model: 'claude-...'` or `model: 'gemini-...'` still pin
// their provider; ones that omit model get the router's pick.
const callXAI = callLLM;

// ─── DATABASE ────────────────────────────────────────────────────────────────
let db = null;
let dbPromise = null; // singleton promise — reused across requests

async function connectDB() {
  if (db) return db;
  if (!MONGODB_URI) return null;
  if (dbPromise) return dbPromise; // already connecting
  dbPromise = (async () => {
    try {
      const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      await client.connect();
      db = client.db('brikoul');
      console.log('✅ Connected to MongoDB');
      await initWorkers();
      await ensureIndexes();
      await ensureTTLIndexes();
      return db;
    } catch (err) {
      console.error('MongoDB connection failed:', err.message);
      dbPromise = null; // allow retry next request
      return null;
    }
  })();
  return dbPromise;
}

// Load workers from local backup into DB if collection is empty
async function initWorkers() {
  try {
    const col = db.collection('workers');
    const count = await col.countDocuments();
    if (count > 0) return;
    if (!fs.existsSync(WORKERS_FILE)) return;
    const workers = JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf8'));
    const docs = workers.map(w => ({
      ...w,
      approved: w.approved !== false,
      createdAt: w.createdAt || w.created_at ? new Date(w.createdAt || w.created_at) : new Date()
    }));
    const BATCH = 500;
    for (let i = 0; i < docs.length; i += BATCH) {
      await col.insertMany(docs.slice(i, i + BATCH));
    }
    await col.createIndex({ category: 1 });
    await col.createIndex({ city: 1 });
    await col.createIndex({ approved: 1 });
    await col.createIndex({ createdAt: -1 });
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

// Composite indexes required by grounded retrieval (lib/grounded-retrieval.js).
// Idempotent — MongoDB no-ops when the index already exists. Logged once per cold start.
async function ensureIndexes() {
  try {
    const col = db.collection('workers');
    await col.createIndex({ category: 1, city: 1, approved: 1, available: 1 });
    await col.createIndex({ secondary_categories: 1, city: 1, approved: 1 });
    await col.createIndex({ category: 1, featured: -1, verified: -1, rating: -1 });
    // BM25 sparse retrieval index for hybrid search (lib/hybrid-retrieval.js)
    try {
      const { ensureTextIndex } = require('./lib/hybrid-retrieval');
      await ensureTextIndex(db);
    } catch (e) { /* non-fatal */ }
    console.log('[indexes] ensured: workers retrieval indexes + BM25 text index');
  } catch (err) {
    console.error('[indexes] ensure failed:', err.message);
  }
}

// TTL indexes for ephemeral collections (eval logs, price-fairness cache).
// `expireAfterSeconds` is enforced by Mongo's TTL monitor (best-effort, runs ~every 60s).
async function ensureTTLIndexes() {
  try {
    // eval_logs — keep 90 days for offline analysis, then auto-drop
    await db.collection('eval_logs').createIndex({ ts: 1 }, { expireAfterSeconds: 7776000 });
    // price_fairness_cache — 24h TTL so worker profile/price changes get a fresh verdict
    await db.collection('price_fairness_cache').createIndex({ ts: 1 }, { expireAfterSeconds: 86400 });
    await db.collection('price_fairness_cache').createIndex({ cache_key: 1 }, { unique: true });
    // chat_cache — 1h TTL for grounded retrieval Pass-2 output reuse
    await db.collection('chat_cache').createIndex({ ts: 1 }, { expireAfterSeconds: 3600 });
    await db.collection('chat_cache').createIndex({ key: 1 }, { unique: true });
    console.log('[indexes] ensured: TTL indexes (eval_logs 90d, price_fairness_cache 24h, chat_cache 1h)');
  } catch (err) {
    console.error('[indexes] TTL ensure failed:', err.message);
  }
}

// Local data store
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const WORKERS_FILE = path.join(DATA_DIR, 'workers.json');

function loadWorkersJSON() {
  if (!fs.existsSync(WORKERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf8'));
}
function saveWorkersJSON(data) {
  fs.writeFileSync(WORKERS_FILE, JSON.stringify(data, null, 2));
}

// Unified worker functions — always await connectDB() first
async function getWorkers(filter = {}) {
  await connectDB();
  if (db) {
    const query = { ...filter };
    if (!query.hasOwnProperty('approved')) query.approved = { $ne: false };
    return db.collection('workers').find(query).sort({ _id: -1 }).toArray();
  }
  let workers = loadWorkersJSON().filter(w => w.approved !== false);
  if (filter.category) workers = workers.filter(w => w.category === filter.category);
  // Handle $or filter shape used by /api/workers (primary OR secondary category)
  if (filter.$or && Array.isArray(filter.$or)) {
    workers = workers.filter(w => filter.$or.some(clause => {
      if (clause.category) return w.category === clause.category;
      if (clause.secondary_categories) return Array.isArray(w.secondary_categories) && w.secondary_categories.includes(clause.secondary_categories);
      return false;
    }));
  }
  if (filter.city) workers = workers.filter(w => w.city === filter.city);
  // Newest first — mirror the MongoDB sort({ _id: -1 }) behaviour
  workers.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return workers;
}

async function getWorkerById(id) {
  await connectDB();
  if (db) {
    try { return await db.collection('workers').findOne({ _id: new ObjectId(id) }); } catch {}
    return await db.collection('workers').findOne({ id: parseInt(id) });
  }
  return loadWorkersJSON().find(w => w.id == id);
}

async function addWorker(worker) {
  await connectDB();
  if (db) {
    const result = await db.collection('workers').insertOne(worker);
    return { ...worker, _id: result.insertedId };
  }
  // local fallback
  if (MONGODB_URI) throw new Error('MongoDB not ready — try again in a moment');
  const workers = loadWorkersJSON();
  worker.id = workers.length > 0 ? Math.max(...workers.map(w => w.id || 0)) + 1 : 1;
  workers.unshift(worker);
  saveWorkersJSON(workers);
  return worker;
}

async function deleteWorker(id) {
  await connectDB();
  if (db) {
    try { return await db.collection('workers').deleteOne({ _id: new ObjectId(id) }); } catch {}
    return await db.collection('workers').deleteOne({ id: parseInt(id) });
  }
  const workers = loadWorkersJSON().filter(w => w.id != id);
  saveWorkersJSON(workers);
}

async function approveWorker(id) {
  await connectDB();
  if (db) {
    try { return await db.collection('workers').updateOne({ _id: new ObjectId(id) }, { $set: { approved: true } }); } catch {}
    return await db.collection('workers').updateOne({ id: parseInt(id) }, { $set: { approved: true } });
  }
  const workers = loadWorkersJSON();
  const w = workers.find(w => w.id == id);
  if (w) { w.approved = true; saveWorkersJSON(workers); }
}

async function countWorkers() {
  await connectDB();
  if (db) return db.collection('workers').countDocuments({ approved: { $ne: false } });
  return loadWorkersJSON().filter(w => w.approved !== false).length;
}

// ─── CONFIG ────────────────────────────────────────────────────────────────

const CITY_COORDS = {
  'طنجة': { lat: 35.7595, lng: -5.8340 },
  'الدار البيضاء': { lat: 33.5731, lng: -7.5898 },
  'الرباط': { lat: 34.0209, lng: -6.8416 },
  'مراكش': { lat: 31.6295, lng: -7.9811 },
  'فاس': { lat: 34.0181, lng: -5.0078 },
  'أكادير': { lat: 30.4278, lng: -9.5981 },
  'مكناس': { lat: 33.8935, lng: -5.5473 },
  'وجدة': { lat: 34.6814, lng: -1.9086 },
  'سلا': { lat: 34.0531, lng: -6.7985 },
  'تطوان': { lat: 35.5785, lng: -5.3684 },
  'القنيطرة': { lat: 34.2610, lng: -6.5802 },
  'بني ملال': { lat: 32.3373, lng: -6.3498 },
  'الجديدة': { lat: 33.2316, lng: -8.5007 },
  'سطات': { lat: 33.0014, lng: -7.6164 },
  'الناظور': { lat: 35.1681, lng: -2.9298 },
};

const ENGLISH_TO_ARABIC_CAT = {
  'electric': 'طريسيان', 'electrician': 'طريسيان', 'electricity': 'طريسيان',
  'clean': 'نقاوة', 'cleaning': 'نقاوة', 'maid': 'نقاوة',
  'build': 'بناء', 'construction': 'بناء', 'builder': 'بناء',
  'plumb': 'بلومبي', 'plumber': 'بلومبي', 'pipe': 'بلومبي',
  'paint': 'صباغة', 'painter': 'صباغة', 'painting': 'صباغة',
  'wood': 'نجارة', 'carpenter': 'نجارة', 'carpentry': 'نجارة',
  'weld': 'حدادة', 'welder': 'حدادة', 'metal': 'حدادة',
  'decor': 'ديكور', 'decoration': 'ديكور', 'interior': 'ديكور',
  'move': 'نقل', 'moving': 'نقل', 'transport': 'نقل', 'delivery': 'نقل',
  'tile': 'كلامبيستري', 'bathroom': 'كلامبيستري', 'plumbing': 'كلامبيستري',
  'tailor': 'خياطة', 'sewing': 'خياطة', 'dress': 'خياطة',
  'security': 'حراسة', 'guard': 'حراسة', 'watchman': 'حراسة',
};

const ENGLISH_TO_ARABIC_CITY = {
  'tangier': 'طنجة', 'tanger': 'طنجة',
  'casablanca': 'الدار البيضاء', 'casa': 'الدار البيضاء',
  'rabat': 'الرباط',
  'marrakech': 'مراكش', 'marrakesh': 'مراكش',
  'fez': 'فاس', 'fes': 'فاس',
  'agadir': 'أكادير',
  'meknes': 'مكناس',
  'oujda': 'وجدة',
  'sale': 'سلا',
  'tetouan': 'تطوان',
  'kenitra': 'القنيطرة',
  'settat': 'سطات',
  'nador': 'الناظور',
};


// Return only safe public fields for a worker
const PUBLIC_FIELDS = new Set([
  '_id','name','category','secondary_categories','original_category','description','city','zone','phone',
  'price','price_min','price_max','price_unit','experience','tags','available','verified',
  'featured','rating','rating_count','jobs_done','reviews',
  'created_at','source','photo','work_photos','lat','lng','address','updatedAt'
]);
function sanitizeWorker(w) {
  const out = {};
  for (const k of PUBLIC_FIELDS) if (w[k] !== undefined) out[k] = w[k];
  if (out.reviews) out.reviews = (out.reviews).map(r => ({
    reviewer_name: r.reviewer_name || r.name || 'مجهول',
    stars: r.stars,
    text: r.text
  }));
  return out;
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit: max 5 new registrations per IP per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'عيطي من بعد — خدمت بزاف ديال الطلبات' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit: max 5 OTP sends per IP per hour
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'عيطي من بعد — خدمت بزاف ديال الرموز' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit: max 30 AI requests per IP per hour
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'دوز شوية — خدمت بزاف ديال الأسئلة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit: max 10 reviews per IP per hour (anti-spam)
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'دوز شوية — بزاف ديال التقييمات' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── AI HELPERS ───────────────────────────────────────────────────────────────
const KEYWORD_TO_CAT = {
  // بلومبي — plumbing, water, pipes, toilets, drains (must come before نجارة to take priority for PVC pipes)
  // Note: bare حمام removed (collides with bathroom-tiling). Use specific phrases.
  'سرب|تسريب|صنبور|دوش|بانيو|مرحاض|طواليت|بيبان|تيوبو|مصرف|بالوعة|صفاية|شوفاج الما|سخان الما|ضغط الما|حمام تسريب|حمام صنبور|حمام بيبان|تيوبو pvc|بيب pvc|pvc pipe|tube pvc|conduite pvc|سرب pvc|fuite|plomb|robinet|douche|baignoire|wc|toilette|tuyau|evacuation|siphon|chauffe.eau|cumulus|vanne|chasse|pompe|sanitaire|plomberie': 'بلومبي',
  // طريسيان — electricity, wiring, outlets, breakers
  // Note: bare تابلو removed (collides with decorative tableau). Use تابلو كهربائي only.
  'كهرب|تيار|ضو|نور|فيشة|بريزة|قاطع|ديسجونكتور|تابلو كهربائي|سلك|كابلاج|كورتسيرة|لمبة|بلافوني|إنارة|جرس|إنتيرفون|كليماتيزور|electricien|électricien|electricite|électricité|courant|prise|disjoncteur|câblage|cablage|court.circuit|ampoule|luminaire|interphone|sonnette|climatiseur|clim|airzone': 'طريسيان',
  // صباغة — painting, walls, interior/exterior finish
  'صباغ|طلاء|دهان|رنكة|تصبيغ|حيط مقشور|طلاء طايح|بقعة|sous.couche|peinture|peint|enduit|crépi|crepi|ravalement|façade': 'صباغة',
  // نجارة — wood, doors, windows, cabinets, parquet
  // Note: bare شباك/شبابيك removed (collides with metal/aluminium windows). Always specify خشب.
  'نجار|خشب|باب الخشب|شباك خشب|شبابيك خشب|شباك بلانش|خزانة|دولاب|باركي|بلانش|كيتشن|مطبخ خشب|menuisier|menuiserie|bois|parquet|placard|armoire|porte bois|cuisine bois|fenetre bois|fenêtre bois': 'نجارة',
  // بناء — masonry, construction, cement, renovation, cracks
  'بناء|جدار|سيمان|تشقق|ترميم|هدم|خرسانة|فيسور|بلوك|إيتانشيتي السطح|chape|maçon|macon|béton|beton|fissure|btp|construction|gros oeuvre|gros œuvre': 'بناء',
  // نقاوة — cleaning, housekeeping
  // Note: word-bounded forms (handled by detectFromText) keep déménagement out.
  'نقاوة|تنظيف|نضافة|كنس|مسح|تعقيم|زرابي|كنبة|فوطة|فيترين|femme de menage|femme de ménage|ménage|menage|nettoyage|desinfection|désinfection|lavage|nettoy': 'نقاوة',
  // حدادة — metalwork, welding, gates, grilles, metal/aluminium windows
  'حديد|حداد|سودور|بوابة|سياج|درابزين|باب حديد|شباك حديد|شبابيك حديد|شبابيك ألومنيوم|شباك ألومنيوم|ألومنيوم|aluminium|ferronnerie|soudeur|soudure|portail|grille|clôture|cloture|garde.corps|serrure|serrurier|serrurerie|inox|fer forgé|fer forge|métallique|metallique|construction métallique': 'حدادة',
  // ديكور — interior design, false ceilings, gypsum
  // Note: bare تابلو removed (was electrical panel collision). décor/design ok.
  'ديكور|فوس بلافون|جبس|تصميم داخلي|ورق الحيطان|تزيين|ستارة|تابلو ديكور|tableau decoration|décor|decor|decoration|décoration|faux plafond|platre|plâtre|papier peint|design|aménagement|amenagement': 'ديكور',
  // نقل — moving, transport
  'نقل|تحويل|عفش|شاحنة|تاشيرة|déménagement|demenagement|déménag|demenag|transport|camion|déménageur|demenageur': 'نقل',
  // كلامبيستري — tiling, zellige, waterproofing terraces
  'زليج|بلاط|كارو|تبليط|فايانس|رخام|مربعات|إيتانشيتي|carrelage|carrel|carreleur|zellige|faïence|faience|marbre|étanchéité|etancheite|pose carrelage|revêtement|revetement|floor|sol': 'كلامبيستري',
  // خياطة — tailoring, alterations, curtains
  'خياطة|خياط|تقصير|تضييق|تكبير|قفطان|جلابة|ستائر|تنجيد|couture|couturier|retouche|rideau|rideaux|tapisserie': 'خياطة',
  // حراسة — security, guards
  'حراسة|حارس|أمن|غاردي|vigile|securite|sécurité|securitech|gardien|gardiennage|surveillance': 'حراسة',
};

const KEYWORD_TO_CITY = {
  'كازا|كازابلانكا|الدار البيضاء|casa|casablanca': 'الدار البيضاء',
  'الرباط|رباط|rabat': 'الرباط',
  'طنجة|tanger|tangier': 'طنجة',
  'مراكش|marrakech': 'مراكش',
  'أكادير|agadir': 'أكادير',
  'فاس|fes|fez': 'فاس',
  'سلا|salé|sale': 'سلا',
  'مكناس|meknes|meknès': 'مكناس',
  'وجدة|oujda': 'وجدة',
  'القنيطرة|kenitra|kénitra': 'القنيطرة',
  'تطوان|tetouan|tétouan': 'تطوان',
  'الجديدة|jadida|el jadida': 'الجديدة',
  'بني ملال|beni mellal': 'بني ملال',
  'خريبكة|khouribga': 'خريبكة',
  'سطات|settat': 'سطات',
};

const VALID_CATS = ['بلومبي','طريسيان','صباغة','نجارة','بناء','نقاوة','حدادة','ديكور','نقل','كلامبيستري','خياطة','حراسة'];

// AI single-shot classifier — returns { primary, secondary } or null on failure.
// Used at registration time to flag mismatches between the user's chosen category and what the AI thinks.
async function classifyWorkerAI({ name, description, tags }) {
  if (!LLM_CONFIGURED) return null;
  try {
    const prompt = `صنف ليا هاد المعلم واحد. أنواع الخدمة: ${VALID_CATS.join('، ')}.
رجع JSON بصاح: {"primary":"...", "secondary":[...]}.
قواعد:
- شبابك ألومنيوم ولا حديد → حدادة. شبابك ديال الخشب → نجارة.
- Plomberie+Electricité → primary هو اللي بان كتر فالسمية، الآخر دير فsecondary.
- Déménagement → نقل (ماشي نقاوة، حيت "ménage" غير بحال "déménagement").
- Faux plafond ولا جبس → ديكور. Carrelage ولا زليج → كلامبيستري.

name="${(name || '').slice(0, 100)}" desc="${(description || '').slice(0, 200)}" tags=${JSON.stringify(tags || [])}`;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await callLLM(
      [{ role: 'user', content: prompt }],
      // Worker-categorization classifier: structured JSON, no signals → Gemini Flash
      { model: GEMINI_MODEL_DEFAULT, temperature: 0, maxTokens: 80, jsonMode: true, signal: ctrl.signal }
    );
    const data = await r.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const parsed = JSON.parse(text);
    const primary = VALID_CATS.includes(parsed.primary) ? parsed.primary : null;
    if (!primary) return null;
    const secondary = Array.isArray(parsed.secondary)
      ? parsed.secondary.filter(x => VALID_CATS.includes(x) && x !== primary)
      : [];
    return { primary, secondary };
  } catch (e) {
    console.error('classifyWorkerAI failed:', e.message);
    return null;
  }
}

// Latin script letters (incl. accented): word-boundary match. Arabic: substring is fine
// (Arabic words bind tightly via affixes, not whitespace, so word-boundary regex misfires).
const LATIN_RE = /[a-zà-ÿ]/i;
function detectFromText(text, map) {
  const lower = (text || '').toLowerCase();
  for (const [pattern, value] of Object.entries(map)) {
    const kws = pattern.split('|');
    for (const kw of kws) {
      if (LATIN_RE.test(kw)) {
        // word-bounded — \b doesn't work great with accented chars, so use lookarounds
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?:^|[^a-zà-ÿ])${escaped}(?:[^a-zà-ÿ]|$)`, 'i');
        if (re.test(lower)) return value;
      } else {
        if (lower.includes(kw)) return value;
      }
    }
  }
  return null;
}

// Admin auth middleware — header only (never accept password in URL query string)
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API ROUTES
// ═══════════════════════════════════════════════════════════════════════════


app.get('/api/workers', async (req, res) => {
  const { category, city, search } = req.query;
  try {
    // Match primary OR secondary categories so multi-trade businesses show up under all relevant pills
    let workers = await getWorkers(
      (category && category !== 'all'
        ? { $or: [{ category }, { secondary_categories: category }] }
        : {})
    );
    // JSON fallback inside getWorkers may not honor $or — apply same filter in JS as a safety net
    if (category && category !== 'all') {
      workers = workers.filter(w => w.category === category || (Array.isArray(w.secondary_categories) && w.secondary_categories.includes(category)));
    }
    if (city && city !== 'all') workers = workers.filter(w => w.city === city);
    if (search) {
      const q = search.toLowerCase().trim();
      const queryWords = q.split(/\s+/).filter(w => w.length > 0);
      const terms = new Set();
      queryWords.forEach(word => {
        terms.add(word);
        if (ENGLISH_TO_ARABIC_CAT[word]) terms.add(ENGLISH_TO_ARABIC_CAT[word].toLowerCase());
        if (ENGLISH_TO_ARABIC_CITY[word]) terms.add(ENGLISH_TO_ARABIC_CITY[word].toLowerCase());
      });
      const termsArr = Array.from(terms);
      workers = workers.filter(w => {
        const s = [w.name, w.description, w.category, w.city, w.zone].join(' ').toLowerCase();
        return termsArr.some(t => s.includes(t));
      });
    }
    res.json(workers.map(sanitizeWorker));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/workers/:id', async (req, res) => {
  const worker = await getWorkerById(req.params.id);
  if (!worker) return res.status(404).json({ error: 'not found' });
  res.json(sanitizeWorker(worker));
});

app.post('/api/workers', registerLimiter, async (req, res) => {
  const { name, category, description, city, zone, phone, price, price_unit, experience, tags, photo, work_photos, _trap } = req.body;

  // Honeypot — bots fill hidden field, humans don't
  if (_trap) return res.status(400).json({ error: 'spam detected' });

  if (!name || !category || !description || !city || !phone)
    return res.status(400).json({ error: 'missing required fields' });

  if (description.trim().length < 20)
    return res.status(400).json({ error: 'وصف قصير بزاف — زيد شوية تفاصيل' });

  const cleanPhone = phone.replace(/[\s\-]/g, '');
  if (!/^(0[5-7]\d{8}|\+212[5-7]\d{8})$/.test(cleanPhone))
    return res.status(400).json({ error: 'رقم التيليفون خاصو يكون مغربي' });

  // ── Duplicate guard: max 2 listings per phone+category ──────────────────
  try {
    await connectDB();
    if (db) {
      const phoneVariants = [cleanPhone, '0' + cleanPhone.replace(/^(\+212|212)/, '')];
      const existing = await db.collection('workers').countDocuments({
        phone: { $in: phoneVariants },
        category: category
      });
      if (existing >= 2) {
        return res.status(400).json({ error: 'عندك بالفعل مدخلين فهاد الخدمة — ما يمكنش تزيد' });
      }
    }
  } catch (dupErr) {
    console.error('duplicate check error:', dupErr);
    // non-fatal — proceed with registration if check fails
  }

  // ── AI classification check ─────────────────────────────────────────────
  // Run in parallel: ask Gemini to classify the worker independently. If it disagrees
  // with the user-picked category, we don't reject — we just flag for soft-warning + admin review.
  const aiClass = await classifyWorkerAI({ name, description, tags });
  let ai_suggested_category = null;
  let needs_review = false;
  let secondary_categories = [];
  if (aiClass) {
    if (aiClass.primary !== category) {
      ai_suggested_category = aiClass.primary;
      needs_review = true;
    }
    secondary_categories = aiClass.secondary;
  }

  // Compute market price range for this specific worker
  const _priceRange = computePriceRange({
    category, city, name, description, tags,
    experience: parseInt(experience) || 0,
  });

  // ── Price fairness gate ─────────────────────────────────────────────────
  // If the worker submitted an explicit price and it's wildly off vs the
  // computed baseline, return a Darija warning. Worker can re-submit with
  // ?confirm=1 to bypass after acknowledging.
  const submittedPrice = parseInt((price || '').replace(/[^\d]/g, ''), 10);
  if (Number.isFinite(submittedPrice) && submittedPrice > 0 && req.query.confirm !== '1') {
    const fairness = await evaluatePriceFairness({
      callXAI, db,
      worker: { _id: 'pending', category, city, zone, name, description, tags, experience: parseInt(experience) || 0 },
      quotedPrice: submittedPrice,
    });
    if (fairness.verdict === 'wildly_off') {
      return res.status(422).json({
        error: fairness.message_darija,
        verdict: fairness.verdict,
        baseline: fairness.baseline,
        retry_with: '/api/workers?confirm=1',
      });
    }
  }

  const worker = {
    name: name.trim().substring(0, 60),
    category, description: description.trim().substring(0, 500),
    city, zone: (zone || '').trim(),
    phone: cleanPhone,
    price: (price || '').replace(/[^\d]/g, '') || (_priceRange ? String(_priceRange.min) : ''),
    price_unit: (_priceRange ? _priceRange.unit : null) || price_unit || 'المرة',
    price_min: _priceRange ? _priceRange.min : null,
    price_max: _priceRange ? _priceRange.max : null,
    experience: parseInt(experience) || 0,
    tags: (tags || []).slice(0, 6),
    available: true, verified: false, featured: false,
    approved: true,
    rating: 0, rating_count: 0, jobs_done: 0, reviews: [],
    created_at: new Date().toISOString(),
    photo: (photo && photo.startsWith('data:image/') && photo.length < 700000) ? photo : null,
    work_photos: Array.isArray(work_photos)
      ? work_photos.filter(p => typeof p === 'string' && p.startsWith('data:image/') && p.length < 700000).slice(0, 4)
      : [],
  };
  if (secondary_categories.length) worker.secondary_categories = secondary_categories;
  if (needs_review) {
    worker.ai_suggested_category = ai_suggested_category;
    worker.needs_review = true;
  }

  try {
    const saved = await addWorker(worker);
    const newId = saved._id || saved.id;
    // Ping Bing IndexNow — worker profile + category/city pages
    const svcSlug = Object.entries(SEO_SERVICES).find(([,v])=>v.cat===worker.category)?.[0];
    const citySlug = Object.entries(SEO_CITIES).find(([,v])=>v.ar===worker.city)?.[0];
    const pingUrls = [`https://jak.ma/w/${newId}`];
    if (svcSlug) pingUrls.push(`https://jak.ma/${svcSlug}`);
    if (svcSlug && citySlug) pingUrls.push(`https://jak.ma/${svcSlug}/${citySlug}`);
    pingIndexNow(pingUrls);
    res.status(201).json({
      success: true,
      id: newId,
      message: 'وصلنا طلبك — غادي نشوفوه ونرجعو ليك',
      ai_suggested_category, // null if AI agrees, else the suggested category
      secondary_categories
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/stats', async (req, res) => {
  const count = await countWorkers();
  res.json({ workers: count });
});

// ─── OTP: Send code via SMS ───────────────────────────────────────────────
app.post('/api/otp/send', otpLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const clean = phone.replace(/[\s\-]/g, '');
  if (!/^(0[5-7]\d{8}|\+212[5-7]\d{8})$/.test(clean))
    return res.status(400).json({ error: 'رقم التيليفون خاصو يكون مغربي' });
  try {
    await connectDB();
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const variants = [clean, '0' + clean.replace(/^(\+212|212)/, '')];
    const worker = await db.collection('workers').findOne({ phone: { $in: variants } });
    if (!worker) return res.status(404).json({ error: 'ما لقيناش أي إعلان بهاد الرقم' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await db.collection('otps').deleteMany({ phone: { $in: variants } });
    await db.collection('otps').insertOne({ phone: clean, code, workerId: worker._id, expires });
    // Ensure TTL index exists (no-op if already there)
    db.collection('otps').createIndex({ expires: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
    await sendSmsOtp(clean, code);
    res.json({ success: true });
  } catch (err) { console.error('otp/send error:', err); res.status(500).json({ error: 'server error' }); }
});

// ─── OTP: Verify code → return signed edit token ─────────────────────────
app.post('/api/otp/verify', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  const clean = phone.replace(/[\s\-]/g, '');
  try {
    await connectDB();
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const variants = [clean, '0' + clean.replace(/^(\+212|212)/, '')];
    const entry = await db.collection('otps').findOne({ phone: { $in: variants } });
    if (!entry) return res.status(400).json({ error: 'ما كاينش رمز — اطلب رمزاً جديداً' });
    if (new Date() > new Date(entry.expires)) {
      await db.collection('otps').deleteOne({ _id: entry._id });
      return res.status(400).json({ error: 'الرمز منتهي الصلاحية — اطلب رمزاً جديداً' });
    }
    if (entry.code !== String(code).trim())
      return res.status(400).json({ error: 'الرمز غلط — حاول مرة أخرى' });
    await db.collection('otps').deleteOne({ _id: entry._id }); // single-use
    const worker = await db.collection('workers').findOne({ _id: entry.workerId });
    const editToken = signEditToken(String(entry.workerId), clean);
    res.json({ success: true, editToken, worker: sanitizeWorker(worker) });
  } catch (err) { console.error('otp/verify error:', err); res.status(500).json({ error: 'server error' }); }
});

// Add a review to a worker
app.post('/api/workers/:id/review', reviewLimiter, async (req, res) => {
  const { reviewer_name, stars, text } = req.body;
  if (!reviewer_name || !stars || !text) return res.status(400).json({ error: 'missing fields' });
  if (text.trim().length < 5) return res.status(400).json({ error: 'التعليق قصير بزاف' });
  const starNum = Math.min(5, Math.max(1, parseInt(stars)));
  const review = {
    // Store HTML-escaped so any renderer (client or server) is safe by default
    reviewer_name: escHtml(reviewer_name.trim().substring(0, 40)),
    stars: starNum,
    text: escHtml(text.trim().substring(0, 300)),
    createdAt: new Date()
  };
  try {
    await connectDB();
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const worker = await getWorkerById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'not found' });
    const reviews = [...(worker.reviews || []), review];
    const avg = Math.round((reviews.reduce((s, r) => s + r.stars, 0) / reviews.length) * 10) / 10;
    let query = {};
    try { query._id = new ObjectId(req.params.id); } catch { query.id = parseInt(req.params.id); }
    await db.collection('workers').updateOne(query, {
      $push: { reviews: review },
      $set: { rating: avg, rating_count: reviews.length }
    });
    res.json({ success: true, review, rating: avg, rating_count: reviews.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update worker profile — secured by OTP-issued signed token
app.put('/api/workers/:id', async (req, res) => {
  const { editToken, description, price, price_unit, zone, experience, tags, available, photo, work_photos } = req.body;
  if (!editToken) return res.status(401).json({ error: 'editToken required — verify your phone first' });
  const session = verifyEditToken(editToken);
  if (!session) return res.status(401).json({ error: 'رمز التعديل منتهي الصلاحية — اطلب رمز SMS جديد' });
  if (session.workerId !== req.params.id) return res.status(403).json({ error: 'غير مسموح' });
  try {
    await connectDB();
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const worker = await getWorkerById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'not found' });
    const upd = { updatedAt: new Date() };
    if (description && description.trim().length >= 10) upd.description = description.trim().substring(0, 500);
    if (price !== undefined) upd.price = String(price).replace(/[^\d]/g, '');
    if (price_unit) upd.price_unit = price_unit;
    if (zone !== undefined) upd.zone = String(zone).trim().substring(0, 60);
    if (experience !== undefined) upd.experience = parseInt(experience) || 0;
    if (tags && Array.isArray(tags)) upd.tags = tags.slice(0, 6);
    if (available !== undefined) upd.available = Boolean(available);
    if (photo && photo.startsWith('data:image/')) {
      if (photo.length > 700000) return res.status(400).json({ error: 'الصورة كبيرة بزاف' });
      upd.photo = photo;
    }
    if (Array.isArray(work_photos)) {
      const valid = work_photos.filter(p => typeof p === 'string' && p.startsWith('data:image/') && p.length < 700000);
      upd.work_photos = valid.slice(0, 4);
    }
    let query = {};
    try { query._id = new ObjectId(req.params.id); } catch { query.id = parseInt(req.params.id); }
    await db.collection('workers').updateOne(query, { $set: upd });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN API ROUTES (password protected)
// ═══════════════════════════════════════════════════════════════════════════

// List ALL workers including pending
app.get('/api/admin/workers', requireAdmin, async (req, res) => {
  try {
    if (db) {
      const all = await db.collection('workers').find({}).sort({ created_at: -1 }).toArray();
      return res.json(all);
    }
    res.json(loadWorkersJSON());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve a worker
app.post('/api/admin/workers/:id/approve', requireAdmin, async (req, res) => {
  try {
    await approveWorker(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a worker
app.delete('/api/admin/workers/:id', requireAdmin, async (req, res) => {
  try {
    await deleteWorker(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: re-classify a single worker via AI (or list workers needing review)
app.post('/api/admin/reclassify/:id', requireAdmin, async (req, res) => {
  try {
    const w = await getWorkerById(req.params.id);
    if (!w) return res.status(404).json({ error: 'not found' });
    const result = await classifyWorkerAI({ name: w.name, description: w.description, tags: w.tags });
    if (!result) return res.status(503).json({ error: 'AI classification failed' });
    const update = { category: result.primary };
    if (result.secondary.length) update.secondary_categories = result.secondary;
    if (req.body && req.body.apply) {
      if (db) {
        await db.collection('workers').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update, $unset: { needs_review: '', ai_suggested_category: '' } });
      }
      return res.json({ applied: true, ...result });
    }
    return res.json({ applied: false, current: { category: w.category, secondary_categories: w.secondary_categories || [] }, suggested: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/needs-review', requireAdmin, async (req, res) => {
  try {
    if (db) {
      const list = await db.collection('workers').find({ needs_review: true }).limit(100).toArray();
      return res.json(list);
    }
    return res.json(loadWorkersJSON().filter(w => w.needs_review).slice(0, 100));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── LEADERBOARD ─────────────────────────────────────────────────────────
// Public live benchmark for Moroccan-Darija AI. Anyone can submit a model.
// See public/leaderboard.html + lib/leaderboard.js + scripts/leaderboard_score.js
const { registerSubmission, getLeaderboard, getHistory } = require('./lib/leaderboard');

app.post('/api/leaderboard/submit', aiLimiter, async (req, res) => {
  try {
    await connectDB();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const result = await registerSubmission(db, req.body || {}, ip);
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (err) {
    console.error('[lb/submit]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/leaderboard/scores', async (req, res) => {
  try {
    await connectDB();
    const data = await getLeaderboard(db);
    res.setHeader('Cache-Control', 'public, max-age=60');  // edge-cache 1min
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard/history', async (req, res) => {
  try {
    await connectDB();
    const data = await getHistory(db);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/leaderboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});
app.get('/darija', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'darija.html'));
});


// ─── /api/health — liveness + dependency readiness ──────────────────────
// Used by deployment smoke tests + by uptime monitors. Reports:
//   - DB connectivity
//   - xAI key presence (does NOT call xAI; just checks env var)
//   - Feature flags
//   - Worker count
// Returns 200 if app is up, 503 if DB unreachable.
app.get('/api/health', async (req, res) => {
  const status = {
    ok: true,
    version: require('./package.json').version || 'unknown',
    grounded_retrieval: USE_GROUNDED,
    claude_configured: !!ANTHROPIC_API_KEY,
    gemini_configured: !!GEMINI_API_KEY,
    hf_darija_fallback: _isHFConfigured() ? HF_SPACE_URL : false,
    llm_routing: GEMINI_API_KEY && ANTHROPIC_API_KEY
      ? `multi-provider (gemini-3-flash default → claude-sonnet-4-5 hard → ${_isHFConfigured() ? 'HF Darija LoRA' : 'no'} fallback)`
      : (GEMINI_API_KEY ? 'gemini-only' : (ANTHROPIC_API_KEY ? 'claude-only' : 'no-provider')),
    twilio_configured: !!(TWILIO_SID && TWILIO_TOKEN),
    model_variant: MODEL_VARIANT,
    timestamp: new Date().toISOString(),
  };
  // SLM ping (fast — 2s timeout) so the health endpoint reflects the hybrid
  // path's actual availability, not just whether env vars are set.
  try { status.slm = await pingSLM(2000); } catch (e) { status.slm = { ok: false, error: e.message }; }
  try {
    const dbInstance = await connectDB();
    if (dbInstance) {
      status.db = 'ok';
      try { status.worker_count = await dbInstance.collection('workers').countDocuments({ approved: { $ne: false } }); } catch {}
    } else {
      status.db = 'unreachable';
      status.ok = false;
    }
  } catch (err) {
    status.db = 'error';
    status.db_error = err.message;
    status.ok = false;
  }
  res.status(status.ok ? 200 : 503).json(status);
});

// ─── /api/ai/public-stats — sanitized public aggregate stats for /eval ───
// No PII, no individual queries — just bucketed counters + percentiles. Safe
// to expose publicly (rate-limited via aiLimiter).
app.get('/api/ai/public-stats', aiLimiter, async (req, res) => {
  try {
    await connectDB();
    if (!db) return res.json({ available: false, reason: 'db_unreachable' });
    const limit = 500;
    const logs = await db.collection('eval_logs')
      .find({})
      .project({ timings: 1, verifier: 1, candidatesCount: 1, hasImage: 1, ts: 1, classification: 1 })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    if (!logs.length) {
      return res.json({
        available: true, total: 0,
        message: 'eval_logs empty — drive some traffic through the chat to populate it',
        worker_count: await db.collection('workers').countDocuments({ approved: { $ne: false } }).catch(() => 0),
      });
    }
    const totals = logs.map(l => l.timings?.total).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
    const verifierOk = logs.filter(l => l.verifier && l.verifier.ok).length;
    const imageRequests = logs.filter(l => l.hasImage).length;
    const tradesHist = {};
    for (const l of logs) {
      const t = l.classification?.trade || 'unclassified';
      tradesHist[t] = (tradesHist[t] || 0) + 1;
    }
    // Bucket by hour for the timeline
    const hourBuckets = {};
    for (const l of logs) {
      if (!l.ts) continue;
      const hourKey = new Date(l.ts).toISOString().slice(0, 13);
      hourBuckets[hourKey] = (hourBuckets[hourKey] || 0) + 1;
    }
    const worker_count = await db.collection('workers').countDocuments({ approved: { $ne: false } }).catch(() => 0);
    res.json({
      available: true,
      total: logs.length,
      worker_count,
      latency_ms: { p50: pct(totals, 0.5), p95: pct(totals, 0.95), p99: pct(totals, 0.99) },
      verifier: { ok: verifierOk, pass_rate: logs.length ? +(verifierOk / logs.length).toFixed(3) : null },
      image_requests: imageRequests,
      trades_histogram: tradesHist,
      timeline_hourly: hourBuckets,
      since: logs[logs.length - 1]?.ts,
      until: logs[0]?.ts,
    });
  } catch (err) {
    res.status(500).json({ available: false, error: err.message });
  }
});

// ─── /eval — public live production dashboard ───────────────────────────
// Public route (no auth) that renders a single-page dashboard pulling from
// /api/ai/public-stats. Designed to be shareable in portfolios + sent to
// recruiters as "click here, watch jak.ma's AI work in real time".
app.get('/eval', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'eval.html'));
});

// ─── /api/ai/eval-stats — production latency + verifier summary ──────────
// Reports p50/p95 latency and verifier pass rate from the last N entries in
// eval_logs. Admin-protected (don't expose internal metrics publicly).
app.get('/api/ai/eval-stats', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const logs = await db.collection('eval_logs')
      .find({})
      .project({ timings: 1, verifier: 1, candidatesCount: 1, hasImage: 1, ts: 1, classification: 1 })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    if (!logs.length) return res.json({ total: 0, message: 'no eval_logs yet — drive some traffic through /api/ai/chat first' });

    const totals = logs.map(l => l.timings?.total).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
    const verifierOk = logs.filter(l => l.verifier && l.verifier.ok).length;
    const imageRequests = logs.filter(l => l.hasImage).length;
    const tradesHistogram = {};
    for (const l of logs) {
      const t = l.classification?.trade || 'none';
      tradesHistogram[t] = (tradesHistogram[t] || 0) + 1;
    }
    res.json({
      total: logs.length,
      latency_ms: { p50: pct(totals, 0.5), p95: pct(totals, 0.95), p99: pct(totals, 0.99), max: totals.length ? totals[totals.length - 1] : null },
      verifier: { ok: verifierOk, pass_rate: logs.length ? (verifierOk / logs.length) : null },
      image_requests: imageRequests,
      trades_histogram: tradesHistogram,
      since: logs[logs.length - 1]?.ts,
      until: logs[0]?.ts,
    });
  } catch (err) {
    console.error('[eval-stats]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Price-fairness sweep ────────────────────────────────────────
// Hard-rule pass over all approved workers. Flags any worker whose price_min
// or price_max is wildly outside the computed baseline. Pass `?withLLM=1` to
// also run mid-range AI evaluation (much slower, costs ~$0.20 for 2k workers).
// Persists summary to admin_audits collection.
app.post('/api/admin/audit-prices', requireAdmin, async (req, res) => {
  try {
    await connectDB();
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const includeLLM = req.query.withLLM === '1';
    const limit = parseInt(req.query.limit, 10) || 5000;

    const workers = await db.collection('workers')
      .find({ approved: { $ne: false } })
      .project({ _id: 1, name: 1, category: 1, city: 1, zone: 1, description: 1, tags: 1, experience: 1, price_min: 1, price_max: 1, price_unit: 1 })
      .limit(limit)
      .toArray();

    const startedAt = Date.now();
    const result = await batchEvaluate({ callXAI, db, workers, includeLLM });
    const elapsed_ms = Date.now() - startedAt;

    // Persist summary
    try {
      await db.collection('admin_audits').insertOne({
        ts: new Date(), kind: 'price_fairness',
        scanned: workers.length, includeLLM, elapsed_ms,
        counts: result.counts,
        sample_count: { wildly_off: result.samples.wildly_off.length, above_fair: result.samples.above_fair.length, below_fair: result.samples.below_fair.length },
      });
    } catch (e) { /* non-fatal */ }

    res.json({ scanned: workers.length, includeLLM, elapsed_ms, ...result });
  } catch (err) {
    console.error('[audit-prices]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/ai/vision — dedicated multimodal classification endpoint ──────
// ─── /api/ai/classify — debug introspection endpoint ──────────────────────────
// GET or POST any text and see exactly how jak.ma's classifier resolves it:
//   - Pass 0 (regex):  which keyword matched in KEYWORD_TO_CAT / KEYWORD_TO_CITY
//   - Pass 0.5 (multi-trade): which pattern matched, which trades fan out
//   - Pass 1 (LLM):    not run here — debug endpoint only inspects the regex
//     pre-filter so it's instant (zero LLM cost).
// Designed for interview demos + debugging customer-facing chat failures.
// Rate-limited like the other AI endpoints.
//
// Usage:
//   GET  /api/ai/classify?q=bghit+plombier+f+tanja
//   POST /api/ai/classify   { "query": "..." }
{
  const {
    KEYWORD_TO_CAT: _KW_CAT,
    KEYWORD_TO_CITY: _KW_CITY,
    detectFromTextDebug,
    detectMultiTradeDebug,
  } = require('./lib/text-classifier');
  const _classifyDebugHandler = (req, res) => {
    const query = (req.method === 'GET' ? req.query.q : req.body?.query) || '';
    const q = String(query).slice(0, 400);
    if (!q) return res.status(400).json({ error: 'missing_query', detail: 'Pass `q` (GET) or `query` (POST).' });

    const t0 = Date.now();
    const tradeMatch = detectFromTextDebug(q, _KW_CAT);
    const cityMatch  = detectFromTextDebug(q, _KW_CITY);
    const multiMatch = detectMultiTradeDebug(q);
    const elapsed_ms = Date.now() - t0;

    res.json({
      query: q,
      elapsed_ms,
      resolution: tradeMatch.value || cityMatch.value || multiMatch.cats
        ? 'regex (Pass 0)'
        : 'would_fall_through_to_llm_pass_1',
      trade: {
        value: tradeMatch.value,
        matched_keyword: tradeMatch.keyword,
        pattern_group: tradeMatch.pattern_group,
      },
      city: {
        value: cityMatch.value,
        matched_keyword: cityMatch.keyword,
        pattern_group: cityMatch.pattern_group,
      },
      multi_trade: {
        cats: multiMatch.cats,
        matched_phrase: multiMatch.matched_phrase,
        pattern: multiMatch.pattern,
      },
      pipeline_note: tradeMatch.value || cityMatch.value || multiMatch.cats
        ? 'Pass 0 regex hit — no LLM call needed. This query resolves instantly.'
        : 'Pass 0 regex missed. /api/ai/chat would route this to the Pass 1 LLM classifier (~900ms typical).',
    });
  };
  app.get('/api/ai/classify', aiLimiter, _classifyDebugHandler);
  app.post('/api/ai/classify', aiLimiter, _classifyDebugHandler);
}

// Used as the fallback path when the browser-side local classifier (TF.js
// MobileNet head, public/js/local-classifier.js) returns confidence < 0.7.
// Returns the predicted trade + confidence. NO worker retrieval here — the
// caller passes the result back into /api/ai/chat for the full conversation.
app.post('/api/ai/vision', aiLimiter, async (req, res) => {
  if (!LLM_CONFIGURED) return res.status(503).json({ error: 'AI غير مفعّل' });
  const { image } = req.body || {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'بعت ليا الصورة باش نشوف المشكل' });
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    // Single-label vision classification — force the cheap Gemini Flash path.
    // Sonnet would be overkill for a one-word answer.
    const imgResp = await callLLM(
      [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: 'قول ليا فقط: ما هي الفئة المناسبة من هذه القائمة: طريسيان، بلومبي، صباغة، نجارة، بناء، نقاوة، حدادة، ديكور، نقل، كلامبيستري، خياطة، حراسة — جاوب بكلمة واحدة فقط' },
      ]}],
      { model: GEMINI_MODEL_VISION, temperature: 0, maxTokens: 20, signal: ctrl.signal }
    );
    clearTimeout(timer);
    const imgData = await imgResp.json();
    const raw = (imgData.choices?.[0]?.message?.content || '').trim().replace(/[.،\s]/g, '');
    const VC = ['طريسيان','بلومبي','صباغة','نجارة','بناء','نقاوة','حدادة','ديكور','نقل','كلامبيستري','خياطة','حراسة'];
    if (VC.includes(raw)) {
      return res.json({ trade: raw, confidence: 0.8, source: GEMINI_MODEL_VISION });
    }
    return res.json({ trade: null, confidence: 0, source: GEMINI_MODEL_VISION, error: 'ما عرفتش نقرا الصورة' });
  } catch (err) {
    return res.status(500).json({ error: 'مشكل تقني فالتحليل' });
  }
});

// Admin stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    if (db) {
      const total = await db.collection('workers').countDocuments({});
      const pending = await db.collection('workers').countDocuments({ approved: false });
      const approved = await db.collection('workers').countDocuments({ approved: { $ne: false } });
      return res.json({ total, pending, approved });
    }
    const all = loadWorkersJSON();
    res.json({ total: all.length, pending: all.filter(w => w.approved === false).length, approved: all.filter(w => w.approved !== false).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SEO LANDING PAGES ────────────────────────────────────────────────────────

const SEO_SERVICES = {
  'electricien': { cat:'طريسيان', icon:'⚡', ar:'تريسيان', fr:'Électricien', frP:'Électriciens', darija:'تريسيان', maalem:'معلم الكهرباء', desc_ar:'تريسيان محترفين للتركيب والصيانة وإصلاح الأعطال', desc_fr:'Électriciens professionnels pour installation, dépannage et réparation', urgency:'كهربائي ٢٤ ساعة — تريسيان مستعجل' },
  'plombier':    { cat:'بلومبي',  icon:'🚰', ar:'بلومبي',  fr:'Plombier',    frP:'Plombiers',    darija:'بلومبي',  maalem:'معلم السباكة',   desc_ar:'بلومبية محترفين لإصلاح التسربات والصيانة والتركيب',      desc_fr:'Plombiers pour fuites, réparations et installation salle de bain', urgency:'بلومبي ٢٤ ساعة — إصلاح تسرب الماء بالاستعجال' },
  'peintre':     { cat:'صباغة',  icon:'🎨', ar:'صباغ',    fr:'Peintre',      frP:'Peintres',      darija:'صباغ',    maalem:'معلم الصباغة',   desc_ar:'صباغة داخلية وخارجية للمنازل والشقق بسعر مناسب',          desc_fr:'Peintres intérieur et extérieur, rénovation appartement',           urgency:'صباغ رخيص قريب منك — صباغة بيت بسعر مناسب' },
  'menuisier':   { cat:'نجارة',  icon:'🪵', ar:'نجار',    fr:'Menuisier',    frP:'Menuisiers',    darija:'نجار',    maalem:'معلم النجارة',   desc_ar:'نجارة خشب وألمنيوم، تركيب أبواب وخزائن ومطابخ',           desc_fr:'Menuiserie bois et aluminium, portes, placards, fenêtres',          urgency:'نجار متاح قريب منك — تركيب وإصلاح فوري' },
  'macon':       { cat:'بناء',   icon:'🧱', ar:'ماصو',    fr:'Maçon',        frP:'Maçons',        darija:'ماصو',    maalem:'معلم البناء',    desc_ar:'بناء وترميم وإصلاح المنازل والشقق بسعر مناسب',             desc_fr:'Maçonnerie, rénovation, réparation maison et appartement',           urgency:'ترميم شقة أو ملحق — ماصو بسعر مناسب' },
  'nettoyage':   { cat:'نقاوة', icon:'🧹', ar:'نقاوة',   fr:'Nettoyage',    frP:'Services nettoyage', darija:'نقاوة', maalem:'خدمة تنظيف', desc_ar:'تنظيف منازل وشقق بسعر مناسب — نقاوة شاملة يومية أو أسبوعية', desc_fr:'Nettoyage maison et appartement, ménage à domicile',               urgency:'نقاوة شاملة — تنظيف بيت يومي أو أسبوعي' },
  'soudeur':     { cat:'حدادة',  icon:'🔩', ar:'حداد',    fr:'Soudeur',      frP:'Soudeurs',      darija:'سودور',   maalem:'معلم الحدادة',   desc_ar:'حدادة وسودور — أبواب وشبابيك وحواجز حديدية',              desc_fr:'Soudure, ferronnerie, portes et grilles métalliques',                urgency:'تركيب باب حديد أو شباك — حداد محترف' },
  'decorateur':  { cat:'ديكور',  icon:'🛋️', ar:'ديكور',  fr:'Décorateur',   frP:'Décorateurs',   darija:'ديكور',   maalem:'مصمم ديكور',     desc_ar:'تصميم وتنفيذ ديكور داخلي للمنازل والشقق بأسعار مناسبة',    desc_fr:'Décoration intérieure, aménagement appartement sur mesure',          urgency:'ديكور عصري بسعر مناسب — مصمم داخلي محترف' },
  'demenageur':  { cat:'نقل',    icon:'🚚', ar:'نقل عفش', fr:'Déménageur',  frP:'Déménageurs',   darija:'نقل',     maalem:'خدمة نقل',       desc_ar:'نقل عفش وأثاث بشاحنة — خدمة موثوقة بسعر مناسب',           desc_fr:'Déménagement, transport meubles, camion déménagement',               urgency:'نقل عفش سريع وآمن — شاحنة نقل متوفرة' },
  'carreleur':   { cat:'كلامبيستري', icon:'🛁', ar:'كارولور', fr:'Carreleur', frP:'Carreleurs',  darija:'كارولور', maalem:'معلم الزليج',    desc_ar:'تبليط حمامات وزليج — كارولور بسعر مناسب',                  desc_fr:'Carrelage, zellige, salle de bain, pose carrelage Maroc',            urgency:'تبليط حمام كامل بسعر مناسب — معلم الزليج' },
  'couturier':   { cat:'خياطة',  icon:'🧵', ar:'خياط',    fr:'Couturier',    frP:'Couturiers',    darija:'خياط',    maalem:'معلم الخياطة',   desc_ar:'تفصيل وترقيع ملابس — خياط محترف قريب منك',                 desc_fr:'Couture, retouche vêtements, tailleur sur mesure',                   urgency:'تفصيل وترقيع ملابس — خياط متاح قريب منك' },
  'securite':    { cat:'حراسة',  icon:'🛡️', ar:'حارس أمن', fr:'Agent de sécurité', frP:'Agents de sécurité', darija:'حراسة', maalem:'حارس الأمن', desc_ar:'حراسة وأمن للمنازل والعمارات والمحلات', desc_fr:'Gardiennage, sécurité résidence et commerce', urgency:'حارس أمن موثوق للعمارة أو المحل' },
};

const SEO_CITIES = {
  'casablanca': { ar:'الدار البيضاء', darija:'كازا',       fr:'Casablanca'  },
  'rabat':      { ar:'الرباط',        darija:'الرباط',     fr:'Rabat'       },
  'marrakech':  { ar:'مراكش',         darija:'مراكش',      fr:'Marrakech'   },
  'fes':        { ar:'فاس',           darija:'فاس',        fr:'Fès'         },
  'tanger':     { ar:'طنجة',          darija:'طنجة',       fr:'Tanger'      },
  'agadir':     { ar:'أكادير',        darija:'أكادير',     fr:'Agadir'      },
  'sale':       { ar:'سلا',           darija:'سلا',        fr:'Salé'        },
  'meknes':     { ar:'مكناس',         darija:'مكناس',      fr:'Meknès'      },
  'oujda':      { ar:'وجدة',          darija:'وجدة',       fr:'Oujda'       },
  'kenitra':    { ar:'القنيطرة',      darija:'القنيطرة',   fr:'Kénitra'     },
  'tetouan':    { ar:'تطوان',         darija:'تطوان',      fr:'Tétouan'     },
  'mohammedia': { ar:'المحمدية',      darija:'المحمدية',   fr:'Mohammedia'  },
  'eljadida':   { ar:'الجديدة',       darija:'الجديدة',    fr:'El Jadida'   },
  'benimellal': { ar:'بني ملال',      darija:'بني ملال',   fr:'Beni Mellal' },
};

const SEO_CSS = `<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--red:#c0392b;--gold-l:#f6c90e;--bg:#f2f0eb;--card:#fff;--text:#1e1e1e;--muted:#6b6b6b;--border:#dedad2;--green:#1a7a4a}
  body{font-family:'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--text);direction:rtl}
  a{color:inherit;text-decoration:none}
  .topbar{background:var(--red);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.2)}
  .logo{font-size:20px;font-weight:900;color:#fff}.logo span{color:var(--gold-l)}
  .btn-reg{background:var(--gold-l);color:#000;border-radius:20px;padding:7px 14px;font-size:12px;font-weight:800}
  .hero{background:linear-gradient(160deg,#1e1e1e,#3d0b07 60%,#6b1a12);color:#fff;padding:28px 16px 24px;text-align:center}
  .hero h1{font-size:26px;font-weight:900;margin-bottom:6px}
  .hero-sub{color:var(--gold-l);font-size:14px;margin-bottom:8px}
  .hero-count{font-size:13px;color:rgba(255,255,255,.75)}
  .hero-fr{font-size:12px;color:rgba(255,255,255,.45);margin-top:5px}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:10px 14px;scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chip{background:var(--card);border:1.5px solid var(--border);border-radius:20px;padding:5px 13px;font-size:12px;font-weight:700;white-space:nowrap}
  .chip.on{background:var(--red);color:#fff;border-color:var(--red)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:0 14px 14px;max-width:1100px;margin:0 auto}
  .wc{background:var(--card);border-radius:14px;padding:15px;border:1.5px solid var(--border);box-shadow:0 2px 10px rgba(0,0,0,.06)}
  .wc-top{display:flex;align-items:center;gap:10px;margin-bottom:9px}
  .wc-av{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--red),#9b2226);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
  .wc-name{font-size:15px;font-weight:800}.wc-cat{font-size:11px;color:var(--muted);margin-top:2px}
  .wc-desc{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:9px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .wc-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}
  .badge{background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:3px 7px;font-size:11px;color:var(--muted)}
  .wc-btns{display:grid;grid-template-columns:1fr 1fr;gap:7px}
  .btn-c{background:var(--green);color:#fff;border-radius:9px;padding:9px;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px}
  .btn-w{background:#25d366;color:#fff;border-radius:9px;padding:9px;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px}
  .prose{max-width:780px;margin:20px auto;padding:0 16px}
  .prose h2{font-size:17px;font-weight:800;margin-bottom:10px}
  .prose p{font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:8px}
  .faq{max-width:780px;margin:0 auto;padding:0 16px 28px}
  .faq h2{font-size:17px;font-weight:800;margin-bottom:12px}
  .fi{background:var(--card);border-radius:11px;padding:13px 15px;margin-bottom:9px;border:1px solid var(--border)}
  .fq{font-size:13px;font-weight:700;margin-bottom:5px}.fa{font-size:12px;color:var(--muted);line-height:1.6}
  .city-links{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px;max-width:780px;margin:0 auto 20px}
  .cl{background:var(--card);border:1.5px solid var(--border);border-radius:9px;padding:7px 12px;font-size:12px;font-weight:700}
  .cl:hover{border-color:var(--red);color:var(--red)}
  footer{text-align:center;padding:18px;font-size:11px;color:var(--muted);border-top:1px solid var(--border)}
  footer a{color:var(--red);font-weight:700;margin:0 4px}
</style>`;

function seoWorkerCard(w) {
  const waPhone = (w.phone||'').replace(/^0/, '212');
  const waMsg = encodeURIComponent(`السلام عليكم ${w.name}، شفت إعلانك فجاك.ما. واش متاح؟`);
  const icon = CAT_ICONS[w.category] || '🛠️';
  const eName = escHtml(w.name || '');
  const eCat  = escHtml(w.category || '');
  const eCity = escHtml(w.city || '');
  const eDesc = escHtml((w.description || '').substring(0, 150));
  return `<div class="wc">
    <div class="wc-top"><div class="wc-av">${icon}</div><div><div class="wc-name">${eName}</div><div class="wc-cat">${eCat}${w.city?' — '+eCity:''}</div></div></div>
    ${w.description?`<div class="wc-desc">${eDesc}</div>`:''}
    <div class="wc-meta">
      ${w.city?`<span class="badge">📍 ${eCity}</span>`:''}
      ${w.experience?`<span class="badge">⏱ ${w.experience} سنة</span>`:''}
      ${w.price?`<span class="badge">💰 ${w.price} درهم</span>`:''}
    </div>
    <div class="wc-btns">
      <a class="btn-c" href="tel:${w.phone}">📞 اتصل</a>
      <a class="btn-w" href="https://wa.me/${waPhone}?text=${waMsg}" target="_blank">💬 واتساب</a>
    </div>
  </div>`;
}

function seoNav() {
  return `<nav class="topbar"><a class="logo" href="/">جاك<span>.ما</span></a><a class="btn-reg" href="/?register=1">+ سجل خدمتك</a></nav>`;
}

function seoFooter(extra='') {
  const svcLinks = Object.entries(SEO_SERVICES).map(([s,v])=>`<a href="/${s}">${v.ar}</a>`).join('');
  return `<footer>${extra}<br><br>${svcLinks}<br><br><a href="/">جاك.ما</a> — خدمات المنزل في المغرب بلا شناقة 🇲🇦</footer>`;
}

// ─── OG IMAGE (PNG) ─────────────────────────────────────────────────────────
// Generated once, cached in memory — no file write needed on Vercel
let _ogPngCache = null;
function buildOgPng() {
  if (_ogPngCache) return _ogPngCache;
  const W = 1200, H = 630;
  const png = new PNG({ width: W, height: H, filterType: -1 });

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Gradient: dark navy (#1a1a2e) → dark red (#6b1a12), diagonal
      const t = Math.min(1, (x / W) * 0.55 + (y / H) * 0.45);
      // Add a gold band across center (~y 265–295) — subtle stripe
      const centerY = Math.abs(y - H * 0.45) / (H * 0.025);
      const gold = Math.max(0, 1 - centerY);
      const r = Math.round((26 + t * (107 - 26)) * (1 - gold * 0.6) + 246 * gold * 0.6);
      const g = Math.round((26 + t * (26 - 26))  * (1 - gold * 0.6) + 201 * gold * 0.6);
      const b = Math.round((46 + t * (18 - 46))  * (1 - gold * 0.6) +  14 * gold * 0.6);
      png.data[i]   = Math.min(255, r);
      png.data[i+1] = Math.min(255, g);
      png.data[i+2] = Math.min(255, b);
      png.data[i+3] = 255;
    }
  }
  _ogPngCache = PNG.sync.write(png);
  return _ogPngCache;
}

app.get('/og.png', (req, res) => {
  try {
    const buf = buildOgPng();
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    }).send(buf);
  } catch (e) {
    res.status(500).end();
  }
});

// robots.txt
app.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin.html\n\nSitemap: ${base}/sitemap.xml`);
});

// sitemap.xml
app.get('/sitemap.xml', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  let workers = [];
  try { workers = await getWorkers({}); } catch {}
  const today = new Date().toISOString().split('T')[0];
  const u = (loc, freq, pri) => `<url><loc>${loc}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;
  const urls = [
    u(`${base}/`, 'daily', '1.0'),
    ...Object.keys(SEO_SERVICES).map(s => u(`${base}/${s}`, 'daily', '0.9')),
    ...Object.keys(SEO_SERVICES).flatMap(s => Object.keys(SEO_CITIES).map(c => u(`${base}/${s}/${c}`, 'daily', '0.8'))),
    ...workers.map(w => u(`${base}/w/${w._id||w.id}`, 'weekly', '0.6')),
  ];
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

// /:service — all-Morocco category page
app.get('/:service', async (req, res, next) => {
  const svc = SEO_SERVICES[req.params.service];
  if (!svc) return next();
  const base = `${req.protocol}://${req.get('host')}`;
  const workers = await getWorkers({ category: svc.cat });
  const n = workers.length;
  const title = `${svc.ar} في المغرب | ${svc.fr} Maroc — جاك.ما`;
  const desc = `${n} ${svc.ar} في المغرب — اتصل مباشرة بلا وسيط ولا عمولة. ${svc.urgency}. ${svc.desc_fr} au Maroc sur jak.ma`;
  const cityChips = Object.entries(SEO_CITIES).map(([sl,c])=>`<a class="chip" href="/${req.params.service}/${sl}">${svc.ar} ${c.darija}</a>`).join('');
  const otherSvc = Object.entries(SEO_SERVICES).filter(([sl])=>sl!==req.params.service).map(([sl,s])=>`<a class="cl" href="/${sl}">${s.ar}</a>`).join('');
  const faqLd = {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
    {"@type":"Question","name":`كيفاش نلقى ${svc.ar} موثوق في المغرب؟`,"acceptedAnswer":{"@type":"Answer","text":`على جاك.ما كل ${svc.ar} سجل بنفسه بياناته ورقم تيليفونه. اتصل مباشرة بلا وسيط ولا عمولة على jak.ma`}},
    {"@type":"Question","name":`Comment trouver un ${svc.fr.toLowerCase()} pas cher au Maroc?`,"acceptedAnswer":{"@type":"Answer","text":`Sur jak.ma, ${n} ${svc.frP.toLowerCase()} disponibles partout au Maroc. Appelez directement — gratuit, sans commission.`}},
    {"@type":"Question","name":`How to find a reliable ${svc.fr.toLowerCase()} in Morocco?`,"acceptedAnswer":{"@type":"Answer","text":`jak.ma lists ${n} verified ${svc.frP.toLowerCase()} across Morocco. Call them directly — no middleman, no fees.`}}
  ]};
  const orgLd = {"@context":"https://schema.org","@type":"Organization","name":"جاك.ما","url":base,"description":"منصة مغربية لإيجاد خدامة البيت بلا شناقة","areaServed":"Morocco","sameAs":["https://jak.ma"]};
  res.type('text/html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <meta name="description" content="${desc}"/>
  <meta name="keywords" content="${svc.ar} المغرب, ${svc.ar} كازا, ${svc.ar} الرباط, ${svc.darija} مراكش, ${svc.fr} Maroc, ${svc.fr} Casablanca, ${svc.fr} Rabat, ${svc.frP} Maroc, jak.ma"/>
  <link rel="canonical" href="${base}/${req.params.service}"/>
  <meta property="og:title" content="${title}"/><meta property="og:description" content="${desc}"/><meta property="og:image" content="${base}/og.png"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta property="og:image:type" content="image/png"/><meta property="og:locale" content="ar_MA"/>
  <script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"Service","name":`${svc.ar} المغرب`,"description":desc,"provider":{"@type":"Organization","name":"جاك.ما","url":base},"areaServed":{"@type":"Country","name":"Morocco"}})}</script>
  <script type="application/ld+json">${JSON.stringify(faqLd)}</script>
  <script type="application/ld+json">${JSON.stringify(orgLd)}</script>
  ${SEO_CSS}</head><body>
  ${seoNav()}
  <section class="hero">
    <div style="font-size:46px;margin-bottom:8px">${svc.icon}</div>
    <h1>${svc.ar} في المغرب</h1>
    <div class="hero-sub">${svc.darija} — ${svc.maalem} — ${svc.urgency}</div>
    <div class="hero-count">${n} ${svc.ar} مسجلين — اتصل مباشرة بلا شناقة 🇲🇦</div>
    <div class="hero-fr">${svc.fr} au Maroc — ${n} ${svc.frP} disponibles</div>
  </section>
  <div class="chips">${cityChips}</div>
  <div class="grid">${workers.slice(0,30).map(seoWorkerCard).join('')}</div>
  ${n>30?`<div style="text-align:center;padding:8px 0 16px"><a href="/?category=${encodeURIComponent(svc.cat)}" style="color:var(--red);font-weight:700;font-size:14px">شوف الكل (${n}) ←</a></div>`:''}
  <div class="prose">
    <h2>${svc.ar} في المغرب — ${svc.fr} Maroc</h2>
    <p>${svc.desc_ar}. ${svc.urgency}. كل ${svc.ar} سجل بنفسه بياناته ورقم تيليفونه على جاك.ما — اتصل مباشرة بلا وسيط ولا عمولة.</p>
    <p>${svc.desc_fr}. Chaque ${svc.fr.toLowerCase()} s'est inscrit directement — appelez sans commission.</p>
  </div>
  <div class="faq">
    <h2>أسئلة شائعة</h2>
    <div class="fi"><div class="fq">كيفاش نلقى ${svc.ar} موثوق في المغرب؟</div><div class="fa">على جاك.ما كل ${svc.ar} سجل بنفسه بياناته. اتصل بيه مباشرة وشوف تقييماته — ما كاينش وسيط ولا عمولة.</div></div>
    <div class="fi"><div class="fq">بشحال يخدم ${svc.ar} في المغرب؟</div><div class="fa">السعر كيختلف حسب المدينة والخدمة. على جاك.ما تقدر تشوف السعر اليومي لكل ${svc.ar} قبل ما تتصل.</div></div>
    <div class="fi"><div class="fq">Comment trouver un ${svc.fr.toLowerCase()} pas cher au Maroc?</div><div class="fa">Sur جاك.ما, ${n} ${svc.frP.toLowerCase()} sont disponibles partout au Maroc. Appelez directement — c'est gratuit, sans commission.</div></div>
  </div>
  <div style="padding:0 0 8px;max-width:780px;margin:0 auto">
    <div style="padding:0 16px 8px;font-size:12px;font-weight:700;color:var(--muted)">مدن أخرى</div>
    <div class="city-links">${Object.entries(SEO_CITIES).map(([sl,c])=>`<a class="cl" href="/${req.params.service}/${sl}">${svc.ar} ${c.darija}</a>`).join('')}</div>
    <div style="padding:0 16px 8px;font-size:12px;font-weight:700;color:var(--muted)">خدمات أخرى</div>
    <div class="city-links">${otherSvc}</div>
  </div>
  ${seoFooter(`${svc.ar} في المغرب — ${svc.fr} Maroc`)}
  </body></html>`);
});

// /:service/:city — city-specific landing page
app.get('/:service/:city', async (req, res, next) => {
  const svc = SEO_SERVICES[req.params.service];
  const city = SEO_CITIES[req.params.city];
  if (!svc || !city) return next();
  const base = `${req.protocol}://${req.get('host')}`;
  const all = await getWorkers({ category: svc.cat });
  const workers = all.filter(w => w.city === city.ar);
  const n = workers.length;
  const title = `${svc.ar} ${city.darija} | ${svc.fr} ${city.fr} — جاك.ما`;
  const desc = `${n} ${svc.ar} في ${city.ar} — اتصل مباشرة بلا وسيط. ${svc.urgency} ${city.darija}. ${svc.fr} à ${city.fr} sur jak.ma`;
  const cityChips = Object.entries(SEO_CITIES).map(([sl,c])=>`<a class="chip${sl===req.params.city?' on':''}" href="/${req.params.service}/${sl}">${c.ar}</a>`).join('');
  const jsonLd = {"@context":"https://schema.org","@type":"Service","name":`${svc.ar} ${city.ar}`,"description":desc,"provider":{"@type":"Organization","name":"جاك.ما","url":base},"areaServed":{"@type":"City","name":city.fr,"containedInPlace":{"@type":"Country","name":"Morocco"}}};
  const faqLdCity = {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
    {"@type":"Question","name":`كيفاش نلقى ${svc.ar} موثوق في ${city.ar}؟`,"acceptedAnswer":{"@type":"Answer","text":`على جاك.ما كل ${svc.ar} في ${city.ar} سجل بنفسه بياناته ورقم تيليفونه. اتصل مباشرة بلا وسيط على jak.ma`}},
    {"@type":"Question","name":`Comment trouver un ${svc.fr.toLowerCase()} à ${city.fr}?`,"acceptedAnswer":{"@type":"Answer","text":`Sur jak.ma, ${n} ${svc.frP.toLowerCase()} disponibles à ${city.fr}. Appelez directement — gratuit, sans commission.`}},
    {"@type":"Question","name":`${svc.fr} urgence ${city.fr} — comment?`,"acceptedAnswer":{"@type":"Answer","text":`Consultez la liste de ${svc.frP.toLowerCase()} à ${city.fr} sur jak.ma et appelez directement. Certains sont disponibles 24h/24.`}},
    {"@type":"Question","name":`How to find a ${svc.fr.toLowerCase()} in ${city.fr} Morocco?`,"acceptedAnswer":{"@type":"Answer","text":`jak.ma lists ${n} ${svc.frP.toLowerCase()} in ${city.fr}. Call them directly — no fees, no middleman.`}}
  ]};
  const cards = n > 0
    ? `<div class="grid">${workers.slice(0,30).map(seoWorkerCard).join('')}</div>${n>30?`<div style="text-align:center;padding:8px 0 16px"><a href="/?category=${encodeURIComponent(svc.cat)}&city=${encodeURIComponent(city.ar)}" style="color:var(--red);font-weight:700;font-size:14px">شوف الكل (${n}) ←</a></div>`:''}`
    : `<div style="text-align:center;padding:40px 16px;color:var(--muted)"><div style="font-size:36px;margin-bottom:10px">🔍</div><div style="font-weight:700;margin-bottom:8px">ما كاينش ${svc.ar} في ${city.ar} دابا</div><a href="/${req.params.service}" style="color:var(--red);font-weight:700">شوف ${svc.ar} في مدن أخرى ←</a></div>`;
  res.type('text/html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${title}</title>
  <meta name="description" content="${desc}"/>
  <link rel="canonical" href="${base}/${req.params.service}/${req.params.city}"/>
  <meta property="og:title" content="${title}"/><meta property="og:description" content="${desc}"/><meta property="og:image" content="${base}/og.png"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta property="og:image:type" content="image/png"/><meta property="og:locale" content="ar_MA"/>
  <meta name="keywords" content="${svc.ar} ${city.ar}, ${svc.ar} ${city.darija}, ${svc.darija} ${city.darija}, ${svc.fr} ${city.fr}, ${svc.frP} ${city.fr}, jak.ma ${city.fr}"/>
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <script type="application/ld+json">${JSON.stringify(faqLdCity)}</script>
  ${SEO_CSS}</head><body>
  ${seoNav()}
  <section class="hero">
    <div style="font-size:46px;margin-bottom:8px">${svc.icon}</div>
    <h1>${svc.ar} ${city.darija}</h1>
    <div class="hero-sub">${svc.darija} في ${city.ar} — ${svc.maalem} — ${svc.urgency}</div>
    <div class="hero-count">${n} ${svc.ar} متوفرين في ${city.ar} — اتصل مباشرة بلا شناقة 🇲🇦</div>
    <div class="hero-fr">${svc.fr} à ${city.fr} — ${n} disponibles sur jak.ma</div>
  </section>
  <div class="chips">${cityChips}</div>
  ${cards}
  <div class="prose">
    <h2>${svc.ar} في ${city.ar} — ${svc.fr} ${city.fr}</h2>
    <p>${svc.desc_ar} في ${city.ar}. ${svc.urgency}. كل ${svc.ar} سجل بنفسه بياناته ورقم تيليفونه — اتصل مباشرة بلا وسيط ولا عمولة.</p>
    <p>${svc.desc_fr} à ${city.fr}. Contactez directement sans intermédiaire ni commission sur جاك.ما.</p>
  </div>
  <div class="faq">
    <h2>أسئلة شائعة — ${svc.ar} ${city.darija}</h2>
    <div class="fi"><div class="fq">كيفاش نلقى ${svc.ar} موثوق في ${city.ar}؟</div><div class="fa">على جاك.ما كل ${svc.ar} سجل بنفسه بياناته ورقم تيليفونه في ${city.ar}. اتصل مباشرة وشوف التقييمات — ما كاينش وسيط ولا عمولة.</div></div>
    <div class="fi"><div class="fq">بشحال يخدم ${svc.ar} في ${city.darija}؟</div><div class="fa">السعر كيختلف حسب الخدمة والمنطقة. على جاك.ما تشوف السعر اليومي لكل ${svc.ar} في ${city.ar} قبل ما تتصل.</div></div>
    <div class="fi"><div class="fq">Comment trouver un ${svc.fr.toLowerCase()} pas cher à ${city.fr}?</div><div class="fa">Sur جاك.ما, ${n} ${svc.frP.toLowerCase()} sont disponibles à ${city.fr}. Appelez directement — gratuit, sans commission.</div></div>
    <div class="fi"><div class="fq">${svc.fr} urgence ${city.fr} — كيفاش؟</div><div class="fa">شوف قائمة ${svc.ar} في ${city.ar} على جاك.ما واتصل مباشرة بالرقم المعروض. بعضهم متاحين للاستعجال ٢٤ ساعة.</div></div>
  </div>
  <div style="padding:0 0 8px;max-width:780px;margin:0 auto">
    <div style="padding:0 16px 8px;font-size:12px;font-weight:700;color:var(--muted)">${svc.ar} في مدن أخرى</div>
    <div class="city-links">${Object.entries(SEO_CITIES).map(([sl,c])=>`<a class="cl" href="/${req.params.service}/${sl}">${svc.ar} ${c.darija}</a>`).join('')}</div>
  </div>
  ${seoFooter(`${svc.ar} ${city.ar} — ${svc.fr} ${city.fr}`)}
  </body></html>`);
});

// ─── WORKER SHARE PAGE ────────────────────────────────────────────────────────
const CAT_ICONS = {
  'طريسيان':'⚡','نقاوة':'🧹','بناء':'🧱','بلومبي':'🚰','صباغة':'🎨',
  'نجارة':'🪵','حدادة':'🔩','ديكور':'🛋️','نقل':'🚚','كلامبيستري':'🛁',
  'خياطة':'🧵','حراسة':'🛡️'
};

app.get('/w/:id', async (req, res) => {
  const worker = await getWorkerById(req.params.id);
  if (!worker) return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;margin-top:60px">❌ ما لقيناش هاد الخدام</h2>');

  const icon = CAT_ICONS[worker.category] || '🛠️';
  const stars = '★'.repeat(Math.floor(worker.rating || 0)) + '☆'.repeat(5 - Math.floor(worker.rating || 0));
  const waPhone = (worker.phone || '').replace(/^0/, '212');
  const waMsg = encodeURIComponent(`السلام عليكم ${worker.name}، شفت إعلانك فجاك.ما على ${worker.category}. واش متاح؟`);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const workerId = worker._id || worker.id;
  const shareMsg = encodeURIComponent(`${icon} ${worker.name} — ${worker.category} من ${worker.city}\n\n${(worker.description||'').substring(0,100)}...\n\nاتصل بيه مباشرة بلا شناقة 🇲🇦\n👉 ${baseUrl}/w/${workerId}`);
  // ── Safe (HTML-escaped) versions of all user-controlled fields ───────────────
  const eName    = escHtml(worker.name || '');
  const eCat     = escHtml(worker.category || '');
  const eCity    = escHtml(worker.city || '');
  const eZone    = escHtml(worker.zone || '');
  const eDesc    = escHtml(worker.description || '');
  const tags = (worker.tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
  const desc = escHtml((worker.description || '').substring(0, 120));
  const pageUrl = `${baseUrl}/w/${workerId}`;
  const pageTitle = `${eName} — ${icon} ${eCat} فجاك.ما`;
  const pageDesc = `${eCity}${worker.zone ? ' — ' + eZone : ''} | ${desc} | اتصل مباشرة بلا شناقة 🇲🇦`;

  const photoHtml = worker.photo
    ? `<img src="${worker.photo}" alt="${eName}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.25);flex-shrink:0"/>`
    : `<div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#c0392b,#6b1a12);display:flex;align-items:center;justify-content:center;font-size:34px;flex-shrink:0">${icon}</div>`;

  const reviews = (worker.reviews || []).slice(0, 2);
  const reviewsHtml = reviews.length ? reviews.map(rv => {
    const rvStars = '★'.repeat(rv.stars||0) + '☆'.repeat(5-(rv.stars||0));
    return `<div class="rv">
      <div class="rv-top">
        <span class="rv-name">${escHtml(rv.reviewer_name||rv.name||'مجهول')}</span>
        <span class="rv-stars">${rvStars}</span>
      </div>
      <div class="rv-text">"${escHtml(rv.text||'')}"</div>
    </div>`;
  }).join('') : '';

  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
  <title>${pageTitle}</title>
  <meta property="og:type" content="profile"/>
  <meta property="og:title" content="${pageTitle}"/>
  <meta property="og:description" content="${pageDesc}"/>
  <meta property="og:url" content="${pageUrl}"/>
  <meta property="og:image" content="${baseUrl}/og.png"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta property="og:image:type" content="image/png"/>
  <meta property="og:site_name" content="جاك.ما"/>
  <meta property="og:locale" content="ar_MA"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${pageTitle}"/>
  <meta name="twitter:description" content="${pageDesc}"/>
  <meta name="twitter:image" content="${baseUrl}/og.png"/>
  <script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"LocalBusiness","name":worker.name,"description":worker.description||pageDesc,"telephone":worker.phone,"address":{"@type":"PostalAddress","addressLocality":worker.city||'','addressCountry':'MA'},"priceRange":worker.price?worker.price+' MAD':'',"aggregateRating":worker.rating_count>0?{"@type":"AggregateRating","ratingValue":worker.rating,"reviewCount":worker.rating_count}:undefined,"url":pageUrl})}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Amiri&display=swap" rel="stylesheet"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--red:#c0392b;--gold:#f6c90e;--green:#1a7a4a;--wa:#25d366;--dark:#1a1a2e;--card:#fff;--text:#1e1e1e;--muted:#6b6b6b;--border:#e8e4dc;--bg:#f5f3ef}
    html,body{font-family:'Segoe UI',Arial,sans-serif;direction:rtl;color:var(--text);background:var(--dark)}

    .page{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 16px;gap:10px}

    /* logo bar */
    .logo-bar{width:100%;max-width:420px;display:flex;align-items:center;justify-content:space-between}
    .logo-bar-brand{font-size:22px;font-weight:900;color:#fff;text-decoration:none;letter-spacing:-.5px}
    .logo-bar-brand span{color:var(--gold)}
    .logo-bar-tagline{font-size:11px;color:rgba(255,255,255,.45)}

    /* card */
    .card{width:100%;max-width:420px;background:var(--card);border-radius:22px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45)}

    /* dark header */
    .ch{background:linear-gradient(160deg,#1e1e1e 0%,#3d0b07 55%,#6b1a12 100%);padding:20px 20px 18px;color:#fff}
    .ch-top{display:flex;align-items:center;gap:14px;margin-bottom:14px}
    .ch-info{flex:1;min-width:0}
    .ch-name{font-size:20px;font-weight:900;line-height:1.2;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ch-cat{color:var(--gold);font-size:13px;font-weight:700;margin-bottom:6px}
    .ch-avail{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:rgba(255,255,255,.75)}
    .adot{width:7px;height:7px;background:#2ecc71;border-radius:50%;flex-shrink:0}
    @media(prefers-reduced-motion:no-preference){.adot{animation:blink 1.5s infinite}@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}}
    .ch-meta{display:flex;gap:8px;flex-wrap:wrap}
    .ch-pill{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);border-radius:20px;padding:4px 10px;font-size:11px;color:rgba(255,255,255,.85)}

    /* white body */
    .cb{padding:16px 20px}
    .cb-stars{color:#e6a817;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:6px}
    .cb-stars-count{font-size:12px;color:var(--muted)}
    .cb-price{background:linear-gradient(90deg,#fff8e1,#fff3cd);border-radius:10px;padding:10px 14px;display:flex;align-items:baseline;gap:6px;margin-bottom:12px;border:1px solid #ffe082}
    .cb-price-amt{font-size:20px;font-weight:900;color:#7d5a00}
    .cb-price-u{font-size:11px;color:#a07800}
    .cb-desc{font-size:13px;line-height:1.7;color:var(--muted);margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .cb-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px}
    .cb-tag{background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:3px 9px;font-size:11px;color:var(--muted);font-weight:600}
    .cb-gallery{display:flex;gap:7px;margin-bottom:12px;overflow-x:auto;scrollbar-width:none}
    .cb-gallery::-webkit-scrollbar{display:none}
    .cb-gallery-img{width:88px;height:88px;object-fit:cover;border-radius:10px;flex-shrink:0;cursor:pointer;border:1.5px solid var(--border);transition:.15s}
    .cb-gallery-img:active{opacity:.8;transform:scale(.97)}
    .cb-gallery-title{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:7px}
    /* full-screen photo viewer */
    .photo-viewer{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:999;align-items:center;justify-content:center;padding:20px}
    .photo-viewer.on{display:flex}
    .photo-viewer img{max-width:100%;max-height:90vh;border-radius:12px;object-fit:contain}
    .photo-viewer-close{position:fixed;top:16px;left:16px;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:22px;width:40px;height:40px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center}

    /* reviews */
    .cb-rv-title{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
    .rv{background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:7px;border:1px solid var(--border)}
    .rv-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
    .rv-name{font-size:12px;font-weight:800;color:var(--text)}
    .rv-stars{font-size:11px;color:#e6a817;letter-spacing:1px}
    .rv-text{font-size:12px;color:var(--muted);line-height:1.55;font-style:italic}

    .cb-sep{height:1px;background:var(--border);margin:12px 0}

    /* buttons */
    .cb-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .cbtn{border:none;border-radius:12px;padding:13px 8px;font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;transition:.15s;font-family:inherit}
    .cbtn-call{background:var(--green);color:#fff}
    .cbtn-wa{background:var(--wa);color:#fff}
    .cbtn-share{grid-column:1/-1;background:var(--red);color:#fff;font-size:13px}
    .cbtn:active{opacity:.85;transform:scale(.98)}

    /* bottom */
    .bottom-bar{width:100%;max-width:420px;text-align:center}
    .bottom-bar-phrase{font-family:'Amiri',serif;color:rgba(245,166,35,.8);font-size:15px;margin-bottom:3px}
    .bottom-bar-link{font-size:11px;color:rgba(255,255,255,.3);text-decoration:none}

    /* toast */
    .toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(12px);background:#1e1e1e;color:#fff;padding:10px 20px;border-radius:24px;font-size:13px;font-weight:700;opacity:0;pointer-events:none;transition:.25s;z-index:99;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.4)}
    .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  </style>
</head>
<body>
<div class="page">

  <div class="logo-bar">
    <a href="/" class="logo-bar-brand">جاك<span>.ما</span></a>
    <span class="logo-bar-tagline">خدمات المنزل بالمغرب</span>
  </div>

  <div class="card">

    <div class="ch">
      <div class="ch-top">
        ${photoHtml}
        <div class="ch-info">
          <div class="ch-name">${eName}${worker.verified ? ' <span style="color:#5dade2;font-size:16px">✔</span>' : ''}</div>
          <div class="ch-cat">${icon} ${eCat}</div>
          <div class="ch-avail">
            ${worker.available !== false ? '<span class="adot"></span>متاح الآن' : '<span style="color:#e74c3c">●</span> مشغول حالياً'}
          </div>
        </div>
      </div>
      <div class="ch-meta">
        ${worker.city ? `<span class="ch-pill">📍 ${eCity}${worker.zone ? ' — '+eZone : ''}</span>` : ''}
        ${worker.experience ? `<span class="ch-pill">🏆 ${worker.experience} سنين</span>` : ''}
        ${worker.jobs_done ? `<span class="ch-pill">✅ ${worker.jobs_done}+ مشروع</span>` : ''}
      </div>
    </div>

    <div class="cb">
      ${worker.rating ? `<div class="cb-stars">${stars} <span class="cb-stars-count">${worker.rating} / 5 &nbsp;·&nbsp; ${worker.rating_count} تقييم</span></div>` : ''}
      ${worker.price ? `<div class="cb-price"><span class="cb-price-amt">${worker.price} درهم</span><span class="cb-price-u">/ ${worker.price_unit||'المرة'}</span></div>` : ''}
      ${worker.description ? `<div class="cb-desc">${eDesc}</div>` : ''}
      ${tags ? `<div class="cb-tags">${tags}</div>` : ''}

      ${(worker.work_photos||[]).length ? `
      <div class="cb-gallery-title">📸 من أعمالي</div>
      <div class="cb-gallery">
        ${(worker.work_photos).map(p=>`<img class="cb-gallery-img" src="${p}" loading="lazy" onclick="openPhoto(this.src)"/>`).join('')}
      </div>` : ''}

      ${reviewsHtml ? `
      <div class="cb-rv-title">💬 آراء العملاء</div>
      ${reviewsHtml}` : ''}

      <div class="cb-sep"></div>

      <div class="cb-btns">
        <a class="cbtn cbtn-call" href="tel:${worker.phone}">📞 اتصل</a>
        <a class="cbtn cbtn-wa" href="https://wa.me/${waPhone}?text=${waMsg}" target="_blank">💬 واتساب</a>
        <a class="cbtn cbtn-share" href="https://wa.me/?text=${shareMsg}" target="_blank">📤 شارك البروفيل — الدال على الخير كفاعله 🤲</a>
      </div>
    </div>

  </div>

  <div class="bottom-bar">
    <div class="bottom-bar-phrase">الدال على الخير كفاعله 🤲</div>
    <a href="/" class="bottom-bar-link">جاك.ما — خدمات المنزل بالمغرب</a>
  </div>

</div>
<div class="toast" id="toast"></div>
<div class="photo-viewer" id="photoViewer" onclick="closePhoto()">
  <button class="photo-viewer-close" onclick="closePhoto()">✕</button>
  <img id="photoViewerImg" src="" alt=""/>
</div>
<script>
function copyLink(){
  navigator.clipboard.writeText('${pageUrl}').then(()=>{
    const t=document.getElementById('toast');
    t.textContent='✅ تم نسخ الرابط — شاركه فواتساب!';
    t.classList.add('on');
    setTimeout(()=>t.classList.remove('on'),3000);
  });
}
function openPhoto(src){
  document.getElementById('photoViewerImg').src=src;
  document.getElementById('photoViewer').classList.add('on');
}
function closePhoto(){
  document.getElementById('photoViewer').classList.remove('on');
  document.getElementById('photoViewerImg').src='';
}
</script>
</body>
</html>`);
});

// ─── AI CHAT ─────────────────────────────────────────────────────────────────

// --- Darija LoRA inference endpoint (added 2026-05-17) ---
// HF_TOKEN is declared higher up for the multi-provider router; just reuse it.
const HF_DARIJA_MODEL = 'Samielakkad1/jakma-darija-A-adapter';
const HF_INFERENCE_URL = `https://api-inference.huggingface.co/models/${HF_DARIJA_MODEL}`;

app.post('/api/ai/darija', aiLimiter, async (req, res) => {
  if (!HF_TOKEN) {
    return res.status(503).json({ error: 'not_configured', detail: 'HF_TOKEN env var missing on server' });
  }
  const t0 = Date.now();
  const { message = '', maxTokens = 200 } = req.body || {};
  const userText = String(message || '').trim();
  if (!userText) return res.status(400).json({ error: 'empty_message' });
  if (userText.length > 800) return res.status(400).json({ error: 'message_too_long', max: 800 });

  // Build a Qwen chat-template prompt around the user's text.
  // The adapter was trained on the jak.ma assistant persona.
  const systemPrompt = "أنت 'جاك ذكي' 🤖، المساعد الذكي لمنصة جاك.ما — منصة مغربية للخدمات المنزلية بلا عمولة. جاوب دائماً بالدارجة الطبيعية، قصير ومفيد.";
  const prompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${userText}<|im_end|>\n<|im_start|>assistant\n`;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 35000); // HF cold start can take ~25s
    const hfResp = await fetch(HF_INFERENCE_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: Math.min(Number(maxTokens) || 200, 400),
          return_full_text: false,
          temperature: 0.3,
          top_p: 0.9,
          do_sample: true,
        },
        options: { wait_for_model: true, use_cache: true },
      }),
    });
    clearTimeout(timeout);

    if (hfResp.status === 503) {
      // Model is loading (cold start). Tell client to retry.
      let waitSeconds = 25;
      try { const j = await hfResp.json(); waitSeconds = j.estimated_time || 25; } catch {}
      return res.status(202).json({ loading: true, retryAfter: Math.ceil(waitSeconds) });
    }
    if (hfResp.status === 429) {
      return res.status(429).json({ error: 'rate_limited', detail: 'HF free tier exceeded; try again later' });
    }
    if (!hfResp.ok) {
      const body = await hfResp.text().catch(() => '');
      console.warn('[darija] HF non-ok', hfResp.status, body.slice(0, 200));
      return res.status(502).json({ error: 'upstream_error', status: hfResp.status });
    }

    const data = await hfResp.json();
    // Response shape: [{ generated_text: "..." }]
    let raw = '';
    if (Array.isArray(data) && data[0]?.generated_text) raw = data[0].generated_text;
    else if (data.generated_text) raw = data.generated_text;
    else raw = '';

    // Trim assistant role markers if the model emitted them.
    const cleaned = raw
      .replace(/^<\|im_start\|>assistant\s*/g, '')
      .replace(/<\|im_end\|>.*$/s, '')
      .replace(/<\|.+?\|>/g, '')
      .trim();

    res.json({
      reply: cleaned || '(empty response)',
      model: 'jakma-darija-A-adapter',
      base: 'Qwen2.5-1.5B-Instruct',
      ms: Date.now() - t0,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'timeout', detail: 'HF inference took longer than 35s — model is still warming up, please retry' });
    }
    console.error('[darija] error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// =====================================================================
// --- end Darija LoRA endpoint ---

app.post('/api/ai/chat', aiLimiter, async (req, res) => {
  if (!LLM_CONFIGURED) return res.status(503).json({ error: 'AI غير مفعّل' });

  // Grounded retrieval path (feature-flagged). Falls through to legacy handler
  // when the flag is off OR when DB isn't available (graceful degrade).
  if (USE_GROUNDED) {
    const dbInstance = await connectDB();
    if (dbInstance) {
      try {
        await handleGroundedChat({ callXAI: callLLM, callClaude, db: dbInstance, req, res, logger: console });
      } catch (err) {
        console.error('[grounded] uncaught:', err);
        if (!res.headersSent) res.status(500).json({ error: 'مشكل تقني — عاود المحاولة' });
        else if (!res.writableEnded) { try { res.end(); } catch {} }
      }
      return;
    }
    // DB unreachable → fall through to legacy (which has its own JSON fallback)
    console.warn('[grounded] DB unavailable; falling through to legacy handler');
  }

  const { messages = [], city: ctxCity, category: ctxCat, image } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'no messages' });

  const userMessages = messages.filter(m => m.role === 'user');
  const latestUserText = userMessages[userMessages.length - 1]?.text || '';
  const fullText = messages.map(m => m.text || '').join(' ');
  let detectedCat = ctxCat || detectFromText(latestUserText, KEYWORD_TO_CAT) || detectFromText(fullText, KEYWORD_TO_CAT);
  // City: latest message wins — prevents previous AI responses from polluting city detection
  const detectedCity = ctxCity || detectFromText(latestUserText, KEYWORD_TO_CITY) || detectFromText(fullText, KEYWORD_TO_CITY);

  // When an image is present and text gave no category, ask Gemini vision to identify the trade.
  // Single-label task → cheap Gemini Flash, not Sonnet.
  if (image && !detectedCat) {
    try {
      const imgResp = await callLLM([{ role: 'user', content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: 'قول ليا فقط: ما هي الفئة المناسبة من هذه القائمة: طريسيان، بلومبي، صباغة، نجارة، بناء، نقاوة، حدادة، ديكور، نقل، كلامبيستري، خياطة، حراسة — جاوب بكلمة واحدة فقط' }
      ]}], { model: GEMINI_MODEL_VISION, temperature: 0, maxTokens: 20 });
      const imgData = await imgResp.json();
      const raw = (imgData.choices?.[0]?.message?.content || '').trim().replace(/[.،\s]/g, '');
      const VALID_CATS = ['طريسيان','بلومبي','صباغة','نجارة','بناء','نقاوة','حدادة','ديكور','نقل','كلامبيستري','خياطة','حراسة'];
      if (VALID_CATS.includes(raw)) detectedCat = raw;
    } catch (e) { /* fall through — unfiltered fetch is fine */ }
  }

  // Detect multi-trade project intent
  const MULTI_TRADE_PATTERNS = {
    'تجديد الحمام|جدد الحمام|renovation salle de bain|refaire salle de bain': ['بلومبي','كلامبيستري','طريسيان','صباغة'],
    'تجديد الشقة|جدد الشقة|تجديد البيت|جدد البيت|renovation appartement|refaire appart': ['بناء','طريسيان','صباغة','ديكور'],
    'بناء دار|بناء بيت|construction maison|construire': ['بناء','طريسيان','بلومبي','كلامبيستري'],
    'مطبخ جديد|تجديد المطبخ|nouvelle cuisine|refaire cuisine': ['نجارة','طريسيان','بلومبي','كلامبيستري'],
    'تجديد السطح|إيتانشيتي|terrasse|toiture|étanchéité': ['بناء','كلامبيستري','صباغة'],
    'مشروع تجديد|تخطيط مشروع|نجدد|نرمم|renovation|rénover|rénovation': ['بناء','طريسيان','صباغة','ديكور'],
  };
  let multiTradeCats = null;
  for (const [pattern, cats] of Object.entries(MULTI_TRADE_PATTERNS)) {
    if (new RegExp(pattern, 'i').test(fullText)) { multiTradeCats = cats; break; }
  }

  // Fetch workers — multi-trade or single
  let workers = [];
  let workersByTrade = null;
  try {
    await connectDB();
    const fetchCat = async (cat, city) => {
      const filter = { approved: { $ne: false }, category: cat };
      if (city) filter.city = city;
      if (db) return db.collection('workers').find(filter).sort({ rating: -1, rating_count: -1 }).limit(4).toArray();
      return loadWorkersJSON().filter(w => w.category === cat && (!city || w.city === city)).sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,4);
    };

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000));

    if (multiTradeCats) {
      const results = await Promise.race([
        Promise.all(multiTradeCats.map(cat => fetchCat(cat, detectedCity))),
        timeout
      ]);
      workersByTrade = {};
      multiTradeCats.forEach((cat, i) => { workersByTrade[cat] = results[i] || []; });
      workers = Object.values(workersByTrade).flat();
    } else {
      const fetchWithFilter = async (cat, city) => {
        const filter = { approved: { $ne: false } };
        if (cat)  filter.category = cat;
        if (city) filter.city = city;
        if (db) return db.collection('workers').find(filter).sort({ rating: -1, rating_count: -1 }).limit(8).toArray();
        return loadWorkersJSON().filter(w => (!cat||w.category===cat)&&(!city||w.city===city)).sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,8);
      };
      let raw = await Promise.race([fetchWithFilter(detectedCat, detectedCity), timeout]);
      // Fallback: if city+cat returns nothing, drop city filter
      if (!raw.length && detectedCity && detectedCat) {
        raw = await fetchWithFilter(detectedCat, null);
      }
      // Fallback: if cat returns nothing, fetch any city
      if (!raw.length && detectedCity && !detectedCat) {
        raw = await fetchWithFilter(null, detectedCity);
      }
      workers = raw.map(w => ({
        _id: String(w._id || w.id), name: w.name, category: w.category,
        city: w.city, zone: w.zone || '', phone: w.phone,
        rating: w.rating || 0, rating_count: w.rating_count || 0,
        experience: w.experience || 0, price: w.price || '',
        price_unit: w.price_unit || '', description: (w.description || '').slice(0, 90),
      }));
    }
  } catch (e) { console.error('AI workers fetch:', e.message); }

  const sanitize = w => ({
    _id: String(w._id || w.id), name: w.name, category: w.category,
    city: w.city, zone: w.zone || '', phone: w.phone,
    rating: w.rating || 0, rating_count: w.rating_count || 0,
    experience: w.experience || 0, price: w.price || '',
    price_unit: w.price_unit || '', description: (w.description || '').slice(0, 90),
  });
  if (workersByTrade) {
    Object.keys(workersByTrade).forEach(k => { workersByTrade[k] = workersByTrade[k].map(sanitize); });
    workers = Object.values(workersByTrade).flat();
  }

  const systemPrompt = `أنت "جاك ذكي" 🤖، المساعد الذكي لمنصة جاك.ما — منصة مغربية للخدمات المنزلية بلا عمولة.
تتحدث الدارجة المغربية، العربية، والفرنسية. رد دائماً بنفس لغة/لهجة المستخدم.

═══════════════════════════════════════════
💰 قاعدة الأسعار العادلة (بالدرهم المغربي)
═══════════════════════════════════════════
استعمل هذه الأسعار عند السؤال "شحال يستاهل؟" أو "واش السعر معقول؟":

🚰 بلومبي:
  - تغيير صنبور (robinet): 80–150 درهم
  - إصلاح تسريب بسيط: 100–200 درهم
  - تغيير سيفون/سيباك: 150–300 درهم
  - تغيير chauffe-eau كامل: 400–800 درهم (+ ثمن الجهاز)
  - تسديد مصرف مسدود: 100–250 درهم
⚡ طريسيان:
  - تغيير prise/interrupteur: 50–100 درهم
  - إصلاح disjoncteur: 100–200 درهم
  - تركيب lustre/plafonnier: 80–150 درهم
  - تمديد كامل (tableau + câblage): 1500–4000 درهم حسب المساحة
🎨 صباغة (بالمتر المربع أو الغرفة):
  - غرفة واحدة (جدران فقط): 300–600 درهم
  - شقة 2 غرف: 700–1200 درهم
  - شقة 3 غرف: 1000–1800 درهم
  - طلاء خارجي (façade): 40–80 درهم/م²
🪵 نجارة:
  - إصلاح باب خشب: 100–250 درهم
  - تركيب باب جديد: 300–600 درهم
  - باب ألمنيوم/PVC تركيب: 400–900 درهم
🧱 بناء/ماصو:
  - ترميم شقوق بسيطة: 200–500 درهم
  - heure maçon: 80–120 درهم/ساعة
🛁 كلامبيستري (تبليط):
  - تبليط م²: 80–150 درهم/م² (اليد فقط)
  - حمام كامل (8-12م²): 800–1800 درهم اليد
🔩 حدادة: 100–200 درهم/ساعة
🛋️ ديكور (faux plafond): 80–150 درهم/م²

عند تقييم سعر قاله المستخدم:
- إذا كان في النطاق → "السعر معقول ✅"
- إذا كان أعلى بـ20%+ → "غالي شوية — جرب تفاوض على [X] درهم"
- إذا كان أعلى بـ50%+ → "غالي بزاف — السعر الطبيعي [X-Y] درهم"
- اذكر دائماً أن الأسعار تتفاوت حسب التعقيد والمنطقة

═══════════════════════════════════════════
🛠️ قاعدة "واش خصني معلم؟" — DIY أولاً
═══════════════════════════════════════════
هذه المشاكل يقدر الزبون يحلها وحده قبل ما يدفع للمعلم:

✂️ يمكن DIY (قول ليه كيفاش + إلا ما تقدرش اقترح معلم):
  - صنبور يقطر: غالباً جوان (joint) بـ5–10 دراهم
  - chasse d'eau ما تعبيش: غالباً flotteur أو joint klapet
  - disjoncteur يطيح: حاول تعرف السبب، فصل الأجهزة الثقيلة
  - باب ما يغلقش مزيان: تحقق من المفصلات (charnières) أولاً
  - بالوعة بطيئة: جرب déboucheur chimique أولاً (50 درهم)
  - بقعة رطوبة صغيرة: تحقق من السطح والنوافذ أولاً

🔧 خصك معلم (لا تتردد):
  - سرب ماء من الحيط أو السقف
  - كورتسيرة أو رائحة احتراق كهرباء
  - تشقق في الجدار
  - أي مشكل فيه خطر

الأسلوب: كن صادقاً — إذا كانت مشكلة بسيطة قول ليه يجربها وحده أولاً. هذا يبني الثقة.
بعد النصيحة DIY، اقترح دائماً معلم احتياطياً: "إلا ما تقدرتيش، عندنا هاد المعلم..."

═══════════════════════════════════════════
🏗️ قاعدة تخطيط المشاريع المتعددة
═══════════════════════════════════════════
إذا ذكر المستخدم مشروع تجديد كامل (حمام، شقة، مطبخ، دار...):
1. اشرح ترتيب الخدامة (مهم جداً — الترتيب الخاطئ يكلف غالي)
2. استعمل هاد الماركر: <<MULTI:cat1|cat2|cat3|cat4>>
   مثال حمام: <<MULTI:بلومبي|كلامبيستري|طريسيان|صباغة>>
   مثال شقة: <<MULTI:بناء|طريسيان|صباغة|ديكور>>
   مثال مطبخ: <<MULTI:نجارة|طريسيان|بلومبي|كلامبيستري>>
3. بعد الماركر، ما تكتب <<WORKERS:...>> — الـ MULTI يكفي

الترتيب الصحيح دائماً:
  - الحمام: بلومبي أولاً ← كلامبيستري ← طريسيان ← صباغة
  - الشقة: هدم/بناء ← كهرباء وسباكة ← بلاط ← صباغة ← ديكور
  - المطبخ: نجارة ← كهرباء ← سباكة ← بلاط

═══════════════════════════════════════════
📚 دليل الفئات — اقرأ بعناية قبل أي تصنيف
═══════════════════════════════════════════

🚰 بلومبي (Plombier) — مشاكل الماء والصرف الصحي فقط:
  ✅ سرب ماء (من الحيط، السقف، تحت الأرض)
  ✅ صنبور يقطر أو مكسور (robinet)
  ✅ مرحاض/طواليت: مسدود، يسرب، الشاسي مكسور
  ✅ دوش/بانيو: تسريب، صرف بطيء
  ✅ سخان الماء (chauffe-eau/cumulus): عطل، تسريب
  ✅ بيبان (canalisations): سدة، تسريب، صوت
  ✅ ضغط الماء ضعيف أو مفقود
  ✅ مصرف/بالوعة مسدودة (évacuation bouchée)
  ❌ لا يشمل: الكهرباء، البلاط، السقف الجبسي

⚡ طريسيان (Électricien) — كل ما يتعلق بالكهرباء:
  ✅ ضوء مش خدام / أضواء تقطع
  ✅ فيشة/بريزة ما تخدمش (prise morte)
  ✅ قاطع يطيح (disjoncteur saute)
  ✅ تابلو كهربائي (tableau électrique): إعادة تنظيم، إضافة قاطعات
  ✅ تمديد أسلاك جديدة (câblage)
  ✅ كورتسيرة (court-circuit)
  ✅ تركيب إنارة / لمبات / lustre
  ✅ جرس/إنتيرفون (sonnette/interphone)
  ✅ تركيب كليماتيزور (الجانب الكهربائي)
  ❌ لا يشمل: غاز، سباكة، ميكانيك

🎨 صباغة (Peintre) — الطلاء والتشطيب الجداري:
  ✅ طلاء حيطان الداخل والخارج
  ✅ طلاء طايح أو مقشور
  ✅ بقع رطوبة فالحيط (بعد إصلاح السرب)
  ✅ sous-couche + peinture finition
  ✅ enduit / crépi للواجهات
  ✅ ورق الحيطان (papier peint)
  ❌ لا يشمل: البلاط، الجبس، البناء

🪵 نجارة (Menuisier) — أبواب وشبابيك وخشب:
  ✅ باب خشب: كسور، ما كيسكتش، تبديل
  ✅ شباك خشب / PVC / ألمنيوم
  ✅ خزانة مطبخ / دولاب (placard/armoire)
  ✅ باركيه (parquet): تركيب، إصلاح، تلميع
  ✅ أثاث خشبي: تصليح، تركيب
  ✅ Menuiserie PVC/Aluminium للنوافذ
  ❌ لا يشمل: باب الحديد (حدادة)، البلاط

🧱 بناء (Maçon) — أعمال البناء والترميم:
  ✅ تشقق الحيطان (fissures)
  ✅ ترميم شامل (rénovation)
  ✅ بناء جديد (construction)
  ✅ هدم وإزالة (démolition)
  ✅ chape (صبة أرضية)
  ✅ إيتانشيتي السطح/الطراسة (étanchéité toiture)
  ✅ ravalement de façade
  ❌ لا يشمل: البلاط (كلامبيستري)، الطلاء (صباغة)

🧹 نقاوة (Nettoyage) — التنظيف فقط:
  ✅ تنظيف الدار / المكتب (ménage)
  ✅ تنظيف عميق بعد البناء
  ✅ تنظيف زرابي / كنبة / ستائر
  ✅ تعقيم وتطهير
  ✅ تنظيف خزانات الماء
  ❌ لا يشمل: أي إصلاح

🔩 حدادة (Ferronnier/Soudeur) — حديد وسودور:
  ✅ باب الحديد / البوابة (portail)
  ✅ ضريبة / grille للشبابيك
  ✅ درابزين / garde-corps
  ✅ سياج حديدي (clôture)
  ✅ سودور (soudure) لأي قطعة معدنية
  ✅ سلم الحديد
  ❌ لا يشمل: باب الخشب (نجارة)، بيبان الماء (بلومبي)

🛋️ ديكور (Décorateur) — تصميم وتزيين داخلي:
  ✅ فوس بلافون (faux plafond) بالجبس أو الجبسوم
  ✅ تزيين جبسي (staff / plâtre décoratif)
  ✅ تصميم داخلي كامل
  ✅ إضاءة ديكورية
  ✅ ستائر وتنجيد
  ✅ 3D design
  ❌ لا يشمل: الطلاء (صباغة)، البناء الهيكلي

🚚 نقل (Déménagement) — نقل العفش والأثاث:
  ✅ نقل الأثاث داخل المدينة / بين المدن
  ✅ تحويل الدار / المكتب
  ✅ شاحنة + عمال (camion + manutentionnaires)
  ✅ تغليف وتعبئة
  ❌ لا يشمل: أي إصلاح

🛁 كلامبيستري (Carreleur) — بلاط وزليج وإيتانشيتي:
  ✅ تبليط أرضية (carrelage sol)
  ✅ فايانس حمام / مطبخ (faïence mur)
  ✅ زليج مغربي (zellige)
  ✅ رخام (marbre)
  ✅ إيتانشيتي البالكون / الطراسة (étanchéité terrasse)
  ✅ بلاط مكسور أو مرفوع
  ❌ لا يشمل: إيتانشيتي السطح الهيكلي (بناء)

🧵 خياطة (Couturier/Tapissier):
  ✅ تقصير / تضييق / توسيع الملابس
  ✅ خياطة قفطان / جلابة / تقليدية
  ✅ ستائر ورداه (rideaux sur mesure)
  ✅ تنجيد كنبة / كراسي (tapisserie)
  ❌ لا يشمل: أي إصلاح منزلي آخر

🛡️ حراسة (Gardiennage):
  ✅ حارس ليلي / نهاري
  ✅ حراسة عمارة / فيلا / مكتب
  ✅ vigile لفعالية أو حدث
  ❌ لا يشمل: كاميرات (طريسيان)

═══════════════════════════════════════════
⚠️ قواعد التصنيف الصارمة:
- باب الحديد → حدادة | باب الخشب → نجارة
- سرب ماء من الحيط → أولاً بلومبي لإيقاف السرب، ثم صباغة للطلاء
- فوس بلافون (faux plafond) → ديكور وليس بناء
- إيتانشيتي السطح → بناء | إيتانشيتي الطراسة/البالكون → كلامبيستري
- كليماتيزور تركيب (الكهربائي) → طريسيان | تصليح الميكانيك → تقني متخصص
═══════════════════════════════════════════

الخدامة المتاحون حالياً (JSON — لا تخترع غيرهم أبداً):
${JSON.stringify(workers)}

المدن: الدار البيضاء، الرباط، طنجة، مراكش، أكادير، فاس، سلا، مكناس، وجدة، القنيطرة، تطوان، الجديدة، بني ملال، خريبكة، سطات

═══════════════════════════════════════════
📷 دليل التعرف البصري على الصور:
- تيوبو/بيبان ماء (PVC أو معدن) → بلومبي
- رطوبة/بقع ماء فالحيط → بلومبي أولاً ثم صباغة
- أسلاك كهربائية، تابلو، قاطعات → طريسيان
- شقوق/تشققات فالحيط أو السقف → بناء
- بلاط مكسور أو مرفوع → كلامبيستري
- باب خشب، خزانة، باركيه → نجارة
- باب أو سياج حديد → حدادة
- صبغة طايحة/مقشورة → صباغة
- سقف جبسي (faux plafond) أو تزيين → ديكور
═══════════════════════════════════════════

دورك:
1. افهم المشكل من النص أو الصورة بدقة
2. طبّق دليل الفئات والدليل البصري أعلاه — لا تخمّن
3. جاوب قصير (2-3 أسطر)، اذكر الفئة بإيموجيها

═══════════════════════════════════════════
📌 متى تستعمل كل ماركر — اتبع هذا بدقة
═══════════════════════════════════════════

<<WORKERS:id1,id2,id3>> — استعملها كلما ظننت أن الخدام مفيد:
  ✅ المشكل يحتاج حرفي
  ✅ الزبون طلب خدام
  ✅ بعد نصيحة DIY — دائماً أضف خدام احتياطي "إلا ما تقدرتيش..."
  ✅ بعد تقييم السعر — اقترح خدامين بديلين إذا كان السعر غالي
  ✅ إذا المشكل يبدو معقد أو خطير
  ❌ لا تستعملها: أسئلة عامة بدون مشكل محدد

<<MULTI:cat1|cat2|cat3>> — استعملها فقط عندما:
  ✅ المشروع يحتاج أكثر من خدام (تجديد، بناء كامل...)
  ❌ لا تجمع مع <<WORKERS:>> في نفس الرد

<<DRAFT:نص الرسالة>> — استعملها فقط عندما:
  ✅ الزبون اختار خدام وطلب رسالة واتساب

قواعد إضافية — مهمة جداً:
- إذا ما عرفتيش المدينة، اسأل سؤال واحد فقط
- ابدأ رسائل واتساب بـ "السلام يا معلم،"
- لا تذكر الـ_id أبداً في النص الظاهر
- تقديرات التكلفة واقعية بالدرهم المغربي
- ⛔ لا تكتب أرقام الهاتف أبداً في النص — استعمل <<WORKERS:>> فقط
- ⛔ لا تخترع خدامة من عندك أبداً — استعمل فقط الـ _id الموجودة في JSON أعلاه
- ⛔ إذا كانت قائمة الخدامين فارغة في المدينة، قل: "ما كاينش خدامة مسجلين في [المدينة] دابا — نقدر نعطيك خدامة من مدن قريبة إلا بغيتي" ثم اقترح من قائمة الخدامين المتاحين
- ✅ دائماً استعمل الـ _id من قائمة الخدامين JSON اللي فوق`;

  const lastMsg = messages[messages.length - 1].text || '';

  // Build xAI messages array — system + history + last user message (multimodal if image)
  const xaiMessages = [{ role: 'system', content: systemPrompt }];
  messages.slice(0, -1).forEach(m => {
    xaiMessages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text || '' });
  });
  const lastContent = (image && typeof image === 'string' && image.startsWith('data:image/'))
    ? [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: lastMsg || 'حلل ليا هاد الصورة وقول ليا المشكل والتكلفة والخدام المناسب' }]
    : (lastMsg || '...');
  xaiMessages.push({ role: 'user', content: lastContent });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // Legacy non-grounded streaming chat. Route via the multi-provider router:
    // images route to Sonnet (vision quality), text-only goes to Gemini Flash.
    const hasImageInput = !!(image && typeof image === 'string' && image.startsWith('data:image/'));
    const llmResp = await callLLM(xaiMessages, {
      routing: { hasImage: hasImageInput, longHistory: messages.length > 5 },
      temperature: 0.7,
      maxTokens: 400,
      stream: true,
    });

    let buffer = '';
    for await (const chunk of llmResp.body) {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') break;
        try {
          const t = JSON.parse(d).choices?.[0]?.delta?.content;
          if (t) res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
        } catch { /* ignore parse errors */ }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, workers, workersByTrade })}\n\n`);
  } catch (err) {
    console.error('Claude chat error:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'مشكل في الاتصال — عاود المحاولة' })}\n\n`);
  } finally {
    res.end();
  }
});

// ─── SMART WHATSAPP MESSAGE ────────────────────────────────────────────────────
app.post('/api/ai/smartmsg', aiLimiter, async (req, res) => {
  const { worker, context } = req.body || {};
  if (!worker) return res.status(400).json({ error: 'worker required' });
  const fallback = `السلام يا معلم ${worker.name}، شفت إعلانك فجاك.ما على ${worker.category} فـ${worker.city}. واش متاح وشحال كتكلف؟ شكراً`;
  if (!LLM_CONFIGURED) return res.json({ message: fallback });

  const prompt = `أنت مساعد يكتب رسائل واتساب قصيرة واحترافية بالدارجة المغربية.
اكتب رسالة واتساب (3-4 جمل فقط) لإرسالها لـ:
الاسم: ${worker.name}
التخصص: ${worker.category}
المدينة: ${worker.city}${worker.price ? `\nالسعر: ${worker.price} درهم` : ''}${context ? `\nالسياق: ${context}` : ''}

القواعد الصارمة:
- ابدأ دائماً بـ "السلام يا معلم ${worker.name}،"
- اذكر التخصص والمدينة
- اسأل عن التوفر والأسعار
- كن مؤدباً وطبيعياً بالدارجة
- لا تضف أي شرح — فقط نص الرسالة`;

  try {
    // WhatsApp template generator — simple short-form gen, default to Gemini Flash.
    const r = await callLLM([{ role: 'user', content: prompt }], { model: GEMINI_MODEL_DEFAULT, temperature: 0.7, maxTokens: 200 });
    const data = await r.json();
    const message = data.choices?.[0]?.message?.content?.trim() || fallback;
    res.json({ message });
  } catch (err) {
    console.error('smartmsg error:', err.message);
    res.json({ message: fallback });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── KEEP-ALIVE ───────────────────────────────────────────────────────────────
// Ping endpoint — hit by an external cron every 24h to keep Atlas from pausing
app.get('/ping', async (req, res) => {
  try {
    await connectDB();
    const count = db ? await db.collection('workers').countDocuments({ approved: { $ne: false } }) : 0;
    res.json({ ok: true, workers: count, ts: new Date().toISOString() });
  } catch { res.json({ ok: false }); }
});

// ─── ADMIN: ONE-TIME DATA MIGRATION ──────────────────────────────────────────
// Applies Darija descriptions, Darija reviews, and real price fixes to MongoDB.
// Call once: POST /api/admin/migrate  with header x-admin-password: <pass>
app.post('/api/admin/migrate', requireAdmin, async (req, res) => {
  await connectDB();
  if (!db) return res.status(503).json({ error: 'MongoDB not connected' });
  const col = db.collection('workers');

  // ── 1. PRICE RANGES (per-worker, via price-engine) ──
  // computePriceRange(worker) returns { min, max, unit } — imported at top of file

  // ── 2. DESCRIPTION TRANSLATION ──
  const DESC_TEMPLATES = [
    { starts:['أعمال بناء في '],              darija: c=>`بناء فـ${c} — البناء والليبسة والتصليح` },
    { starts:['سباكة في '],                   darija: c=>`بلومبي فـ${c} — تصليح التسريبات وتركيب الصنابر والحمامات` },
    { starts:['صباغة في '],                   darija: c=>`صباغة فـ${c} — الداخل والخارج، التيلي والواجزيري` },
    { starts:['نجارة في '],                   darija: c=>`نجارة فـ${c} — البيبان والشبابيك والأثاث عل التقديرة` },
    { starts:['ديكور داخلي في '],             darija: c=>`ديكور داخلي فـ${c} — جبس، بلاط، وتزويق الصالونات` },
    { starts:['نقل عفش في '],                darija: c=>`نقل العفش فـ${c} — داخل المدينة وبين المدن` },
    { starts:['تركيب وإصلاح كلامبيستري في '],darija: c=>`كلامبيستري فـ${c} — البلاط والزليج والرخام` },
    { starts:['خياطة وتعديل ملابس في '],      darija: c=>`خياطة فـ${c} — تخييط وتبديل الحوايج` },
    { starts:['حراسة وأمن في '],             darija: c=>`حراسة وأمن فـ${c}` },
    { starts:['خدمة كهرباء في ','كهربائي في '],darija:c=>`طريسيان فـ${c} — تحويلات، تمديدات، وتصليح العطالات` },
    { starts:['خدمة تنظيف في '],             darija: c=>`نقاوة فـ${c} — الشقق والفيلات والمكاتب` },
    { starts:['حدادة في '],                  darija: c=>`حدادة فـ${c} — الشبابيك وبيبان الحديد والدرابيز` },
  ];
  const VALID_CITIES = new Set(['طنجة','الدار البيضاء','عين الشق','عين السبع','أنفا','الحي الحسني','الحي المحمدي','المحمدية','سيدي مومن','أكادير','إنزكان','آيت ملول','تيزنيت','تارودانت','شتوكة آيت باها','مراكش','المحاميد','كيليز','تمارة مراكش','المدينة القديمة','سيدي يوسف']);
  function translateDesc(desc) {
    if (!desc) return null;
    for (const tpl of DESC_TEMPLATES) {
      for (const prefix of tpl.starts) {
        if (desc.startsWith(prefix)) {
          const rest = desc.slice(prefix.length);
          const cityRaw = rest.replace(/\s*[—–\-].*$|\s*\..*$/s,'').trim();
          let city = VALID_CITIES.has(cityRaw) ? cityRaw : null;
          if (!city) { for (const c of VALID_CITIES) { if (cityRaw.startsWith(c) && (!city||c.length>city.length)) city=c; } }
          if (!city) city = cityRaw;
          return tpl.darija(city);
        }
      }
    }
    return null;
  }

  // ── 3. REVIEW TRANSLATION (phrase-based) ──
  const EXACT_REV = {'ممتاز':'واعر','خدمة ممتازة':'خدمة واعرة','خدمة ممتازة!':'خدمة واعرة!','خدمة جيدة':'خدمة مزيانة','أحسنت':'أحسنت واللهي','عمل ممتاز':'خدمة واعرة','عمل جيد':'خدمة مزيانة','احترافي':'محترف بزاف','أنصح به بشدة':'ننصح بيه بزاف','جيد جدا':'مزيان بزاف','جيد جدًا':'مزيان بزاف','على ما يرام':'مزيان','بالتوفيق':'ربي يوفق','جميل جدا':'زوين بزاف','حظ سعيد':'ربي يوفق','متوسط':'عادي','ممتاز 👍':'واعر 👍','ممتازة':'واعرة','تجربة جيدة':'تجربة مزيانة','تجربة ممتازة':'تجربة واعرة','محترف للغاية':'محترف بزاف','لا بأس بها':'مشكاش','ليس سيئًا':'مشكاش','الخدمة رائعة':'الخدمة واعرة','في المستوى':'فالمستوى','جودة عالية':'جودة عالية','الافضل':'الأحسن','الأفضل':'الأحسن','شكراً جزيلا':'شكراً بزاف','شكرا جزيلا':'شكراً بزاف','إنه رائع':'واعر','عمل رائع':'خدمة واعرة','عمل متقن':'خدمة متقنة','مكان جيد':'بلاصة مزيانة','مكان جميل':'بلاصة زوينة','Lah yi3tik saha professional':'الله يعطيك الصحة، محترف','Khdma nqia lay 3tik saha':'خدمة نقية، الله يعطيك الصحة','Ahsan me3alem haliyan mo3amala tooop':'أحسن معلم دابا، المعاملة توب','Khedma mt9ona , chokran':'خدمة متقنة، شكراً','très bon rapport qualité prix':'التمن مناسب للجودة'};
  const PHRASES_REV = [['أنصح بها بشدة','ننصح بيها بزاف'],['أنصح بهم بشدة','ننصح بيهم بزاف'],['أنصح به بشدة','ننصح بيه بزاف'],['أوصي بها بشدة','ننصح بيها بزاف'],['أوصي به بشدة','ننصح بيه بزاف'],['أنصح به','ننصح بيه'],['أنصح بهم','ننصح بيهم'],['أنصح بها','ننصح بيها'],['أوصي به','ننصح بيه'],['أوصي بهم','ننصح بيهم'],['أوصي بها','ننصح بيها'],['نوصي به','ننصح بيه'],['ننصح به','ننصح بيه'],['للغاية','بزاف'],['جداً','بزاف'],['جدًا','بزاف'],['جدا','بزاف'],['بشدة','بزاف'],['ملتزمون بالمواعيد','مجاوبين على الوقت'],['ملتزم بالمواعيد','مجاوب على الوقت'],['في الوقت المحدد','مجاوب على الوقت'],['العملاء','الزبناء'],['عملاء','زبناء'],['يستحق الثناء','يستاهل المدح'],['يستحق','يستاهل'],['تستحق','تستاهل'],['شكراً جزيلاً','شكراً بزاف'],['شكرا جزيلا','شكراً بزاف'],['بالتوفيق','ربي يوفق'],['قيمة جيدة مقابل المال','التمن مناسب للخدمة'],['محترفون للغاية','محترفين بزاف'],['محترف للغاية','محترف بزاف'],['ممتاز جداً','واعر بزاف'],['ممتازة جداً','واعرة بزاف'],['ممتاز','واعر'],['ممتازة','واعرة'],['رائع جداً','واعر بزاف'],['رائع','واعر'],['رائعة','واعرة'],['متميز','واعر'],['متميزة','واعرة'],['جيد جداً','مزيان بزاف'],['جيدة جداً','مزيانة بزاف'],['جيد','مزيان'],['جيدة','مزيانة'],['خدمة ممتازة','خدمة واعرة'],['خدمة رائعة','خدمة واعرة'],['خدمة جيدة','خدمة مزيانة'],['عمل ممتاز','خدمة واعرة'],['عمل جيد','خدمة مزيانة'],['الأفضل','الأحسن'],['أفضل','أحسن'],['هذا','هاد'],['هذه','هادي'],['tooop','توب'],['wa3ra','واعرة'],['wa3r','واعر'],['mzyana','مزيانة'],['mzyan','مزيان'],['bzaf','بزاف'],['3jbni','عجبني'],['lah yi3tik','الله يعطيك'],['saha','صحة'],['professional','محترف']];
  function translateReview(text) {
    if (!text || !text.trim()) return null;
    const t = text.trim();
    if (EXACT_REV[t]) return EXACT_REV[t];
    let out = t;
    for (const [f,to] of PHRASES_REV) { if (out.includes(f)) out = out.split(f).join(to); }
    return out !== t ? out : null;
  }

  // ── Apply to all workers via bulk write ──
  const all = await col.find({}).toArray();
  const ops = [];
  let priceDone=0, descDone=0, revDone=0;
  for (const w of all) {
    const $set = {};
    const priceRange = computePriceRange(w);
    if (priceRange) {
      $set.price_min  = priceRange.min;
      $set.price_max  = priceRange.max;
      $set.price_unit = priceRange.unit;
      $set.price      = String(priceRange.min); // backward compat
      priceDone++;
    }
    const newDesc = translateDesc(w.description);
    if (newDesc && newDesc !== w.description) { $set.description = newDesc; descDone++; }
    if (Array.isArray(w.reviews) && w.reviews.length) {
      const newRevs = w.reviews.map(rv => { const nt=translateReview(rv.text); return nt?{...rv,text:nt}:rv; });
      if (newRevs.some((r,i)=>r.text!==w.reviews[i].text)) { $set.reviews=newRevs; revDone++; }
    }
    if (Object.keys($set).length) ops.push({ updateOne:{ filter:{_id:w._id}, update:{$set} } });
  }
  if (ops.length) await col.bulkWrite(ops, { ordered:false });
  res.json({ ok:true, total:all.length, ops:ops.length, pricesUpdated:priceDone, descriptionsUpdated:descDone, reviewsUpdated:revDone });
});

// ─── ADMIN: FIX CLASSIFICATIONS + REVIEWS ────────────────────────────────────
// Fixes:
//  1. Add secondary_categories to multi-trade workers
//  2. Clean fake/test/abusive/emoji-only reviews
//  3. Transliterate Darija-romanized reviews to Arabic script
//  4. Delete non-trade business "كن لايف كولكشن"
app.post('/api/admin/fix-data', requireAdmin, async (req, res) => {
  await connectDB();
  if (!db) return res.status(503).json({ error: 'MongoDB not connected' });
  const col = db.collection('workers');

  // ── Category keyword patterns ──
  const CAT_PATTERNS = {
    'بلومبي':    [/plomb/i,/سباكة/,/بلومبي/,/صنبور/,/تسريب/,/تركيب قنوات/,/tuyau/i,/planbier/i,/اصلاح شوفو/],
    'طريسيان':   [/electri/i,/كهربا/,/طريسيان/,/tableau/i,/تابلو كهربا/,/بريزة/,/panneau élect/i,/الماء و الكهرباء/,/elecrecien/i],
    'صباغة':     [/صباغ/,/peintr/i,/دهن/,/طلاء/,/تلوين/],
    'نجارة':     [/نجار/,/menuiser/i,/\bخشب\b/,/بيبان خشب/,/\bbois\b/i,/aluminium/i,/\bpvc\b/i,/ألومنيوم/],
    'بناء':      [/\bبناء\b/,/maçon/i,/\bmacon\b/i,/ليبسة/,/اسمنت/,/béton/i,/\bbeton\b/i,/\bتشييد\b/],
    'نقاوة':     [/نقاوة/,/تنظيف/,/\bmenage\b/i,/\bménage\b/i,/nettoyage/i,/femme de menage/i,/تنظيف شقق/],
    'حدادة':     [/حداد/,/soudeur/i,/ferronner/i,/\bحديد\b/,/درابيز/,/\brampe\b/i,/سودور/],
    'ديكور':     [/decor/i,/\bديكور\b/,/design/i,/\bجبس\b/,/تزويق/,/interieur/i,/amenagement/i,/aménagement/i,/ameublement/i],
    'نقل':       [/\bنقل\b/,/demenag/i,/déménag/i,/\btransport\b/i,/\bعفش\b/,/\bcamion\b/i,/\bشحن\b/],
    'كلامبيستري':[/carrel/i,/كلامبي/,/\bزليج\b/,/\bبلاط\b/,/revetement/i,/revêtement/i,/\bmarbre\b/i,/\bرخام\b/,/faience/i,/السيراميك/],
    'خياطة':     [/خياط/,/coutur/i,/retouche/i,/\bملابس\b/,/تفصيل/,/couturière/i],
    'حراسة':     [/حراس/,/gardien/i,/securit/i,/\bأمن\b/,/sécurité/i,/\bvigil/i],
  };
  const VALID_CATS = new Set(Object.keys(CAT_PATTERNS));

  function detectCats(w) {
    const text = [w.name||'', w.description||'', ...(w.tags||[])].join(' ');
    const found = new Set();
    for (const [cat, pats] of Object.entries(CAT_PATTERNS)) {
      if (pats.some(p => p.test(text))) found.add(cat);
    }
    return found;
  }

  // ── Darija-romanized → Arabic transliteration map ──
  const DARIJA_MAP = {
    'Tooop':'توب','tooop':'توب',
    'Merci':'شكراً','merci':'شكراً','merciii':'شكراً بزاف','Merciiiii':'شكراً بزاف',
    'Bravos':'برافو',
    'Ya salam':'يا سلام',
    'MEZYANEEE':'مزيان بزاف',
    'Khdma n9iya':'خدمة نقية',
    'khdma n9iya':'خدمة نقية',
    'kolchi zwin':'كلشي زوين',
    'Bon Service':'خدمة مزيانة','Bon service':'خدمة مزيانة',
    'Prix tal3in':'التمن غالي شوية',
    'Tooop driver':'سائق توب',
    'Un Mr m3alem':'معلم',
    'khdmtou nadya':'خدمتهم نقية',
    'Lah i3tik sha':'الله يعطيك الصحة',
    'Ni3ma lmo3amla':'نعمة المعاملة',
    'Tbarkalah 3lik':'تبارك الله عليك',
    'Chokrane likom':'شكراً ليكم',
    'Top lah isekhar':'توب، الله يسخر',
    'Ramadan mobarak':'رمضان مبارك',
    'Je le recommande':'ننصح بيه',
    'Ahsan 4adma walah':'أحسن خدمة والله',
    'khdma professionnel':'خدمة محترفة',
    'Khdma nqia tbarklah':'خدمة نقية، تبارك الله',
    'Top khdma lhoma brik':'خدمة توب، الله بارك',
    'A7san planbier fl3alam':'أحسن بلومبي فالعالم',
    'Bon service lhaj mbarek':'خدمة مزيانة الحاج مبارك',
    'Bon service lahouma barik':'خدمة مزيانة، الله بارك',
    'Tbarklah khdamtkom mt9ona':'تبارك الله، خدمتكم متقنة',
    'Très réactif tbarklah 3lik':'رد السريع، تبارك الله عليك',
    'khdmtha n9iya lahouma barik':'خدمتها نقية، الله بارك',
    'Très compétent tbarklah 3lik':'كفء بزاف، تبارك الله عليك',
    'tbarkllah 3likom hadchi zwin':'تبارك الله عليكم، هاد الشي زوين',
    'Tbarkllah dakchi 3ndhom zwin':'تبارك الله، هاد الشي عندهم زوين',
    'Tbarkalah bonne contuniation':'تبارك الله، استمرو هكذا',
    'Bon service Lah y3mer lih dar':'خدمة مزيانة، الله يعمر له الدار',
    'Tbarkelah 3likom.khedma zwina':'تبارك الله عليكم، خدمة زوينة',
    'Tbarklah 3likoom khedma n9iiya':'تبارك الله عليكم، خدمة نقية',
    "Le meilleur plombier d'Agadir !":'أحسن بلومبي فأكادير!',
    'Service  f lmostawa w equipe top':'خدمة فالمستوى والفريق توب',
    'Service f lmostawa w equipe top':'خدمة فالمستوى والفريق توب',
    'Oui c magnifique tbarklah 3likom':'واه، زوين، تبارك الله عليكم',
    '3amal momtaz Bonne courage khoya':'عمل ممتاز، بون كوراج خويا',
    'Exemplaires,  tbark allah 3lihom':'مثاليين، تبارك الله عليهم',
    'Tbaraklah 3likom meilleur service':'تبارك الله عليكم، أحسن خدمة',
    'A7san ta3amoul drari lah i3mrha dar':'أحسن تعامل، الله يعمرها الدار',
    'Très bonne coutures, tbarkellah 3lik':'خياطة مزيانة بزاف، تبارك الله عليك',
    'a7ssan wa7d fhad domaine chapeau lik':'أحسن واحد فهاد الميدان، شابو ليك',
    'Tbarklah 3la Ssi Ismail, bon service':'تبارك الله على سي إسماعيل، خدمة مزيانة',
    'Nice prods ..llah ikemel bi5ir yarebi':'منتجات زوينة، الله يكمل بالخير يا ربي',
    'SUPER service je recommande vivement !!':'خدمة واعرة، ننصح بيها بزاف!!',
    'Ahssen mesbana fi casa lah i 3amrha dar':'أحسن صبانة فالدار البيضاء، الله يعمرها الدار',
    'Ahssen elecrecien f casablanca Mr chakib':'أحسن طريسيان فالدار البيضاء، السيد شاكيب',
    'Tbarkalaah sel3a moujouda HTA tmn mezien':'تبارك الله، البضاعة موجودة وحتى التمن مزيان',
    'tbarkalah ta3amol top dima nt3amal m3akom':'تبارك الله، تعامل توب، ديما نتعاملو معاكم',
    'Tbarkellah w sla 3la nbi , men dekchy rfi3':'تبارك الله وصلى على النبي، هاد الشي رفيع',
    'Merci Ssi Hicham, tbarkallah khdma mt9ouna.':'شكراً سي هشام، تبارك الله، خدمة متقنة',
    'Chokarane 3ala tawsil sari3 ou ta3amol zawine':'شكراً على التوصيل السريع والتعامل الزوين',
    'Bonne équipe et bon service tbarkallah 3likom':'فريق مزيان وخدمة مزيانة، تبارك الله عليكم',
    'Lah yi3tik saha professional':'الله يعطيك الصحة، محترف',
    'Khdma nqia lay 3tik saha':'خدمة نقية، الله يعطيك الصحة',
    'Ahsan me3alem haliyan mo3amala tooop':'أحسن معلم دابا، المعاملة توب',
    'Khedma mt9ona , chokran':'خدمة متقنة، شكراً',
    'très bon rapport qualité prix':'التمن مناسب مع الجودة',
    'Super service, installation professionnelle. Je recommande':'خدمة واعرة، تركيب محترف، ننصح بيه',
    'Top du top sérieuse et pro tbarkellah 3liha allah yahfadha':'توب ديال توب، جدية ومحترفة، تبارك الله عليها الله يحفظها',
    'Wlh hta ahssen service o ahssen mo3amala + taman kiyassro bzf merci beaucoup':'والله أحسن خدمة وأحسن تعامل والتمن مناسب بزاف، شكراً بزاف',
    'Slm alikom tbrklah ala had nas lahi amrha dar kikhadmo khadma mzyna lahi jazihom bikhir':'السلام عليكم، تبارك الله على هاد الناس، الله يعمرها الدار، كيخدمو خدمة مزيانة، الله يجازيهم بالخير',
    'Tbarkellah ala khoya Brahim. Top! Conseil et expertise!':'تبارك الله على خويا براهيم، توب! نصيحة وخبرة!',
    'T9dit mn 3and decorat tbaklah 3andhom les meroirs ghzalin':'شريت من عند الديكور، تبارك الله عليهم، المرايا غزالين',
    'Tebarekelah 3ela madame bouchra et son équipe, sincèrement tekchitat diyala fel mostawa.bravo':'تبارك الله على مادام بوشرى وفريقها، بصراحة تكشيطاتها فالمستوى، برافو',
    'Saraha tmanit had lmahal ykoune fchi houma zwina tbarklah khadma n9ya bazaf service professionnel rabi y3wnkom':'بصراحة تمنيت لهاد المحل يكون فشي حومة زوينة، تبارك الله، خدمة نقية بزاف، خدمة محترفة، ربي يعاونكم',
    '3jbatni sel3a dialhom saraha endhom la qualité zwina ou hta nass li khdamin lah i3mrha dar maykhssouch lik lkhater':'عجبتني البضاعة ديالهم، بصراحة عندهم الجودة زوينة وحتى الناس اللي خدامين الله يعمرها الدار ما يخصوكش الخاطر',
    'Kalimat ha9 f khdma dyal Had syda khytat lbnti jlaba omachae alah 3la lkhdma dyalha mt9ona.lah ijazik bikhir omniyat caftan\nJe suis hyper satisfaite merci bcp !':'كلمة حق فخدمة هاد السيدة، خياطة البنتي جلابة وماشاء الله على الخدمة ديالها المتقنة، الله يجازيك بالخير. أنا راضية بزاف، شكراً بزاف!',
    'Chokarane 3ala tawsil sari3 ou ta3amol zawine':'شكراً على التوصيل السريع والتعامل الزوين',
    'Ahassen mesbana fi casa lah i 3amrha dar':'أحسن صبانة فكازا، الله يعمرها الدار',
    'Très bonne qualité btawdi9 inchaellah ma chérie rzala ta t7am9i tbarkelah 3lik':'جودة عالية بالتوفيق، تبارك الله عليك',
    'Allah ya3tik sa7a rak m3alam nadi llah yasar lik omorak MRC pour service plombier':'الله يعطيك الصحة، أنت معلم نادي، الله ييسر ليك أمورك، شكراً على خدمة البلومبي',
  };

  // ── Reviews to delete (fake/test/abusive/not-a-review) ──
  function shouldDeleteReview(r) {
    const txt  = (r.text  || '').trim();
    const name = (r.reviewer_name || '').trim();
    // XSS / HTML in reviewer name or text (raw tags OR HTML-encoded entities)
    if (/<[^>]+>/.test(name) || /<[^>]+>/.test(txt)) return true;
    if (name.includes('&lt;') || txt.includes('&lt;')) return true;
    // Fake dev test reviews
    if (/^test\s*(review)?\s*(number)?\s*\d*$/i.test(txt)) return true;
    // Just names or addresses
    if (/^(Zizo|zizo|EDAHIR|Mhamed|C yousra|Sidi Othmane|Dcheira|Tamazirt|Tanger|Mouhmadia|Mostafa agmad)/.test(txt)) return true;
    if (/^Dar \d+/i.test(txt)) return true; // address
    if (/^Zizo,|^Zizo azdin/i.test(txt)) return true; // just names
    // Abusive / insult
    if (/rba3a dyal lklab|Rba3a dyal lklab/i.test(txt)) return true;
    // Spam username
    if (/^BPROGRAMMERS\d+$/i.test(txt)) return true;
    // Emoji-only (< 6 chars, all non-Latin non-Arabic)
    if (txt.length < 6 && /^[\p{Emoji}\s]+$/u.test(txt)) return true;
    // "Kol avis b account" = meta-spam
    if (/^kol avis b account/i.test(txt)) return true;
    return false;
  }

  // Names of non-trade businesses to delete entirely
  const DELETE_WORKER_NAMES = ['كن لايف كولكشن'];

  // ── Process all workers ──
  const all = await col.find({}).toArray();
  const ops = [];
  let secondaryAdded=0, reviewsCleaned=0, reviewsTranslated=0,
      reviewsRemoved=0, workersToDelete=0;

  for (const w of all) {
    // Delete non-trade businesses
    if (DELETE_WORKER_NAMES.some(n => (w.name||'').includes(n))) {
      ops.push({ deleteOne: { filter: { _id: w._id } } });
      workersToDelete++;
      continue;
    }

    const $set = {};

    // ── 1. Secondary categories ──
    if (VALID_CATS.has(w.category) && !(w.secondary_categories && w.secondary_categories.length)) {
      const detected = detectCats(w);
      detected.delete(w.category);
      if (detected.size > 0) {
        $set.secondary_categories = [...detected];
        secondaryAdded++;
      }
    }

    // ── 2. Clean and translate reviews ──
    if (Array.isArray(w.reviews) && w.reviews.length) {
      let changed = false;
      const cleaned = [];
      for (const r of w.reviews) {
        if (shouldDeleteReview(r)) { reviewsRemoved++; changed = true; continue; }
        const txt = (r.text || '').trim();
        const translated = DARIJA_MAP[txt];
        if (translated) {
          cleaned.push({ ...r, text: translated });
          reviewsTranslated++;
          changed = true;
        } else {
          cleaned.push(r);
        }
      }
      if (changed) {
        $set.reviews = cleaned;
        // Recalculate rating if reviews were removed
        const validStars = cleaned.filter(r => r.stars >= 1 && r.stars <= 5);
        if (validStars.length > 0) {
          const avg = validStars.reduce((s, r) => s + r.stars, 0) / validStars.length;
          $set.rating       = Math.round(avg * 10) / 10;
          $set.rating_count = validStars.length;
        } else if (cleaned.length === 0) {
          $set.rating       = 0;
          $set.rating_count = 0;
        }
        reviewsCleaned++;
      }
    }

    if (Object.keys($set).length) ops.push({ updateOne: { filter: { _id: w._id }, update: { $set } } });
  }

  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  res.json({
    ok: true, total: all.length, ops: ops.length,
    secondaryAdded, reviewsCleaned, reviewsRemoved, reviewsTranslated, workersToDelete
  });
});

// ─── ADMIN: CATEGORY-SPECIFIC CLEANUP (by IDs) ───────────────────────────────
app.post('/api/admin/fix-category', requireAdmin, async (req, res) => {
  await connectDB();
  if (!db) return res.status(503).json({ error: 'MongoDB not connected' });
  const col = db.collection('workers');
  const { ObjectId } = require('mongodb');

  const { deleteIds = [], reclassify = [] } = req.body;
  // reclassify: [{ id, category, description }]

  const ops = [];
  for (const id of deleteIds) {
    try { ops.push({ deleteOne: { filter: { _id: new ObjectId(id) } } }); } catch {}
  }
  for (const { id, category, description } of reclassify) {
    const $set = { category };
    if (description) $set.description = description;
    try { ops.push({ updateOne: { filter: { _id: new ObjectId(id) }, update: { $set } } }); } catch {}
  }

  const result = ops.length ? await col.bulkWrite(ops, { ordered: false }) : {};
  res.json({ ok: true, ops: ops.length, deleted: deleteIds.length, reclassified: reclassify.length, result });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔨 جاك.ما running at http://localhost:${PORT}`);
  if (!MONGODB_URI) console.log('⚠️  No MONGODB_URI set');
  else connectDB(); // warm up connection on start
});
