'use strict';
// Background worker: tokenizer + dictionary, so the page never freezes while they load or run.
importScripts('https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js');

const KUROMOJI_DICT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
const kataToHira = (s) => (s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hasKanji = (s) => /[㐀-䶿一-鿿豈-﫿々〆ヵヶ]/.test(s);
const status = (msg) => postMessage({ status: msg });

// ---------- tokenizer ----------
let tokenizerP = null;
function getTokenizer(dicPath) {
  if (!tokenizerP) tokenizerP = new Promise((resolve, reject) => {
    status('辞書 loading tokenizer…');
    kuromoji.builder({ dicPath: dicPath || KUROMOJI_DICT }).build((err, t) => {
      status('');
      if (err) { tokenizerP = null; reject(err); } else resolve(t);
    });
  });
  return tokenizerP;
}

// Group tokens into study units: verb/adjective + its auxiliaries (泣い+て+た → 泣いてた ← 泣く).
function toUnits(tokenizer, text) {
  const units = [];
  for (const raw of tokenizer.tokenize(text)) {
    const t = { surface_form: raw.surface_form, reading: raw.reading, pos: raw.pos, pos_detail_1: raw.pos_detail_1, basic_form: raw.basic_form };
    const prev = units[units.length - 1];
    const h = prev && prev.toks[0];
    const inflecting = h && (['動詞', '形容詞'].includes(h.pos) || (h.pos === '名詞' && h.pos_detail_1 === '形容動詞語幹' && t.pos === '助動詞'));
    const attach = inflecting && (
      t.pos === '助動詞' ||
      (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && /^(て|で|ちゃ|じゃ)$/.test(t.surface_form)) ||
      (t.pos === '動詞' && ['非自立', '接尾'].includes(t.pos_detail_1)) ||
      (t.pos === '形容詞' && t.pos_detail_1 === '非自立') ||
      (t.pos === '名詞' && t.pos_detail_1 === '非自立' && /^(ん|の)$/.test(t.surface_form)) // 思い出すんだ
    );
    if (attach) { prev.toks.push(t); prev.surface += t.surface_form; continue; }
    units.push({ toks: [t], surface: t.surface_form });
  }
  for (const u of units) {
    const h = u.toks[0];
    u.base = h.basic_form && h.basic_form !== '*' ? h.basic_form : h.surface_form;
    u.study = !['記号', '助詞', '助動詞'].includes(h.pos) && /[぀-ヿ㐀-鿿]/.test(u.surface);
  }
  return units;
}

// ---------- dictionary ----------
// dict.tsv.gz: one entry per line, parsed only when looked up.
let LINES = null, INDEX = null, dictP = null;
function loadDict() {
  if (!dictP) dictP = (async () => {
    status('辞書 loading dictionary…');
    const res = await fetch('data/dict.tsv.gz');
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = buf[0] === 0x1f && buf[1] === 0x8b
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf); // server already decoded it
    LINES = text.split('\n');
    INDEX = new Map();
    for (let i = 0; i < LINES.length; i++) {
      const line = LINES[i];
      const a = line.indexOf('\t'), b = line.indexOf('\t', a + 1);
      if (b < 0) continue;
      for (const k of (line.slice(0, a) + '|' + line.slice(a + 1, b)).split('|')) {
        if (!k) continue;
        const arr = INDEX.get(k);
        if (arr) arr.push(i); else INDEX.set(k, [i]);
      }
    }
    status('');
  })().catch((e) => { dictP = null; status('⚠ dictionary: ' + e.message); throw e; });
  return dictP;
}
function entry(i) {
  const [kj, kn, sc, ss] = LINES[i].split('\t');
  return [kj ? kj.split('|') : [], kn.split('|'), +sc, ss.split('\x1e').map((s) => s.split('\x1f'))];
}
function lookup(u) {
  const h = u.toks[0];
  const reading = kataToHira(h.reading);
  const seen = new Set(), cands = [];
  for (const k of [u.base, h.surface_form, u.surface, kataToHira(u.base)]) for (const i of INDEX.get(k) || []) if (!seen.has(i)) { seen.add(i); cands.push(entry(i)); }
  const baseReading = kataToHira(u.base) === u.base ? u.base : null;
  return cands.map((e) => {
    const [kj, kn, score] = e;
    let s = score;
    if (kj.includes(u.base)) s += 50;
    if (hasKanji(u.surface) && !kj.length) s -= 40;
    if (reading && kn.some((r) => reading.startsWith(r.slice(0, Math.max(1, r.length - 1))))) s += 15;
    if (baseReading && kn[0] === baseReading) s += 10;
    return { e, s };
  }).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.e);
}

onmessage = async ({ data: { id, type, lines, unit, dicPath } }) => {
  try {
    let result;
    if (type === 'tokenize') { const t = await getTokenizer(dicPath); result = lines.map((l) => toUnits(t, l)); }
    else if (type === 'loadDict') { await loadDict(); }
    else if (type === 'lookup') { await loadDict(); result = lookup(unit); }
    postMessage({ id, result });
  } catch (e) {
    postMessage({ id, error: String(e && e.message || e) });
  }
};
