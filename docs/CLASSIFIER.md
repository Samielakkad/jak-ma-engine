# The Darija / Arabizi Classifier

Code: [`lib/text-classifier.js`](../lib/text-classifier.js), [`lib/grounded-retrieval.js#classifyAndExtract`](../lib/grounded-retrieval.js), [`tests/text-classifier.test.js`](../tests/text-classifier.test.js).
Debug endpoint (live): https://www.jak.ma/api/ai/classify?q=bghit+plombier+f+tanja

## The problem

Moroccan Darija is a low-resource language for LLMs. Most models train heavily on Modern Standard Arabic (MSA), but Darija differs in vocabulary, mixes French / Spanish / Berber, and is commonly written in Latin script using numeric letter substitutes (Arabizi: `3=ع`, `7=ح`, `9=ق`, `8=غ`, `5=خ`, `6=ط`). There is no canonical orthography: طنجة appears as `tanja`, `tnja`, `tnja7`, `tangja`, `tanger`, `tangier`, or `6anja` depending on the writer.

A pure LLM classifier (Gemini Flash, ~$0.001/query, ~1s latency) misclassifies roughly 30% of real Moroccan queries because the model does not recognize `tanja` as طنجة or `9hraba` as كهرباء.

jak.ma's classifier is a two-stage pipeline: a regex pre-filter handles the common cases, and a Gemini Flash JSON call handles the long tail.

## Numbers (after the Phase 10 expansion)

| Metric | Before (baseline) | After (Phase 10) |
|---|---|---|
| Regex hit rate on Darija queries | ~30% | ~85% |
| Pass 0 latency (regex) | <2 ms | <20 ms |
| Pass 1 latency (LLM fallback) | 1000–4000 ms | ~900 ms |
| Total keywords | ~70 trade + ~50 city | ~260 trade + ~90 city |
| Input forms | Arabic + French | Arabic, Darija (script), Arabizi (3/7/9/8/5/6), French, English — freely mixable |
| LLM cost per Darija query | $0.001 (Gemini) | $0 for 85%, $0.0009 for the 15% long tail |
| Regression tests | 0 | 36 ([`tests/text-classifier.test.js`](../tests/text-classifier.test.js)) |

## Five input forms

All five can mix freely in a single query.

| # | Form | Example | Resolves to |
|---|---|---|---|
| 1 | MSA / Arabic script | `بغيت بلومبي فطنجة` | trade=بلومبي, city=طنجة |
| 2 | Moroccan Darija (Arabic) | `الماء كيقطر فالحمام` | trade=بلومبي |
| 3 | Arabizi (Latin + numbers) | `9hraba 6ay7a f maarif` | trade=طريسيان, city=الدار البيضاء |
| 4 | French loanwords | `plombier urgence f mohammedia` | trade=بلومبي, city=الدار البيضاء |
| 5 | English | `plumber needed in casablanca` | trade=بلومبي, city=الدار البيضاء |
| Mixed | code-switching | `carpenter bois f gueliz` | trade=نجارة, city=مراكش |

All verifiable live at [`/api/ai/classify`](https://www.jak.ma/api/ai/classify).

## Arabizi conventions

| Numeric | Arabic letter | Examples |
|---|---|---|
| 3 | ع (ʕayn) | `3afsh = عفش`, `3hraba = عهربا`, `3ayyat = أعيط` |
| 7 | ح (ḥāʾ) | `7eddad = حداد`, `7mam = حمام`, `7did = حديد` |
| 9 | ق (qāf) | `9hraba = الكهرباء`, `9nitra = القنيطرة` |
| 8 | غ (ġayn) | `8ada = غدا`, `8ayb = غايب` |
| 5 | خ (khāʾ) | `5ribga = خريبكة`, `5oya = خويا`, `5dem = خدم` |
| 6 | ط (ṭāʾ) | `6anja = طنجة`, `6walit = طواليت`, `6ar = طار` |

These digits visually resemble the Arabic letter (`3` mirrors `ع`, `7` mirrors `ح`, `9` mirrors `ق`). They are the de facto standard for Latin-script Arabic across the Arab world. Letter conventions also covered: `kh=خ`, `gh=غ`, `ch/sh=ش`, `q=ق`, `dh=ذ`.

All six conventions resolve in the regex pre-filter. The Pass-1 LLM also receives the table in its system prompt.

## Per-trade keyword strategy

Each of the 12 trades has four keyword families. Example for بلومبي:

| Family | Examples |
|---|---|
| Trade name (Ar / Fr / En / Darija) | `بلومبي`, `plombier`, `plumber`, `bloumbi`, `ploumbi`, `lploumbi` |
| Problem nouns (Arabic) | `صنبور`, `تيوبو`, `بانيو`, `طواليت`, `سرب`, `حمام تسريب` |
| Problem nouns (Fr / En) | `fuite`, `robinet`, `douche`, `wc`, `chauffe-eau`, `cumulus`, `sanitaire` |
| Darija romanized | `chauffao`, `robina`, `t9tar`, `tasrib`, `canalisation`, `lavabo`, `baluwa` |

The problem-noun layer is the key design choice. Most users do not write "I need a plumber." They write "my faucet is broken" / `lavabo kasar` / `t9tar lma`. Routing by the problem instead of the profession catches implicit trade signals that a trade-name-only classifier would miss.

## Per-city: 15 cities and neighborhoods

Each city entry includes the Arabic name, French and English spellings, Darija romanizations, and major neighborhood names. This lets queries like `"f maarif"` route correctly without the user saying "Casablanca."

| City | Variants |
|---|---|
| الدار البيضاء | `casa`, `lcasa`, `dar lbida`, `maarif`, `anfa`, `ain chock`, `mohammedia`, `bouskoura`, `hay hassani`, `sidi moumen` |
| طنجة | `tanger`, `tangier`, `tanja`, `tnja`, `6anja`, `6nja`, `ttanja`, `malabata`, `charf` |
| مراكش | `marrakech`, `marrakesh`, `mraks`, `lmraks`, `gueliz`, `medina marrakech`, `menara`, `red city` |
| القنيطرة | `kenitra`, `kénitra`, `qnitra`, `knitra`, `9nitra`, `l9nitra` |
| خريبكة | `khouribga`, `khribga`, `5ribga` (Arabizi 5=خ) |

## Multi-trade detection

Some queries describe projects that need multiple trades. `MULTI_TRADE_PATTERNS` matches phrases and returns the list of implicated trades in execution order:

| Phrase family | Trades |
|---|---|
| Bathroom: `jded l7mam`, `nrm l7mam`, `sallat l7mam`, `tjdid hammam`, `renovation salle de bain` | بلومبي, كلامبيستري, طريسيان, صباغة |
| Apartment: `nrmm ddar`, `jded chi9a`, `renovation appartement` | بناء, طريسيان, صباغة, ديكور |
| House construction: `bnay dar`, `nbni dar`, `construction maison` | بناء, طريسيان, بلومبي, كلامبيستري |
| Kitchen: `jded kuzina`, `nbeddel kuzina`, `kitchen renovation` | نجارة, طريسيان, بلومبي, كلامبيستري |
| Roof / terrace: `jded ssath`, `fuite stah`, `étanchéité` | بناء, كلامبيستري, صباغة |
| Generic renovate: `baghi nrmm`, `nbeddel kullshi`, `renovation` | بناء, طريسيان, صباغة, ديكور |

On a match, retrieval fans out to all trades and Pass 2 generation produces an ordered project plan with a `<<MULTI:cat1|cat2|cat3>>` marker for UI rendering.

## Matching algorithm

[`detectFromText(text, map)`](../lib/text-classifier.js) iterates the map and tests each keyword. Latin and Arabic scripts use different word-boundary semantics:

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
        // Arabic keyword → substring match
        if (lower.includes(kw)) return value;
      }
    }
  }
  return null;
}
```

Why two strategies:
- Latin scripts (English, French, Arabizi) use whitespace word boundaries. Without them, "casa" would match inside "casablanca" prematurely.
- Arabic script does not use whitespace the same way — Arabic words bind to clitics and prefixes (`ال`, `بـ`, `كـ`) without space. Substring match is correct for Arabic.

Arabizi (Latin letters plus digits) is treated as Latin and gets word-boundary matching.

## Pass-1 LLM fallback

When regex misses (rare neighborhoods, unusual phrasing, English-only queries with no city), [`classifyAndExtract`](../lib/grounded-retrieval.js) sends the query to Gemini Flash with a ~300-token system prompt covering:

1. The full Arabizi convention table
2. 25+ example queries: trade-name-explicit, problem-noun-only, neighborhood-only, multi-trade, off-topic
3. The list of 12 valid trades and 15 valid cities
4. Confidence-scoring guidance (>0.85 means explicit, <0.6 means unsure)

Output is JSON `{ trade, city, urgency, budget, confidence, source }`. `jsonMode: true` uses Gemini's native `responseSchema` so no markdown-fence parsing is needed.

When even the LLM cannot classify, the response is a Darija clarification: `"الطلب ديالك ما واضح ليا 100%. وضح ليا شوية المشكل باش نلقالك المعلم المناسب."`

## `/api/ai/classify` debug endpoint

Available at https://www.jak.ma/api/ai/classify?q=ANY_QUERY_HERE. Returns the matched keyword, the pattern group, any multi-trade match, and timing. Zero LLM cost — only the regex layer.

```json
{
  "query": "9hraba 6ay7a f maarif",
  "elapsed_ms": 4,
  "resolution": "regex (Pass 0)",
  "trade":  { "value": "طريسيان",       "matched_keyword": "9hraba",  "pattern_group": "..." },
  "city":   { "value": "الدار البيضاء", "matched_keyword": "maarif",  "pattern_group": "..." },
  "multi_trade": { "cats": null, ... },
  "pipeline_note": "Pass 0 regex hit — no LLM call needed."
}
```

The `matched_keyword` field is the key operational value. When a query misclassifies, the engineer sees which keyword tripped the wrong route. This is also useful for keyword-coverage gap analysis: query a list of expected-to-work strings, see which return `would_fall_through_to_llm_pass_1`, prioritize regex additions.

Implementation: [`detectFromTextDebug`](../lib/text-classifier.js) and [`detectMultiTradeDebug`](../lib/text-classifier.js) are introspection variants of the matching functions that return `{ value, keyword, pattern_group }` instead of just the matched value.

## Test coverage

[`tests/text-classifier.test.js`](../tests/text-classifier.test.js) has 36 tests locking the regex behavior:

- 12 trades × 4–8 input forms each
- 15 cities × multiple variants (including neighborhoods)
- 6 multi-trade phrase families
- Mixed-script queries (English + French + Arabic in one sentence)
- Disambiguation: `meuble` alone is not carpentry (collides with نقل = moving); `meuble bois` is
- Off-topic queries (`bghit tajine`, `salam`, `merci`) return null
- Reachability: every `VALID_CATS` entry maps to itself

Run: `node --test tests/text-classifier.test.js` — 36/36 pass.

## Limitations and future work

Not built:
- Semantic matching. Queries that miss both regex and LLM examples are not caught. Voyage AI embeddings on the Pass-0 path would help; [`lib/hybrid-retrieval.js`](../lib/hybrid-retrieval.js) is scaffolded but gated behind `USE_EMBEDDINGS=1`.
- Spelling correction. `palombier` (misspelled French plumber) misses both regex and likely the LLM. A Levenshtein layer is on the future-work list.
- Native Darija LM head for classification. All classification still routes through commercial LLMs on the long tail. A locally hosted Darija classifier (Qwen2.5-1.5B + LoRA, similar to the chat LoRA) would let Pass-1 run entirely off-vendor.
- Session personalization. The classifier treats every query as anonymous. `workerContext` (used for `/w/:id` pages) provides city stickiness; a fuller session model is straightforward to add.

## Patterns for audio work

Low-resource Darija classification is the text-domain analog of low-resource audio:

| This work (text) | Audio analog |
|---|---|
| Darija lacks training data in commercial LLMs | Darija and similar dialects lack training data in ASR / TTS models |
| Regex pre-filter catches 85% before LLM | Acoustic features + small classifier would pre-filter most ASR before a heavy model |
| LoRA on Qwen2.5-1.5B for fallback Darija LM | LoRA on Whisper or XTTS for fallback Darija speech |
| Voyage AI embeddings for semantic match (planned) | Wav2Vec2-XLS-R embeddings for cross-lingual audio match |
| `/api/ai/classify` with matched-keyword introspection | An `/api/ai/transcribe-debug` returning ASR confidence + alternate hypotheses |

What transfers: the engineering pattern (deterministic pre-filter, expensive model fallback, public debug endpoint, reproducible test suite). What does not: this implementation is text only. Audio would be new code.

## File map

| File | Role |
|---|---|
| [`lib/text-classifier.js`](../lib/text-classifier.js) | 260 trade keywords, 90 city keywords, 6 multi-trade patterns, `detectFromText`, `detectMultiTrade`, debug variants |
| [`lib/grounded-retrieval.js#classifyAndExtract`](../lib/grounded-retrieval.js) | Pass-1 LLM fallback with the ~300-token system prompt |
| [`server.js`](../server.js) | `/api/ai/classify` debug endpoint |
| [`tests/text-classifier.test.js`](../tests/text-classifier.test.js) | 36 tests |
