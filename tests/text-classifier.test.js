/**
 * tests/text-classifier.test.js
 *
 * Locks the regex pre-filter behavior in place so future expansions don't
 * regress. Covers:
 *   - 12 trades × multiple input forms (Arabic / French / English / Darija
 *     romanized / Arabizi numeric)
 *   - 15 cities + key neighborhoods (Casa: maarif/anfa, Marrakech: gueliz, ...)
 *   - Arabizi conventions: 3=ع, 7=ح, 9=ق, 8=غ, 5=خ, 6=ط
 *   - Multi-trade renovation phrase detection
 *   - Disambiguation edge cases (meuble alone vs meuble bois;
 *     tnaqil meubles → نقل not نجارة)
 *   - Mixed-script queries (English + French + Arabic in one sentence)
 *
 * Run: `node --test tests/text-classifier.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYWORD_TO_CAT,
  KEYWORD_TO_CITY,
  detectFromText,
  detectMultiTrade,
  VALID_CATS,
} = require('../lib/text-classifier');

// ─── Helpers ────────────────────────────────────────────────────────────────

function classify(query) {
  return {
    trade: detectFromText(query, KEYWORD_TO_CAT),
    city: detectFromText(query, KEYWORD_TO_CITY),
    multi_trade: detectMultiTrade(query),
  };
}

// ─── 12 Trades × 4 input forms each ─────────────────────────────────────────

test('بلومبي (plumbing) — Arabic + Fr + En + Darija romanized', () => {
  assert.equal(classify('بغيت بلومبي').trade, 'بلومبي');
  assert.equal(classify('bghit plombier f tanja').trade, 'بلومبي');
  assert.equal(classify('plumber needed').trade, 'بلومبي');
  assert.equal(classify('bloumbi mzyan').trade, 'بلومبي');
  assert.equal(classify('chauffao kharbat').trade, 'بلومبي');
  assert.equal(classify('lavabo kasar').trade, 'بلومبي');
  assert.equal(classify('fuite f hammam').trade, 'بلومبي');
  assert.equal(classify('canalisation mssddoda').trade, 'بلومبي');
});

test('طريسيان (electrician) — incl. Arabizi 9=ق, 3=ع', () => {
  assert.equal(classify('بغيت طريسيان').trade, 'طريسيان');
  assert.equal(classify('électricien urgent').trade, 'طريسيان');
  assert.equal(classify('electrician needed').trade, 'طريسيان');
  assert.equal(classify('9hraba 6ay7a').trade, 'طريسيان');         // Arabizi 9=ق, 6=ط
  assert.equal(classify('3hraba m9to3a').trade, 'طريسيان');         // Arabizi 3=ع
  assert.equal(classify('panne courant').trade, 'طريسيان');
  assert.equal(classify('short circuit f chi9a').trade, 'طريسيان');
  assert.equal(classify('compteur kayt9tar').trade, 'طريسيان');
  assert.equal(classify('kahrabaji jdid').trade, 'طريسيان');
});

test('صباغة (painter) — incl. Darija sba8/sbgha', () => {
  assert.equal(classify('بغيت صباغ').trade, 'صباغة');
  assert.equal(classify('peintre f maarif').trade, 'صباغة');
  assert.equal(classify('painter for walls').trade, 'صباغة');
  assert.equal(classify('sba8 f casa').trade, 'صباغة');
  assert.equal(classify('lsba8a tay7a').trade, 'صباغة');
  assert.equal(classify('peinture mat brillant').trade, 'صباغة');
});

test('نجارة (carpenter) — incl. khachab/menuisier', () => {
  assert.equal(classify('بغيت نجار').trade, 'نجارة');
  assert.equal(classify('menuisier bois').trade, 'نجارة');
  assert.equal(classify('carpenter needed').trade, 'نجارة');
  assert.equal(classify('najjar f mraks').trade, 'نجارة');
  assert.equal(classify('khachab placard').trade, 'نجارة');
  assert.equal(classify('placard bois f rbat').trade, 'نجارة');
  assert.equal(classify('escalier bois').trade, 'نجارة');
});

test('بناء (mason / construction)', () => {
  assert.equal(classify('بغيت بناء').trade, 'بناء');
  assert.equal(classify('maçon urgent').trade, 'بناء');
  assert.equal(classify('builder for new house').trade, 'بناء');
  assert.equal(classify('bnay f lcasa').trade, 'بناء');
  assert.equal(classify('lbnyya f gueliz').trade, 'بناء');
  assert.equal(classify('fissure f mur').trade, 'بناء');
  assert.equal(classify('briques mortier').trade, 'بناء');
});

test('نقاوة (cleaning) — incl. ndafa/n9aoua', () => {
  assert.equal(classify('بغيت نقاوة').trade, 'نقاوة');
  assert.equal(classify('femme de menage f anfa').trade, 'نقاوة');
  assert.equal(classify('cleaner needed').trade, 'نقاوة');
  assert.equal(classify('ndafa f sla').trade, 'نقاوة');
  assert.equal(classify('n9aoua mzyana').trade, 'نقاوة');
  assert.equal(classify('vitres a nettoyer').trade, 'نقاوة');
});

test('حدادة (ironwork) — Arabizi 7=ح variants', () => {
  assert.equal(classify('بغيت حداد').trade, 'حدادة');
  assert.equal(classify('ferronnier urgent').trade, 'حدادة');
  assert.equal(classify('ironworker needed').trade, 'حدادة');
  assert.equal(classify('hddad mzyan').trade, 'حدادة');
  assert.equal(classify('7eddad f marrakech').trade, 'حدادة');     // Arabizi 7=ح
  assert.equal(classify('l7eddad f gueliz').trade, 'حدادة');        // Arabizi 7=ح with definite article
  assert.equal(classify('portail aluminium').trade, 'حدادة');
  assert.equal(classify('moustiquaire f shabek').trade, 'حدادة');
});

test('ديكور (decor / interior design)', () => {
  assert.equal(classify('بغيت ديكور').trade, 'ديكور');
  assert.equal(classify('décorateur intérieur').trade, 'ديكور');
  assert.equal(classify('interior designer').trade, 'ديكور');
  assert.equal(classify('dekor f hay riyad').trade, 'ديكور');
  assert.equal(classify('faux plafond jbes').trade, 'ديكور');
  assert.equal(classify('placo platre').trade, 'ديكور');
});

test('نقل (moving / transport) — disambiguates from نجارة', () => {
  assert.equal(classify('بغيت نقل عفش').trade, 'نقل');
  assert.equal(classify('déménagement f casa').trade, 'نقل');
  assert.equal(classify('mover f tanja').trade, 'نقل');
  assert.equal(classify('tnaqil meubles').trade, 'نقل');           // disambiguation fix
  assert.equal(classify('tnaqil 3afsh').trade, 'نقل');
  assert.equal(classify('camion déménagement').trade, 'نقل');
});

test('كلامبيستري (tiling)', () => {
  assert.equal(classify('بغيت كلامبيستري').trade, 'كلامبيستري');
  assert.equal(classify('carreleur f mraks').trade, 'كلامبيستري');
  assert.equal(classify('tile installer').trade, 'كلامبيستري');
  assert.equal(classify('carro f tnja').trade, 'كلامبيستري');
  assert.equal(classify('zlij marocain').trade, 'كلامبيستري');
  assert.equal(classify('joint coulis bali').trade, 'كلامبيستري');
  assert.equal(classify('mosaique fayance').trade, 'كلامبيستري');
});

test('خياطة (tailoring) — incl. Arabizi 5=خ', () => {
  assert.equal(classify('بغيت خياط').trade, 'خياطة');
  assert.equal(classify('couturier f maarif').trade, 'خياطة');
  assert.equal(classify('tailor f ojda').trade, 'خياطة');
  assert.equal(classify('khayyat lblanto').trade, 'خياطة');
  assert.equal(classify('5ayyat f bouskoura').trade, 'خياطة');     // Arabizi 5=خ
  assert.equal(classify('broderie marocaine').trade, 'خياطة');
});

test('حراسة (security / guard)', () => {
  assert.equal(classify('بغيت حارس').trade, 'حراسة');
  assert.equal(classify('gardien f mohammedia').trade, 'حراسة');
  assert.equal(classify('watchman needed').trade, 'حراسة');
  assert.equal(classify('haris kher').trade, 'حراسة');
  assert.equal(classify('7arass f atlas fes').trade, 'حراسة');     // Arabizi 7=ح
  assert.equal(classify('cctv camera surveillance').trade, 'حراسة');
  assert.equal(classify('vigile night shift').trade, 'حراسة');
});

// ─── 15 Cities × multiple input forms ───────────────────────────────────────

test('الدار البيضاء (Casablanca) — incl. all major neighborhoods', () => {
  for (const q of [
    'casa', 'casablanca', 'lcasa', 'dar lbida', 'lbeida',
    'maarif', 'ma3arif', 'anfa', 'ain chock', 'sidi moumen',
    'mohammedia', 'bouskoura', 'hay hassani',
  ]) {
    assert.equal(classify(q).city, 'الدار البيضاء', `query="${q}"`);
  }
});

test('الرباط (Rabat) — incl. agdal/hay riyad', () => {
  for (const q of ['rabat', 'rbat', 'lrbat', 'agdal', 'hay riyad', 'hassan', 'capital']) {
    assert.equal(classify(q).city, 'الرباط', `query="${q}"`);
  }
});

test('طنجة (Tangier) — incl. Arabizi 6=ط and neighborhoods', () => {
  for (const q of ['tanger', 'tangier', 'tanja', 'tnja', '6anja', '6nja', 'malabata', 'charf']) {
    assert.equal(classify(q).city, 'طنجة', `query="${q}"`);
  }
});

test('مراكش (Marrakech) — incl. gueliz/menara', () => {
  for (const q of ['marrakech', 'marrakesh', 'mraks', 'lmraks', 'gueliz', 'menara', 'red city']) {
    assert.equal(classify(q).city, 'مراكش', `query="${q}"`);
  }
});

test('أكادير (Agadir) — incl. inezgane/ait melloul', () => {
  for (const q of ['agadir', 'lgadir', 'inezgane', 'ait melloul', 'founty', 'talborjt']) {
    assert.equal(classify(q).city, 'أكادير', `query="${q}"`);
  }
});

test('فاس (Fes)', () => {
  for (const q of ['fes', 'fez', 'fas', 'lfas', 'fes el bali', 'fes el jdid', 'atlas fes']) {
    assert.equal(classify(q).city, 'فاس', `query="${q}"`);
  }
});

test('سلا (Salé)', () => {
  for (const q of ['salé', 'sla', 'lsla', 'sallé', 'tabriquet']) {
    assert.equal(classify(q).city, 'سلا', `query="${q}"`);
  }
});

test('مكناس (Meknes) — incl. hamria', () => {
  for (const q of ['meknes', 'meknès', 'lmeknas', 'mknas', 'lmeknassa', 'hamria']) {
    assert.equal(classify(q).city, 'مكناس', `query="${q}"`);
  }
});

test('وجدة (Oujda)', () => {
  for (const q of ['oujda', 'wajda', 'wjda', 'lojda', 'ojda']) {
    assert.equal(classify(q).city, 'وجدة', `query="${q}"`);
  }
});

test('القنيطرة (Kenitra) — incl. Arabizi 9=ق', () => {
  for (const q of ['kenitra', 'kénitra', 'qnitra', 'knitra', '9nitra', 'l9nitra']) {
    assert.equal(classify(q).city, 'القنيطرة', `query="${q}"`);
  }
});

test('تطوان (Tetouan) — incl. Spanish/Arabizi forms', () => {
  for (const q of ['tetouan', 'tétouan', 'titwan', 'tetwan', 'tetuan', '6twan']) {
    assert.equal(classify(q).city, 'تطوان', `query="${q}"`);
  }
});

test('الجديدة (El Jadida) — incl. mazagan historical', () => {
  for (const q of ['jadida', 'el jadida', 'jdida', 'ljdida', 'mazagan', 'lmazagan']) {
    assert.equal(classify(q).city, 'الجديدة', `query="${q}"`);
  }
});

test('بني ملال (Beni Mellal)', () => {
  for (const q of ['beni mellal', 'bani mellal', 'bni mlal', 'bani melal']) {
    assert.equal(classify(q).city, 'بني ملال', `query="${q}"`);
  }
});

test('خريبكة (Khouribga) — incl. Arabizi 5=خ', () => {
  for (const q of ['khouribga', 'khribga', '5ribga', 'lkhribga']) {
    assert.equal(classify(q).city, 'خريبكة', `query="${q}"`);
  }
});

test('سطات (Settat)', () => {
  for (const q of ['settat', 'stat', 'sttat', 'seta']) {
    assert.equal(classify(q).city, 'سطات', `query="${q}"`);
  }
});

// ─── Multi-trade renovation phrases ─────────────────────────────────────────

test('Multi-trade: bathroom renovation (4 trades)', () => {
  const expected = ['بلومبي', 'كلامبيستري', 'طريسيان', 'صباغة'];
  for (const q of ['تجديد الحمام', 'jded l7mam', 'nrm l7mam', 'sallat l7mam', 'renovation salle de bain']) {
    assert.deepEqual(classify(q).multi_trade, expected, `query="${q}"`);
  }
});

test('Multi-trade: apartment / home renovation', () => {
  const expected = ['بناء', 'طريسيان', 'صباغة', 'ديكور'];
  for (const q of ['تجديد الشقة', 'jded ddar', 'nrm chi9a', 'renovation appartement']) {
    assert.deepEqual(classify(q).multi_trade, expected, `query="${q}"`);
  }
});

test('Multi-trade: house construction', () => {
  const expected = ['بناء', 'طريسيان', 'بلومبي', 'كلامبيستري'];
  for (const q of ['بناء دار', 'nbni dar', 'bnay dar', 'construction maison']) {
    assert.deepEqual(classify(q).multi_trade, expected, `query="${q}"`);
  }
});

test('Multi-trade: kitchen renovation', () => {
  const expected = ['نجارة', 'طريسيان', 'بلومبي', 'كلامبيستري'];
  for (const q of ['مطبخ جديد', 'jded kuzina', 'nbeddel kuzina', 'kitchen renovation']) {
    assert.deepEqual(classify(q).multi_trade, expected, `query="${q}"`);
  }
});

test('Multi-trade: roof / terrace waterproofing', () => {
  const expected = ['بناء', 'كلامبيستري', 'صباغة'];
  for (const q of ['تجديد السطح', 'jded ssath', 'fuite stah', 'fuite toiture']) {
    assert.deepEqual(classify(q).multi_trade, expected, `query="${q}"`);
  }
});

// ─── Mixed-script + complex queries ─────────────────────────────────────────

test('Mixed scripts: English + French + Darija in one query', () => {
  // "carpenter bois f gueliz" — English + French + neighborhood
  assert.equal(classify('carpenter bois f gueliz').trade, 'نجارة');
  assert.equal(classify('carpenter bois f gueliz').city, 'مراكش');
  // "tnaqil 3afsh f mohammedia" — Darija + Arabizi + Casa suburb
  assert.equal(classify('tnaqil 3afsh f mohammedia').trade, 'نقل');
  assert.equal(classify('tnaqil 3afsh f mohammedia').city, 'الدار البيضاء');
  // "9nitra panne courant" — Arabizi city + French problem
  assert.equal(classify('9nitra panne courant').trade, 'طريسيان');
  assert.equal(classify('9nitra panne courant').city, 'القنيطرة');
  // "f 6anja bghit 7eddad" — two Arabizi conventions in one query
  assert.equal(classify('f 6anja bghit 7eddad').trade, 'حدادة');
  assert.equal(classify('f 6anja bghit 7eddad').city, 'طنجة');
});

test('Disambiguation: meuble alone is NOT carpentry; meuble bois IS', () => {
  // After Phase 10 fix: bare "meuble" no longer matches نجارة (collides with نقل)
  assert.equal(classify('tnaqil meubles').trade, 'نقل');
  assert.equal(classify('meuble bois sur mesure').trade, 'نجارة');
  assert.equal(classify('placard bois').trade, 'نجارة');
});

test('Off-topic / non-services queries return null', () => {
  for (const q of ['salam', 'merci', 'okay', '', 'بغيت طاجين', 'تاجين هاسي', 'مرحبا']) {
    const r = classify(q);
    assert.equal(r.trade, null, `query="${q}" — should be null`);
  }
});

test('All 12 valid trade categories are reachable', () => {
  // Sanity check: every category in VALID_CATS must be reachable from some
  // keyword. Pick the canonical Arabic name itself as the proof.
  for (const cat of VALID_CATS) {
    const result = classify(cat);
    assert.equal(result.trade, cat, `canonical "${cat}" must map to itself`);
  }
});
