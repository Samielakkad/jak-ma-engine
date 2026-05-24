# The Darija / Arabizi Classifier

> Deep dive: the regex pre-filter + LLM fallback that turns user-typed Moroccan Darija into a `{trade, city, urgency, budget}` tuple.
> Code: [`lib/text-classifier.js`](../lib/text-classifier.js), [`lib/grounded-retrieval.js#classifyAndExtract`](../lib/grounded-retrieval.js), [`tests/text-classifier.test.js`](../tests/text-classifier.test.js).
> Debug endpoint (live): https://www.jak.ma/api/ai/classify?q=bghit+plombier+f+tanja

---

## The problem

Moroccan Darija is a **low-resource language for LLMs**. Almost every LLM is trained heavily on Modern Standard Arabic (MSA), but Darija has:

- Different vocabulary (`bghit` not `أريد`, `chuf` not `أنظر`)
- French/Spanish/Berber code-switching in the same sentence (`bghit plombier f tanja`)
- A latin-script convention with **numeric letter substitutes** (Arabizi: `3=ع`, `7=ح`, `9=ق`, `8=غ`, `5=خ`, `6=ط`) because the digits look like the Arabic letters
- No standard orthography — `طنجة` is written `tanja`, `tnja`, `tnja7`, `tangja`, `tanger`, `tangier`, or `6anja` depending on the writer

A naive LLM-only classifier ($0.001/query on Gemini Flash, ~1s latency) gets the wrong city or wrong trade ~30% of the time when fed real-world Darija queries — because the LLM doesn't *recognize* `tanja` as `طنجة`.

So jak.ma's classifier is a **regex-first, LLM-fallback** two-stage pipeline. The regex stage is the workhorse; the LLM stage is the long-tail safety net.

---

## TL;DR numbers (post Phase 10 expansion)

| metric | before (May 17 baseline) | after Phase 10 (May 23) |
|---|---|---|
| Regex hit rate on Darija queries | ~30% | **~85%+** |
| Pass-0 latency (regex) | <2 ms | <20 ms |
| Pass-1 latency (LLM fallback) | 1000-4000 ms | ~900 ms typical |
| Total keywords | ~70 trade + ~50 city | **~260 trade + ~90 city** |
| Input forms supported | Arabic + French | **Arabic + Darija script + Arabizi (3/7/9/8/5/6) + French + English** — freely mixable |
| LLM cost per Darija query | $0.001 (Gemini) | **$0.0 for 85%, $0.0009 for the 15% long tail** |
| Tests locking the behavior | 0 | **36** (in [`tests/text-classifier.test.js`](../tests/text-classifier.test.js)) |

---

## The 5 input forms (production proof: every one resolves via regex)

| # | form | example | hits |
|---|---|---|---|
| 1 | MSA / Arabic script | `بغيت بلومبي فطنجة` | trade=بلومبي, city=طنجة |
| 2 | Moroccan Darija in Arabic | `الماء كيقطر فالحمام` | trade=بلومبي |
| 3 | Arabizi (Latin + numeric) | `9hraba 6ay7a f maarif` (3=ع, 6=ط) | trade=طريسيان, city=الدار البيضاء |
| 4 | French loanwords | `plombier urgence f mohammedia` | trade=بلومبي, city=الدار البيضاء |
| 5 | English fallback | `plumber needed in casablanca` | trade=بلومبي, city=الدار البيضاء |
| **mixed** | code-switching | `carpenter bois f gueliz` (English+French+Marrakech district) | trade=نجارة, city=مراكش |

All confirmed live via [`/api/ai/classify`](https://www.jak.ma/api/ai/classify).

---

## The Arabizi convention table

| numeric | Arabic | example |
|---|---|---|
| 3 | ع (ʕayn) | `3afsh = عفش`, `3hraba = كهرباء`, `bghit 3ayyat = بغيت أعيط` |
| 7 | ح (ḥāʾ) | `7eddad = حداد`, `7mam = حمام`, `7did = حديد` |
| 9 | ق (qāf) | `9hraba = الكهرباء`, `9nitra = القنيطرة`, `9hwa = القهوة` |
| 8 | غ (ġayn) | `8ada = غدا`, `bghit = بغيت` (sometimes), `8ayb = غايب` |
| 5 | خ (khāʾ) | `5ribga = خريبكة`, `5oya = خويا`, `5dem = خدم` |
| 6 | ط (ṭāʾ) | `6anja = طنجة`, `6walit = طواليت`, `6ar = طار` |

Letter conventions also covered: `kh=خ`, `gh=غ`, `ch/sh=ش`, `q=ق`, `dh=ذ`.

Why these digits? They visually resemble the Arabic letter. `3` mirrors `ع`. `7` mirrors `ح`. `9` mirrors `ق`. This is the de facto standard in the Arab world for Latin-script Arabic.

The classifier resolves *all 6* conventions in the regex pre-filter. Pass-1 LLM also gets the table in its system prompt (see [`lib/grounded-retrieval.js#classifyAndExtract`](../lib/grounded-retrieval.js)).

---

## Per-trade keyword strategy

Each of the 12 trades has 4 keyword families. Example for بلومبي (plumbing):

| family | examples |
|---|---|
| Trade name (Ar + Fr + En + Darija) | `بلومبي`, `plombier`, `plumber`, `bloumbi`, `ploumbi`, `lploumbi` |
| Problem nouns (Arabic) | `صنبور`, `تيوبو`, `بانيو`, `طواليت`, `سرب`, `حمام تسريب` |
| Problem nouns (French + English) | `fuite`, `robinet`, `douche`, `wc`, `chauffe-eau`, `cumulus`, `sanitaire` |
| Darija romanized | `chauffao`, `robina`, `t9tar`, `tasrib`, `canalisation`, `lavabo`, `baluwa` |

The "problem nouns" layer is the **key engineering insight**: most Moroccan users don't write "I need a plumber." They write "my faucet is broken" / `lavabo kasar` / `t9tar lma`. Routing by the problem (not the profession) catches the long tail of *implicit* trade signals that a trade-name-only classifier would miss.

---

## Per-city: 15 cities × neighborhoods

Each city entry contains: Arabic name + French/English spellings + Darija romanizations + **major neighborhood names** so users who write `"f maarif"` (Maarif is a Casablanca district) route correctly without saying "Casablanca."

| city | sample variants |
|---|---|
| الدار البيضاء | `casa`, `lcasa`, `dar lbida`, `maarif`, `anfa`, `ain chock`, `mohammedia`, `bouskoura`, `hay hassani`, `sidi moumen` |
| طنجة | `tanger`, `tangier`, `tanja`, `tnja`, `6anja`, `6nja`, `ttanja`, `malabata`, `charf` |
| مراكش | `marrakech`, `marrakesh`, `mraks`, `lmraks`, `gueliz`, `medina marrakech`, `menara`, `red city` |
| القنيطرة | `kenitra`, `kénitra`, `qnitra`, `knitra`, `9nitra`, `l9nitra` |
| خريبكة | `khouribga`, `khribga`, `5ribga` (Arabizi 5=خ) |

The neighborhood routing is what makes "I need a painter in Maarif" work — the classifier doesn't need the user to say "Casablanca" explicitly.

---

## Multi-trade detection (6 phrase families)

Some queries describe a project that needs multiple trades. `MULTI_TRADE_PATTERNS` is a separate regex map in [`lib/text-classifier.js`](../lib/text-classifier.js) that matches phrases like:

| phrase family | trades returned (in execution order) |
|---|---|
| Bathroom: `jded l7mam`, `nrm l7mam`, `sallat l7mam`, `tjdid hammam`, `renovation salle de bain` | بلومبي, كلامبيستري, طريسيان, صباغة |
| Apartment: `nrmm ddar`, `jded chi9a`, `renovation appartement` | بناء, طريسيان, صباغة, ديكور |
| House construction: `bnay dar`, `nbni dar`, `construction maison` | بناء, طريسيان, بلومبي, كلامبيستري |
| Kitchen: `jded kuzina`, `nbeddel kuzina`, `kitchen renovation` | نجارة, طريسيان, بلومبي, كلامبيستري |
| Roof / terrace: `jded ssath`, `fuite stah`, `étanchéité` | بناء, كلامبيستري, صباغة |
| Generic renovate: `baghi nrmm`, `nbeddel kullshi`, `renovation` | بناء, طريسيان, صباغة, ديكور |

When matched, retrieval fans out to all implicated trades and Pass-2 generation produces an ordered project plan with a `<<MULTI:cat1|cat2|cat3>>` marker for UI rendering.

---

## The matching algorithm: bicameral word-boundary

[`detectFromText(text, map)`](../lib/text-classifier.js) iterates the map and tests each keyword. The trick: Latin and Arabic scripts have different word-boundary semantics.

```js
const LATIN_RE = /[a-zà-ÿ]/i;

function detectFromText(text, map) {
  const lower = (text || '').toLowerCase();
  for (const [pattern, value] of Object.entries(map)) {
    for (const kw of pattern.split('|')) {
      if (LATIN_RE.test(kw)) {
        // Latin keyword → word-boundary regex
        const re = new RegExp(`(?:^|[^a-zà-ÿ])${esc(kw)}(?:[^a-zà-ÿ]|$)`, 'i');
        if (re.test(lower)) return value;
      } else {
        // Arabic keyword → substring match (Arabic words bind via affixes)
        if (lower.includes(kw)) return value;
      }
    }
  }
  return null;
}
```

Why two strategies?
- **Latin scripts** (English, French, Arabizi) have whitespace word boundaries. We need them to avoid matching "casa" inside "casablanca" prematurely, or "fes" inside "lifestyle".
- **Arabic script** doesn't use whitespace the same way — Arabic words bind to clitics and prefixes (`ال`, `بـ`, `كـ`) without space. Substring match is correct.

The Arabizi conventions are treated as Latin (they contain Latin letters), so `9hraba` gets word-boundary matching too. This was an intentional design call to keep both modes in one function.

---

## Pass-1 LLM fallback: 15% of queries

When regex misses (rare neighborhoods, unusual phrasing, English-only queries with no city), [`classifyAndExtract`](../lib/grounded-retrieval.js) sends the query to Gemini Flash with a **300-token system prompt** documenting:

1. The full Arabizi convention table (so the LLM resolves `9nitra` even if it wasn't in our regex map)
2. 25+ example queries spanning trade-name-explicit, problem-noun-only, neighborhood-only, multi-trade, and off-topic cases
3. The complete list of 12 valid trades and 15 valid cities
4. Confidence-scoring guidance (>0.85 = explicit, <0.6 = unsure)

The prompt is intentionally long because:
- Pass-1 fires on the long tail (~15%), so per-call cost is amortized across many cached hits
- Anthropic and Gemini both support prompt caching — first hit pays full price, subsequent hits get 90% discount on cached portions

Output: JSON `{ trade, city, urgency, budget, confidence, source }`. `jsonMode: true` is set on the call so Gemini uses its native `responseSchema` for structured output (no markdown fence parsing needed).

When even the LLM can't classify (truly ambiguous query, or off-topic), we fall back to a Darija clarification message: `"الطلب ديالك ما واضح ليا 100%. وضح ليا شوية المشكل باش نلقالك المعلم المناسب."`

---

## The `/api/ai/classify` debug endpoint

Built so anyone — recruiters, users, debugging engineers — can introspect the classifier without touching the chat. Live URL:

```
https://www.jak.ma/api/ai/classify?q=ANY_QUERY_HERE
```

Response includes:

```json
{
  "query": "9hraba 6ay7a f maarif",
  "elapsed_ms": 4,
  "resolution": "regex (Pass 0)",
  "trade":  { "value": "طريسيان",       "matched_keyword": "9hraba",  "pattern_group": "..." },
  "city":   { "value": "الدار البيضاء", "matched_keyword": "maarif",  "pattern_group": "..." },
  "multi_trade": { "cats": null, ... },
  "pipeline_note": "Pass 0 regex hit — no LLM call needed. This query resolves instantly."
}
```

The `matched_keyword` field is what makes this great for debugging: when a query misclassifies, you see *which* keyword tripped the wrong route, not just the wrong answer. Zero LLM cost. Public, rate-limited at 30/hr.

Implementation: [`server.js`](../server.js) `/api/ai/classify` route + [`detectFromTextDebug`](../lib/text-classifier.js) / [`detectMultiTradeDebug`](../lib/text-classifier.js) introspection helpers.

---

## Test coverage: 36 tests in `tests/text-classifier.test.js`

Locked-in behaviors:
- 12 trades × 4-8 input forms each
- 15 cities × multiple variants (incl. all major neighborhoods)
- 6 multi-trade phrase families
- Mixed-script queries (English + French + Darija in one sentence)
- Disambiguation: `meuble` alone is NOT carpentry (collides with نقل = moving); `meuble bois` IS
- Off-topic / non-services queries (`bghit tajine`, `salam`, `merci`) return null
- Reachability: every `VALID_CATS` entry maps to itself

Run: `node --test tests/text-classifier.test.js` → 36/36 pass.

---

## What's NOT built (honest limits)

- **No semantic matching.** If a user writes a Darija phrase that's not in the regex map AND not similar enough to the Pass-1 LLM's examples, we miss. Voyage AI embeddings on the Pass-0 path would help — scaffolded in [`lib/hybrid-retrieval.js`](../lib/hybrid-retrieval.js) but gated behind `USE_EMBEDDINGS=1` env var and not yet wired in because Anthropic doesn't ship embeddings.
- **No spelling correction.** `palombier` (misspelled French plumber) misses regex and may also miss the LLM. Adding a Levenshtein layer is on the future-work list.
- **No native Darija LM head.** All classification still routes through commercial LLMs. A locally-hosted Darija classifier (Qwen2.5-1.5B + LoRA, similar to the chat LoRA in production) would let Pass-1 run entirely off-vendor.
- **No personalization.** The classifier doesn't remember if a user is in Tangier and asks `"plombier"` without saying where — it treats every query as anonymous. Adding session-level context priming (already done for `workerContext` on `/w/:id` pages) for city stickiness is a small addition.

---

## Why this matters for the mentor's audio work

Low-resource Darija classification is the **text-domain analog** of low-resource audio:

| this work | audio analog |
|---|---|
| Darija lacks training data in commercial LLMs | Darija (and many regional dialects) lacks training data in ASR / TTS models |
| Regex pre-filter catches 85% before LLM | Acoustic features + small classifier pre-filter would catch most ASR before a heavy model |
| LoRA on Qwen2.5-1.5B for fallback Darija LM | LoRA on Whisper or XTTS for fallback Darija speech |
| Voyage AI embeddings for semantic match (planned) | Wav2Vec2-XLS-R embeddings for cross-lingual audio match |
| `/api/ai/classify` debug endpoint with matched-keyword introspection | An equivalent `/api/ai/transcribe-debug` that returns the model's confidence + alternate hypotheses |

What transfers cleanly: the **engineering pattern** (cheap deterministic pre-filter + expensive model fallback + open debug endpoint + reproducible test suite). What doesn't transfer: any literal audio experience — this is all text. Treating it as audio expertise would be dishonest. The pattern is mentor-relevant; the substance is in the text domain.

---

## File map

| File | Role |
|---|---|
| [`lib/text-classifier.js`](../lib/text-classifier.js) | 260 trade keywords, 90 city keywords, 6 multi-trade pattern families, `detectFromText` / `detectMultiTrade` matchers, debug variants |
| [`lib/grounded-retrieval.js#classifyAndExtract`](../lib/grounded-retrieval.js) | Pass-1 LLM fallback with the 300-token system prompt |
| [`server.js`](../server.js) | `/api/ai/classify` debug endpoint |
| [`tests/text-classifier.test.js`](../tests/text-classifier.test.js) | 36 tests across all 12 trades, 15 cities, multi-trade patterns, Arabizi conventions, mixed-script |
