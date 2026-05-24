/**
 * text-classifier.js — fast deterministic regex-based trade + city detection.
 *
 * This is the first-pass classifier used by both the legacy /api/ai/chat handler
 * (server.js:1328) and the new grounded retrieval pipeline (lib/grounded-retrieval.js).
 * When it returns a confident hit, we skip the Grok-3-mini Pass-1 LLM call entirely —
 * saves ~1s p50 latency + Grok API cost on the >70% of queries that match a keyword.
 *
 * Originally inlined in server.js:373-479; extracted here so both code paths share
 * one source of truth. Modifying keyword maps in this file updates both paths atomically.
 *
 * Integration point: imported by server.js for the legacy chat handler and by
 * lib/grounded-retrieval.js for the Pass-1 regex pre-filter.
 *
 * Languages supported:
 *   - Arabic Darija (Moroccan, with affixed bound words → substring match)
 *   - Latin Darija transliteration (Arabizi → word-bounded match)
 *   - French (with accented characters → word-bounded match)
 *   - English (where naturally used by Moroccan tech-fluent users)
 */

// ── Trade keyword map ───────────────────────────────────────────────────────
// Each entry: 'pipe|separated|keywords' → 'Arabic trade category'.
// Order matters where keywords overlap: more specific phrases must precede
// generic ones (e.g. "tiyou pvc" → بلومبي must precede generic "pvc" matches).
// KEYWORD_TO_CAT — comprehensive trade keyword map.
// Includes per-trade: Arabic forms · French loanwords · English fallbacks ·
// Darija romanizations (Arabizi: 3=ع, 7=ح, 9=ق, 8=غ, 5=خ, 6=ط) · common
// problem nouns customers actually type (panne, fuite, tasrib, t9tar, etc.).
const KEYWORD_TO_CAT = {
  // ─── بلومبي — plumbing ─────────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'بلومبي|plombier|plumber|plumbery|plumbery service|bloumbi|bloumby|ploumbi|plombi|ploumby|boulomba|boulombi|lbloumbi|lploumbi': 'بلومبي',
  // Problem nouns (water, leaks, pipes, sanitary equipment)
  'سرب|تسريب|صنبور|دوش|بانيو|مرحاض|طواليت|بيبان|تيوبو|مصرف|بالوعة|صفاية|شوفاج الما|سخان الما|ضغط الما|حمام تسريب|حمام صنبور|حمام بيبان|تيوبو pvc|بيب pvc|pvc pipe|tube pvc|conduite pvc|سرب pvc|fuite|fuites|plomb|plomberie|robinet|robina|robini|douche|douchage|baignoire|baignor|wc|toilette|toilettes|6walit|6awalit|tuyau|tioyo|tioyou|evacuation|évacuation|siphon|chauffe.eau|chauffao|chauffaou|cumulus|vanne|chasse|chasse d.eau|pompe|sanitaire|sanitaria|sanitair|tasrib|tsrib|tasrieb|t9tir|t9tar|t9tiir|t9ter|lavabo|lavabou|lavabou kasi|baluwa|lblouwa|bibane|lbibane|canalisation|bouchage|bouché|bouche d.eau|chouffe.eau|évier|evier|fos septique|fosse septique': 'بلومبي',

  // ─── طريسيان — electrician ─────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'طريسيان|تريسيان|trissyan|trisyan|trissian|trisian|trissien|trisien|triisien|electrician|electricien|électricien|kahrabaji|kahrabji|kahrba|kahraba|9hraba|9hrba|3hraba|3hrba|ttrissyan': 'طريسيان',
  // Problem nouns (electricity, wiring, lighting)
  'كهرب|تيار|ضو|نور|فيشة|بريزة|قاطع|ديسجونكتور|تابلو كهربائي|سلك|كابلاج|كورتسيرة|لمبة|بلافوني|إنارة|جرس|إنتيرفون|كليماتيزور|electricite|électricité|courant|prise|prises|disjoncteur|disjoncteurs|câblage|cablage|court.circuit|court circuit|short circuit|shortcircuit|short.circuit|ampoule|ampoules|luminaire|interphone|sonnette|climatiseur|clim|airzone|panne|panne courant|panne kahrba|panne 3hraba|panne électrique|compteur|lcompteur|lkompteur|le compteur|branchement|raccordement|recharge|led|lampe led|voltage|voltmetre|mise terre|mise à terre|panneau électrique|panneau electrique|ddaw|ddow|daww|tableau électrique|tableau electrique': 'طريسيان',

  // ─── صباغة — painter ───────────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'صباغة|صباغ|peintre|painter|sba8|sba8a|sbagh|sbagha|sebgha|sebgh|sbghi|sba6|lsba8|lsba8a|ssba8a|sba8at|psbgha|sbaghi': 'صباغة',
  // Problem nouns (painting, finishes, walls)
  'طلاء|دهان|رنكة|تصبيغ|حيط مقشور|طلاء طايح|بقعة|sous.couche|sous couche|peinture|peintures|peint|enduit|crépi|crepi|ravalement|façade|facade|mur sba8|plafond sba8|decorer|décorer|décorer murs|finition|mat|brillant|satin|painting|paint job|peindre|repeindre|wallpaint|wall paint': 'صباغة',

  // ─── نجارة — carpentry ─────────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'نجارة|نجار|menuisier|carpenter|carpentry|najjar|najar|nejjar|n9jar|nijara|nejara|lnjjar|lnejjar|lnijara|nnejjar|nnajjar|lnijjar': 'نجارة',
  // Problem nouns (wood, doors, windows, furniture)
  // "meuble" alone removed (ambiguous: could mean furniture-making OR moving
  // furniture — collides with نقل). Use "meuble bois" / "meubles bois" instead.
  'خشب|باب الخشب|شباك خشب|شبابيك خشب|شباك بلانش|خزانة|دولاب|باركي|بلانش|كيتشن|مطبخ خشب|menuiserie|bois|parquet|placard|placards|armoire|armoires|porte bois|cuisine bois|fenetre bois|fenêtre bois|khachab|khshb|khachb|lkhachab|meuble bois|meubles bois|meuble en bois|chiba|chibat|chibate|bureau bois|table bois|chaise bois|escalier bois|escalier en bois|cabinet bois|assemblage|menuiserie alu|placard mural': 'نجارة',

  // ─── بناء — masonry / construction ────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'بناء|maçon|macon|builder|mason|masonry|btp|construction|gros oeuvre|gros œuvre|bnay|bnayyi|lbinaa|binaa|moqawel|mou9awel|m9awel|lbnyya|llbnyya|bbennay|bna2|nbni|nbniw|building': 'بناء',
  // Problem nouns (cement, cracks, demolition, foundations)
  'جدار|سيمان|تشقق|ترميم|هدم|خرسانة|فيسور|بلوك|إيتانشيتي السطح|chape|béton|beton|fissure|fissures|trmim|ttrmim|hadm|lhadm|briques|brique|brick|mortier|mortar|sable|gravier|coffrage|fondation|fondations|linteau|poutre|poutres|coulage|coulage béton|lakwadi|lakwadi dial dar|chantier|chantier btp|gros œuvre|gros oeuvre': 'بناء',

  // ─── نقاوة — cleaning ──────────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  // Note: word-bounded forms (handled by detectFromText) keep déménagement out.
  'نقاوة|تنظيف|نضافة|cleaner|cleaning|cleaning service|maid|housekeeper|ndafa|nadafa|n9aoua|n9awa|tn9iya|tan9iya|ndaffa|ndafetlik|lndafa|nnedafa|gharad|gharrad|ghaslan|ghaslane': 'نقاوة',
  // Problem nouns (clean, sanitize, surfaces)
  'كنس|مسح|تعقيم|زرابي|كنبة|فوطة|فيترين|femme de menage|femme de ménage|ménage|menage|ménagère|nettoyage|desinfection|désinfection|lavage|nettoy|vitres|vitrerie|moquette|matelas|tapis|spring cleaning|post.chantier|post chantier|nettoyage post|jardinier': 'نقاوة',

  // ─── حدادة — metalwork ─────────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized including Arabizi 7=ح)
  'حدادة|حديد|حداد|ferronnier|forgeron|blacksmith|ironworker|ironwork|hddad|haddad|lhdid|hdid|sodor|soudour|soudeur|sodure|7ddad|7eddad|l7ddad|l7eddad|7dada|l7dada|7did|l7did|l7ddada|llhdid': 'حدادة',
  // Problem nouns (gates, grilles, metal windows, security bars)
  'سودور|بوابة|سياج|درابزين|باب حديد|شباك حديد|شبابيك حديد|شبابيك ألومنيوم|شباك ألومنيوم|ألومنيوم|aluminium|alu|ferronnerie|soudeur|soudure|portail|grille|grilles|clôture|cloture|garde.corps|gardes corps|serrure|serrurier|serrurerie|inox|fer forgé|fer forge|métallique|metallique|construction métallique|moustiquaire|volet roulant|volets roulants|volet roulants': 'حدادة',

  // ─── ديكور — decor / interior design ───────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  // Note: bare تابلو removed (was electrical panel collision). décor/design ok.
  'ديكور|décorateur|decorateur|decorator|interior design|interior designer|design intérieur|ldikor|ddikor|dikor|dekor|ddekor|tassmim|tassmim dakhili|décoration': 'ديكور',
  // Problem nouns (gypsum, false ceilings, wallpaper, design touches)
  'فوس بلافون|جبس|تصميم داخلي|ورق الحيطان|تزيين|ستارة|تابلو ديكور|tableau decoration|décor|decor|decoration|faux plafond|platre|plâtre|papier peint|design|aménagement|amenagement|gibs|jibs|jbes|moulure|moulures|placoplatre|placo|staging|home staging': 'ديكور',

  // ─── نقل — moving / transport ──────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'نقل|déménageur|demenageur|mover|moving|moving service|movers|n9el|na9l|nakl|tahwila|tahwil|kamyou|cami|lkamyou|naqala|tnaqil|7awala': 'نقل',
  // Problem nouns (truck, packing, delivery, household goods)
  'تحويل|عفش|شاحنة|تاشيرة|déménagement|demenagement|déménag|demenag|transport|camion|déménager|livraison|pickup|truck|emballage|bagages|meubles transport|débarras|debarras|porteur': 'نقل',

  // ─── كلامبيستري — tiling / waterproofing ───────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'كلامبيستري|carreleur|carrelage|carrel|tiler|tile|tile installer|carro|carru|balat|bala6|blat|tabli6|tablit|zlij|zellij|zlijj|lcarrelage|lblat|llblat': 'كلامبيستري',
  // Problem nouns (mosaic, marble, grout, floors, waterproofing)
  'زليج|بلاط|كارو|تبليط|فايانس|رخام|مربعات|إيتانشيتي|zellige|faïence|faience|marbre|étanchéité|etancheite|pose carrelage|revêtement|revetement|floor|sol|mosaique|mosaïque|mosaic|granite|granito|joint|coulis|pose|granit|décoration sol|carrelage mural': 'كلامبيستري',

  // ─── خياطة — tailoring ─────────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized)
  'خياطة|خياط|couturier|couturière|tailor|seamstress|khayyat|khayyata|khiyata|khiyat|lkhiyata|khyate|5ayyat|5iyata|l5ayyat|lkhayyat|lkhayyata': 'خياطة',
  // Problem nouns (alterations, curtains, traditional outfits)
  'تقصير|تضييق|تكبير|قفطان|جلابة|ستائر|تنجيد|retouche|retouches|rideau|rideaux|tapisserie|alterations|alteration|ourlet|brodeur|broderie|broderies|broderie marocaine|tnjid|caftan|djellaba': 'خياطة',

  // ─── حراسة — security guard ────────────────────────────────────────────────
  // Trade name (Ar + Fr + En + Darija romanized incl. Arabizi 7=ح)
  'حراسة|حارس|gardien|gardiennage|watchman|security guard|haris|hras|hrass|gard|garde|gardiya|l7arass|l7aris|7arass|7arasa|7ras|llharass|alarme|alarm|cctv|videosurveillance|vidéosurveillance|caméra surveillance|camera surveillance': 'حراسة',
  // Problem nouns (alarms, surveillance, doormen)
  'أمن|غاردي|vigile|securite|sécurité|securitech|surveillance|système alarme|système d.alarme|portier|concierge': 'حراسة',
};

// ── City keyword map ────────────────────────────────────────────────────────
// City map. Each entry: Arabic · French · English · Darija romanized · key
// neighborhood names (so "f maarif" or "f gueliz" routes to the right city).
// Order matters for ambiguous matches: short forms ("casa") must precede
// longer ones; detectFromText returns on first hit.
const KEYWORD_TO_CITY = {
  // Casablanca + main districts (Maarif/Anfa/Ain Chock/etc)
  'كازا|كازابلانكا|الدار البيضاء|casa|casablanca|casablanka|lcasa|l casa|l-casa|dar lbida|dar lbeida|ddar lbida|ddar lbeida|lbida|lbeida|maarif|ma3arif|anfa|ain chock|ain chok|ain sebaa|hay hassani|sidi moumen|sidi-moumen|mohammedia|bouskoura': 'الدار البيضاء',
  // Rabat + agdal/hay riyad/hassan
  'الرباط|رباط|rabat|rbat|lrbat|l-rbat|l rbat|agdal|hay riyad|hay-riyad|hassan|capital': 'الرباط',
  // Tangier (طنجة) — most-used romanizations + Arabizi 6=ط
  'طنجة|tanger|tangier|tanja|tanja7|tnja|tnja7|tangja|ttanja|6anja|6nja|t.anger|malabata|charf': 'طنجة',
  // Marrakech + gueliz/medina/menara
  'مراكش|marrakech|marrakesh|marakech|marakch|lmraks|mraks|marrakch|merraksh|mrakch|gueliz|gueliz menara|medina marrakech|menara|red city': 'مراكش',
  // Agadir
  'أكادير|agadir|agadeer|lgadir|gadir|inezgane|aitmelloul|ait melloul|founty|talborjt': 'أكادير',
  // Fes (فاس)
  'فاس|fes|fez|fas|lfas|fess|ffes|fes el bali|fes el jdid|atlas fes': 'فاس',
  // Salé
  'سلا|salé|sale|sla|lsla|sallé|salee|tabriquet': 'سلا',
  // Meknes
  'مكناس|meknes|meknès|lmeknas|mknas|mekness|lmeknassa|meknassa|hamria': 'مكناس',
  // Oujda
  'وجدة|oujda|wajda|wjda|lwajda|ojda|lojda': 'وجدة',
  // Kenitra (using Arabizi 9=ق)
  'القنيطرة|kenitra|kénitra|lqnitra|qnitra|qntra|knitra|9nitra|l9nitra|l kenitra|l-kenitra': 'القنيطرة',
  // Tetouan
  'تطوان|tetouan|tétouan|titwan|tetwan|titwn|ttwan|tetuan|6twan|t6wan': 'تطوان',
  // El Jadida (مازاغان / Mazagan is the old name still used)
  'الجديدة|jadida|el jadida|jdida|ljdida|el-jadida|eljadida|mazagan|lmazagan': 'الجديدة',
  // Beni Mellal
  'بني ملال|beni mellal|bani mellal|bni mlal|beni mlal|bani melal|beni-mellal|bnimellal': 'بني ملال',
  // Khouribga
  'خريبكة|khouribga|khribga|khouribka|5ribga|lkhribga': 'خريبكة',
  // Settat
  'سطات|settat|stat|stat lwsta|seta|sttat': 'سطات',
};

// ── Multi-trade renovation patterns ─────────────────────────────────────────
// When the user is describing a multi-trade project (full bathroom renovation,
// kitchen remodel, etc.) we fan out to all the implicated trades and present
// an ordered project plan.
const MULTI_TRADE_PATTERNS = {
  // Bathroom renovation: tile + plumbing + electric + paint
  'تجديد الحمام|جدد الحمام|renovation salle de bain|refaire salle de bain|salle de bain renovation|bathroom renovation|jded l7mam|jded lhammam|tjdid 7mam|tjdid hammam|jded hammam|nbeddel l7mam|nrm l7mam|nrm lhammam|sallat l7mam': ['بلومبي', 'كلامبيستري', 'طريسيان', 'صباغة'],
  // Apartment / house interior renovation
  'تجديد الشقة|جدد الشقة|تجديد البيت|جدد البيت|renovation appartement|refaire appart|apartment renovation|home renovation|jded ddar|jded dar|tjdid ddar|jded chi9a|nrmm ddar|nrm chi9a|nrmem chi9a|reformer maison': ['بناء', 'طريسيان', 'صباغة', 'ديكور'],
  // Building a new house from scratch
  'بناء دار|بناء بيت|construction maison|construire|build house|new house|bnay dar|bni dar|nbni dar|nbniw dar|nbni bayt|construction neuve': ['بناء', 'طريسيان', 'بلومبي', 'كلامبيستري'],
  // Kitchen renovation
  'مطبخ جديد|تجديد المطبخ|nouvelle cuisine|refaire cuisine|kitchen renovation|new kitchen|jded l3wina|jded kuzina|jded cuisine|kuzina jdida|nbeddel kuzina|cuisine americaine': ['نجارة', 'طريسيان', 'بلومبي', 'كلامبيستري'],
  // Roof / terrace / waterproofing
  'تجديد السطح|إيتانشيتي|terrasse|toiture|étanchéité|roof renovation|jded ssath|jded stah|stah|etancheite|nrm ssath|tt7t lma|fuite stah|fuite toiture': ['بناء', 'كلامبيستري', 'صباغة'],
  // Generic "I want to renovate" intent
  'مشروع تجديد|تخطيط مشروع|نجدد|نرمم|renovation|rénover|rénovation|renovating|tjdid|jded|nrmm|reno|renovate|baghi nrmm|baghi njded|nbeddel kullshi': ['بناء', 'طريسيان', 'صباغة', 'ديكور'],
};

const VALID_CATS = ['بلومبي', 'طريسيان', 'صباغة', 'نجارة', 'بناء', 'نقاوة', 'حدادة', 'ديكور', 'نقل', 'كلامبيستري', 'خياطة', 'حراسة'];

// ── Detection function ──────────────────────────────────────────────────────
// Latin script letters (incl. accented): word-boundary match. Arabic: substring
// is fine (Arabic words bind tightly via affixes, not whitespace, so
// word-boundary regex misfires).
const LATIN_RE = /[a-zà-ÿ]/i;

function detectFromText(text, map) {
  const lower = (text || '').toLowerCase();
  for (const [pattern, value] of Object.entries(map)) {
    const kws = pattern.split('|');
    for (const kw of kws) {
      if (LATIN_RE.test(kw)) {
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

// Introspection variant of detectFromText: returns {value, keyword} when a
// match is found, or {value: null, keyword: null} otherwise. Used by the
// /api/ai/classify debug endpoint so we can show which keyword matched.
function detectFromTextDebug(text, map) {
  const lower = (text || '').toLowerCase();
  for (const [pattern, value] of Object.entries(map)) {
    const kws = pattern.split('|');
    for (const kw of kws) {
      if (LATIN_RE.test(kw)) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?:^|[^a-zà-ÿ])${escaped}(?:[^a-zà-ÿ]|$)`, 'i');
        if (re.test(lower)) return { value, keyword: kw, pattern_group: pattern };
      } else {
        if (lower.includes(kw)) return { value, keyword: kw, pattern_group: pattern };
      }
    }
  }
  return { value: null, keyword: null, pattern_group: null };
}

// Detect a multi-trade project intent. Returns an array of category names in
// recommended execution order, or null.
function detectMultiTrade(text) {
  const lower = (text || '').toLowerCase();
  for (const [pattern, cats] of Object.entries(MULTI_TRADE_PATTERNS)) {
    if (new RegExp(pattern, 'i').test(lower)) return cats;
  }
  return null;
}

// Introspection variant of detectMultiTrade for the debug endpoint.
function detectMultiTradeDebug(text) {
  const lower = (text || '').toLowerCase();
  for (const [pattern, cats] of Object.entries(MULTI_TRADE_PATTERNS)) {
    const re = new RegExp(pattern, 'i');
    const m = re.exec(lower);
    if (m) return { cats, pattern, matched_phrase: m[0] };
  }
  return { cats: null, pattern: null, matched_phrase: null };
}

module.exports = {
  KEYWORD_TO_CAT,
  KEYWORD_TO_CITY,
  MULTI_TRADE_PATTERNS,
  VALID_CATS,
  detectFromTextDebug,
  detectMultiTradeDebug,
  detectFromText,
  detectMultiTrade,
};
