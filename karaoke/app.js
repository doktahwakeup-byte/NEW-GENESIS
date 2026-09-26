'use strict';
// 歌で覚える — karaoke study tool. Single page, no build step, data in localStorage.

const KUROMOJI_DICT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const status = (msg) => { $('#status').textContent = msg || ''; };

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('kk.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('kk.' + k, JSON.stringify(v)); } catch (e) { alert('Could not save: ' + e.message); } },
};
const S = {
  songs: store.get('songs', []),
  cards: store.get('cards', []),
  known: new Set(store.get('known', [])),
  settings: Object.assign({ furi: 'smart', kanjiLvl: 3, rate: 1 }, store.get('settings', {})),
};
const save = {
  songs: () => store.set('songs', S.songs),
  cards: () => store.set('cards', S.cards),
  known: () => store.set('known', [...S.known]),
  settings: () => store.set('settings', S.settings),
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- kana / kanji helpers ----------
const kataToHira = (s) => (s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isKanji = (c) => /[㐀-䶿一-鿿豈-﫿々〆ヵヶ]/.test(c);
const hasKanji = (s) => [...s].some(isKanji);
let KANJI_LVL = {};

// Split "泣い" + "ない" into [{t:'泣',r:'な'},{t:'い'}] so furigana sits only over the kanji.
function rubyParts(surface, reading) {
  if (!reading || !hasKanji(surface)) return [{ t: surface }];
  const runs = [];
  for (const ch of surface) {
    const k = isKanji(ch);
    if (runs.length && runs[runs.length - 1].k === k) runs[runs.length - 1].t += ch;
    else runs.push({ t: ch, k });
  }
  const re = new RegExp('^' + runs.map((r) => r.k ? '(.+?)' : kataToHira(r.t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
  const m = kataToHira(reading).match(re);
  if (!m) return [{ t: surface, r: kataToHira(reading) }];
  let g = 1;
  return runs.map((r) => r.k ? { t: r.t, r: m[g++] } : { t: r.t });
}

// ---------- tokenizer ----------
let tokenizer = null;
const tokenizerReady = new Promise((resolve) => {
  const start = () => {
    if (!window.kuromoji) { status('⚠ tokenizer failed to load'); return; }
    status('辞書 loading tokenizer…');
    kuromoji.builder({ dicPath: window.KUROMOJI_DICT_OVERRIDE || KUROMOJI_DICT }).build((err, t) => {
      if (err) { status('⚠ tokenizer: ' + err); return; }
      tokenizer = t; status(''); resolve(t);
    });
  };
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
});

// Group kuromoji tokens into study units: verb/adjective + its auxiliaries (泣い+て+た → 泣いてた ← 泣く).
function toUnits(text) {
  const toks = tokenizer.tokenize(text);
  const units = [];
  for (const t of toks) {
    const prev = units[units.length - 1];
    const inflecting = prev && (['動詞', '形容詞'].includes(prev.head.pos) || (prev.head.pos === '名詞' && prev.head.pos_detail_1 === '形容動詞語幹' && t.pos === '助動詞'));
    const attach = inflecting && (
      t.pos === '助動詞' ||
      (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && /^(て|で|ちゃ|じゃ)$/.test(t.surface_form)) ||
      (t.pos === '動詞' && ['非自立', '接尾'].includes(t.pos_detail_1)) ||
      (t.pos === '形容詞' && t.pos_detail_1 === '非自立') ||
      (t.pos === '名詞' && t.pos_detail_1 === '非自立' && /^(ん|の)$/.test(t.surface_form)) // 思い出すんだ
    );
    if (attach) { prev.toks.push(t); prev.surface += t.surface_form; continue; }
    units.push({ toks: [t], head: t, surface: t.surface_form });
  }
  for (const u of units) {
    const h = u.head;
    u.base = h.basic_form && h.basic_form !== '*' ? h.basic_form : h.surface_form;
    u.study = !['記号', '助詞', '助動詞'].includes(h.pos) && /[぀-ヿ㐀-鿿]/.test(u.surface);
  }
  return units;
}

// ---------- dictionary ----------
let DICT = null, DINDEX = null, dictLoading = null;
function loadDict() {
  if (dictLoading) return dictLoading;
  dictLoading = (async () => {
    status('辞書 loading dictionary…');
    const res = await fetch('data/dict.json.gz');
    const buf = new Uint8Array(await res.arrayBuffer());
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(ds).text();
    } else text = new TextDecoder().decode(buf); // server already decoded it
    DICT = JSON.parse(text);
    DINDEX = new Map();
    const add = (k, i) => { const a = DINDEX.get(k); if (a) a.push(i); else DINDEX.set(k, [i]); };
    DICT.forEach((e, i) => { e[0].forEach((k) => add(k, i)); e[1].forEach((k) => add(k, i)); });
    status('');
  })().catch((e) => { status('⚠ dictionary: ' + e.message); dictLoading = null; });
  return dictLoading;
}
function lookup(unit) {
  if (!DINDEX) return [];
  const h = unit.head;
  const reading = kataToHira(h.reading);
  const keys = [unit.base, h.surface_form, unit.surface, kataToHira(unit.base)];
  const seen = new Set(), out = [];
  for (const k of keys) for (const i of DINDEX.get(k) || []) if (!seen.has(i)) { seen.add(i); out.push(i); }
  const baseReading = kataToHira(unit.base) === unit.base ? unit.base : null;
  return out.map((i) => {
    const [kj, kn, score] = DICT[i];
    let s = score;
    if (kj.includes(unit.base)) s += 50;
    if (hasKanji(unit.surface) && !kj.length) s -= 40;
    if (reading && kn.some((r) => reading.startsWith(r.slice(0, Math.max(1, r.length - 1))))) s += 15;
    if (baseReading && kn[0] === baseReading) s += 10;
    return { i, s };
  }).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => DICT[x.i]);
}
const entryReading = (e) => e[1][0];
const entryWord = (e, unit) => (e[0].includes(unit.base) ? unit.base : e[0][0]) || e[1][0];
const shortGloss = (e) => e[3].slice(0, 2).map((s) => s[1].split('; ').slice(0, 2).join(', ')).join('; ');

// ---------- SRS (Anki-ish SM-2) ----------
const MIN = 60e3, DAY = 864e5;
function schedule(c, g, now = Date.now()) {
  const n = { ...c };
  if (n.state !== 'review') {
    const steps = [1 * MIN, 10 * MIN];
    if (g === 0) { n.step = 0; n.due = now + steps[0]; }
    else if (g === 1) { n.due = now + steps[Math.min(n.step || 0, 1)] * 1.5; }
    else if (g === 2 && (n.step || 0) + 1 < steps.length) { n.step = (n.step || 0) + 1; n.due = now + steps[n.step]; }
    else { n.state = 'review'; n.ivl = g === 3 ? 4 : 1; n.due = now + n.ivl * DAY; }
  } else {
    const ivl = n.ivl || 1, fuzz = 1 + (Math.random() - 0.5) * 0.1;
    if (g === 0) { n.lapses = (n.lapses || 0) + 1; n.ease = Math.max(1.3, n.ease - 0.2); n.ivl = Math.max(1, Math.round(ivl * 0.3)); n.state = 'learning'; n.step = 1; n.due = now + 10 * MIN; }
    else if (g === 1) { n.ease = Math.max(1.3, n.ease - 0.15); n.ivl = Math.max(ivl + 1, Math.round(ivl * 1.2 * fuzz)); n.due = now + n.ivl * DAY; }
    else if (g === 2) { n.ivl = Math.max(ivl + 1, Math.round(ivl * n.ease * fuzz)); n.due = now + n.ivl * DAY; }
    else { n.ease += 0.15; n.ivl = Math.max(ivl + 2, Math.round(ivl * n.ease * 1.3 * fuzz)); n.due = now + n.ivl * DAY; }
  }
  n.reps = (n.reps || 0) + 1;
  return n;
}
function fmtIvl(ms) {
  if (ms < 3600e3) return Math.max(1, Math.round(ms / MIN)) + 'm';
  if (ms < DAY) return Math.round(ms / 3600e3) + 'h';
  if (ms < 30 * DAY) return Math.round(ms / DAY) + 'd';
  if (ms < 365 * DAY) return (ms / DAY / 30).toFixed(1) + 'mo';
  return (ms / DAY / 365).toFixed(1) + 'y';
}
const dueCards = () => S.cards.filter((c) => c.due <= Date.now()).sort((a, b) => a.due - b.due);
const cardKey = (w, r) => w + '|' + r;
const savedWords = () => new Set(S.cards.map((c) => c.word));
const matureWords = () => new Set(S.cards.filter((c) => c.state === 'review' && c.ivl >= 21).map((c) => c.word));
function refreshDue() { const n = dueCards().length; $('#dueCount').textContent = n || ''; }

// ---------- lyrics parsing ----------
function parseLyrics(src) {
  const lines = [];
  let offset = 0, timed = false;
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = +off[1] / 1000; continue; }
    if (/^\[[a-z]+:.*\]$/i.test(raw.trim())) continue; // [ar:], [ti:] metadata
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    const text = raw.replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim();
    if (stamps.length) {
      timed = true;
      for (const m of stamps) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')) - offset, text });
    } else if (text) lines.push({ t: null, text });
  }
  if (timed) return lines.filter((l) => l.t !== null).sort((a, b) => a.t - b.t);
  return lines;
}
const fmtTime = (t) => t == null ? '--:--' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const toLrc = (lines) => lines.map((l) => l.t == null ? l.text
  : `[${String(Math.floor(l.t / 60)).padStart(2, '0')}:${(l.t % 60).toFixed(2).padStart(5, '0')}]${l.text}`).join('\n');
function parseVideoId(s) {
  s = (s || '').trim();
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}
const cleanTitle = (t) => (t || '').replace(/【[^】]*】|\[[^\]]*\]|\([^)]*(MV|Music Video|Official|Lyric|歌詞)[^)]*\)|(Official )?(Music )?Video|MV|full ?ver\.?/gi, ' ').replace(/[／/|｜].*$/, (m) => ' ' + m.slice(1)).replace(/\s+/g, ' ').trim();

// ---------- YouTube ----------
let yt = null, ytReady = false, ytVideo = null;
const ytReadyP = new Promise((resolve) => {
  window.onYouTubeIframeAPIReady = () => {
    yt = new YT.Player('yt', {
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0 },
      events: {
        onReady: () => { ytReady = true; resolve(); },
        onStateChange: onYtState,
        onError: (e) => {
          const msg = { 2: 'bad video id', 5: 'HTML5 player error', 100: 'video not found', 101: 'the uploader blocks embedding', 150: 'the uploader blocks embedding' }[e.data] || e.data;
          status('⚠ YouTube: ' + msg + (e.data >= 101 ? ' — try another upload (lyric video / "Topic" channel)' : ''));
        },
      },
    });
  };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
});
async function ensureVideo(videoId) {
  await ytReadyP;
  if (ytVideo !== videoId) { yt.cueVideoById(videoId); ytVideo = videoId; }
}
const now = () => (ytReady && yt.getCurrentTime ? yt.getCurrentTime() : 0);
const playing = () => ytReady && yt.getPlayerState && yt.getPlayerState() === 1;
let titleWaiter = null;
function onYtState(e) {
  $('#btnPlay').textContent = e.data === 1 ? '⏸' : '▶';
  if (titleWaiter && yt.getVideoData) {
    const t = yt.getVideoData().title;
    if (t) { titleWaiter(t); titleWaiter = null; }
  }
}

// ---------- views ----------
let view = 'library';
function show(v) {
  view = v;
  $$('.view').forEach((el) => el.classList.toggle('hidden', el.id !== 'view-' + v));
  $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  const needPlayer = v === 'player' || v === 'review' || (v === 'library' && !$('#addSong').classList.contains('hidden'));
  $('#playerWrap').classList.toggle('hidden', !needPlayer);
  $('#playerWrap').classList.toggle('mini', v === 'review');
  if (v !== 'player' && playing() && v !== 'review') yt.pauseVideo();
  if (v === 'library') renderLibrary();
  if (v === 'review') startReview();
  if (v === 'deck') renderDeck();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  const last = store.get('lastSong');
  if (b.dataset.view === 'player' && !currentSong && last) return openSong(last);
  show(b.dataset.view);
}));

// ---------- library ----------
let editingSong = null;
function renderLibrary() {
  const ul = $('#songList');
  ul.innerHTML = '';
  $('#emptyLib').classList.toggle('hidden', S.songs.length > 0);
  for (const s of S.songs) {
    const n = S.cards.filter((c) => c.songId === s.id).length;
    const li = document.createElement('li');
    li.innerHTML = `<span class="t"><b>${esc(s.title || '(untitled)')}</b><span class="muted small">${esc(s.artist || '')} · ${s.lines.length} lines · ${n} cards${s.lines.some((l) => l.t == null) ? ' · ⏱ needs sync' : ''}</span></span>
      <button data-a="open" class="primary">♪ Sing</button><button data-a="del" title="Delete">🗑</button>`;
    li.querySelector('.t').onclick = () => openSong(s.id);
    li.querySelector('[data-a=open]').onclick = () => openSong(s.id);
    li.querySelector('[data-a=del]').onclick = () => {
      if (!confirm(`Delete "${s.title}"? Its cards stay in your deck.`)) return;
      S.songs = S.songs.filter((x) => x !== s); save.songs(); renderLibrary();
    };
    ul.appendChild(li);
  }
}
function openAddSong(song) {
  editingSong = song || null;
  $('#addSongTitle').textContent = song ? 'Edit song' : 'Add song';
  $('#inUrl').value = song ? 'https://youtu.be/' + song.videoId : '';
  $('#inTitle').value = song ? song.title : '';
  $('#inArtist').value = song ? song.artist : '';
  $('#inLyrics').value = song ? toLrc(song.lines) : '';
  $('#lyricsResults').innerHTML = '';
  $('#lyricsSearchStatus').textContent = '';
  $('#addSong').classList.remove('hidden');
  show('library');
  $('#addSong').scrollIntoView({ behavior: 'smooth' });
}
$('#btnAddSong').onclick = () => openAddSong();
$('#btnCancelSong').onclick = () => { $('#addSong').classList.add('hidden'); show('library'); };
$('#btnEditSong').onclick = () => openAddSong(currentSong);
$('#inUrl').addEventListener('change', async () => {
  const id = parseVideoId($('#inUrl').value);
  if (!id) return;
  const got = new Promise((r) => { titleWaiter = r; });
  await ensureVideo(id);
  yt.mute(); yt.playVideo(); // title only arrives once the video starts
  const title = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 8000))]);
  yt.pauseVideo(); yt.unMute();
  if (title && !$('#inTitle').value) {
    const parts = title.split(/\s*[/／|｜]\s*|\s+-\s+/);
    $('#inTitle').value = cleanTitle(parts[0]);
    if (parts[1] && !$('#inArtist').value) $('#inArtist').value = cleanTitle(parts[1]);
    if (!$('#inLyrics').value) searchLyrics();
  }
});
async function searchLyrics() {
  const title = $('#inTitle').value.trim(), artist = $('#inArtist').value.trim();
  const q = [title, artist].filter(Boolean).join(' ');
  if (!q) return;
  const st = $('#lyricsSearchStatus'), ul = $('#lyricsResults');
  st.textContent = 'searching…'; ul.innerHTML = '';
  try {
    const res = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q));
    const list = await res.json();
    st.textContent = list.length ? `${list.length} results — click one` : 'nothing found — try fewer words, or paste lyrics';
    list.sort((a, b) => !!b.syncedLyrics - !!a.syncedLyrics);
    for (const r of list.slice(0, 20)) {
      const li = document.createElement('li');
      li.innerHTML = `${r.syncedLyrics ? '⏱' : '📝'} <b>${esc(r.trackName)}</b> — ${esc(r.artistName)} <span class="muted small">${esc(r.albumName || '')} ${r.duration ? fmtTime(r.duration).split('.')[0] : ''}</span>`;
      li.onclick = () => {
        $('#inLyrics').value = r.syncedLyrics || r.plainLyrics || '';
        if (!$('#inTitle').value) $('#inTitle').value = r.trackName;
        if (!$('#inArtist').value) $('#inArtist').value = r.artistName;
        ul.innerHTML = ''; st.textContent = r.syncedLyrics ? 'synced lyrics loaded ✓' : 'plain lyrics loaded — use ⏱ Tap-sync after saving';
      };
      ul.appendChild(li);
    }
  } catch (e) { st.textContent = '⚠ search failed: ' + e.message; }
}
$('#btnSearchLyrics').onclick = searchLyrics;
$('#btnSaveSong').onclick = () => {
  const videoId = parseVideoId($('#inUrl').value);
  if (!videoId) return alert('That doesn\'t look like a YouTube link.');
  const lines = parseLyrics($('#inLyrics').value);
  if (!lines.length) return alert('Add some lyrics first.');
  const data = { videoId, title: $('#inTitle').value.trim(), artist: $('#inArtist').value.trim(), lines };
  let song = editingSong;
  if (song) {
    if (toLrc(song.lines) !== toLrc(lines)) song.overrides = {}; // line indexes changed
    Object.assign(song, data);
  } else {
    song = { id: uid(), offset: 0, overrides: {}, ...data };
    S.songs.unshift(song);
  }
  save.songs();
  $('#addSong').classList.add('hidden');
  openSong(song.id);
};

// ---------- player ----------
let currentSong = null, units = [], curLine = -1, loopLine = null, shadow = false, cloze = false;
let shadowResumeAt = null, clipEnd = null, seekTarget = null, playedThrough = null;
async function openSong(id) {
  const song = S.songs.find((s) => s.id === id);
  if (!song) return;
  currentSong = song;
  store.set('lastSong', id);
  $('#tabPlayer').disabled = false;
  show('player');
  $('#offsetVal').textContent = (song.offset || 0).toFixed(2) + 's';
  $('#lyrics').innerHTML = '<p class="muted">Loading tokenizer…</p>';
  ensureVideo(song.videoId);
  loadDict();
  await tokenizerReady;
  units = song.lines.map((l) => toUnits(l.text));
  curLine = -1; loopLine = null;
  $('#btnLoop').classList.remove('on');
  renderLyrics();
  if (song.lines.some((l) => l.t == null)) startSync();
}
const lineStart = (i) => currentSong.lines[i].t + (currentSong.offset || 0);
function lineEnd(i) {
  const L = currentSong.lines;
  if (i + 1 < L.length && L[i + 1].t != null) return L[i + 1].t + (currentSong.offset || 0);
  return lineStart(i) + 6;
}
function showFuri(unit) {
  const f = S.settings.furi;
  if (f === 'all') return true;
  if (f === 'off') return false;
  if (S.known.has(unit.base) || matureWords().has(unit.base)) return false;
  const lvl = +S.settings.kanjiLvl;
  if (lvl && [...unit.surface].filter(isKanji).every((c) => KANJI_LVL[c] && KANJI_LVL[c] >= lvl)) return false;
  return true;
}
function unitHtml(u, li, ui, opts = {}) {
  const song = opts.song || currentSong;
  const ov = song && song.overrides && song.overrides[li + ':' + ui];
  let inner = '';
  if (ov && hasKanji(u.surface)) inner = `<ruby>${esc(u.surface)}<rt class="override">${esc(ov)}</rt></ruby>`;
  else for (const t of u.toks) for (const p of rubyParts(t.surface_form, t.reading)) inner += p.r ? `<ruby>${esc(p.t)}<rt>${esc(p.r)}</rt></ruby>` : esc(p.t);
  const cls = ['u'];
  if (u.study) cls.push('w');
  if (opts.target) cls.push('target');
  if (!opts.target && !ov && !(opts.furi ?? showFuri(u))) cls.push('nofuri');
  if (u.study && opts.saved && opts.saved.has(u.base)) cls.push(cloze && !opts.review ? 'cloze' : 'saved');
  return `<span class="${cls.join(' ')}" data-l="${li}" data-u="${ui}">${inner}</span>`;
}
function renderLyrics() {
  const saved = savedWords();
  const box = $('#lyrics');
  box.innerHTML = currentSong.lines.map((l, i) => {
    const tx = units[i].map((u, j) => unitHtml(u, i, j, { saved })).join('');
    return `<div class="line${l.text ? '' : ' blank'}" data-l="${i}"><span class="ts">${fmtTime(l.t)}</span><span class="tx">${tx}</span></div>`;
  }).join('');
  curLine = -1;
  if (syncing) markSyncNext();
}
$('#lyrics').addEventListener('click', (e) => {
  const u = e.target.closest('.u.w');
  if (u && !syncing) {
    if (u.classList.contains('cloze')) { u.classList.replace('cloze', 'saved'); return; }
    return openSheet(+u.dataset.l, +u.dataset.u);
  }
  const line = e.target.closest('.line');
  if (line && !syncing && currentSong.lines[+line.dataset.l].t != null) {
    seekLine(+line.dataset.l);
  }
});

function tick() {
  requestAnimationFrame(tick);
  if (!ytReady) return;
  const t = now();
  // review clip playback
  if (clipEnd != null && t >= clipEnd && playing()) { yt.pauseVideo(); clipEnd = null; }
  if (view !== 'player' || !currentSong || syncing) return;
  if (shadowResumeAt != null) {
    if (Date.now() >= shadowResumeAt) { shadowResumeAt = null; $('#shadowHint').classList.add('hidden'); yt.playVideo(); }
    return;
  }
  const L = currentSong.lines;
  if (loopLine != null && playing() && t >= lineEnd(loopLine) - 0.05) {
    yt.seekTo(Math.max(0, lineStart(loopLine) - 0.1), true);
    if (shadow) { yt.pauseVideo(); shadowResumeAt = Date.now() + (lineEnd(loopLine) - lineStart(loopLine)) * 1000 / (S.settings.rate || 1) + 400; $('#shadowHint').classList.remove('hidden'); }
    return;
  }
  let i = -1;
  for (let k = 0; k < L.length; k++) { if (L[k].t != null && lineStart(k) <= t + 0.05) i = k; else if (L[k].t != null) break; }
  if (i === curLine) return;
  const finished = curLine;
  // only lines heard from their start count as "sung through"
  const natural = seekTarget != null ? i === seekTarget : i === curLine + 1;
  if (seekTarget != null && i >= seekTarget) seekTarget = null;
  if (shadow && loopLine == null && playing() && i === finished + 1 && playedThrough === finished && L[finished].text) {
    // the line just finished: pause and give the singer the same amount of time
    yt.pauseVideo();
    shadowResumeAt = Date.now() + (lineEnd(finished) - lineStart(finished)) * 1000 / (S.settings.rate || 1) + 400;
    $('#shadowHint').classList.remove('hidden');
    yt.seekTo(lineEnd(finished), true);
  }
  playedThrough = natural ? i : null;
  curLine = i; highlight(i);
}
function highlight(i) {
  $$('.line').forEach((el) => {
    const k = +el.dataset.l;
    el.classList.toggle('now', k === i);
    el.classList.toggle('past', i >= 0 && k < i);
  });
  const el = $(`.line[data-l="${i}"]`);
  if (el && $('#sheet').classList.contains('hidden')) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
requestAnimationFrame(tick);

function seekLine(i) {
  if (loopLine != null) loopLine = i;
  shadowResumeAt = null; $('#shadowHint').classList.add('hidden');
  curLine = -1; seekTarget = i; // so shadow mode doesn't treat the jump as a finished line
  yt.seekTo(Math.max(0, lineStart(i) - 0.15), true); yt.playVideo();
}
function togglePlay() { if (!ytReady) return; if (playing()) yt.pauseVideo(); else { shadowResumeAt = null; $('#shadowHint').classList.add('hidden'); yt.playVideo(); } }
function jumpLine(d) {
  const L = currentSong.lines;
  let i = Math.min(L.length - 1, Math.max(0, (curLine < 0 ? 0 : curLine) + d));
  while (L[i] && L[i].t == null) i += d > 0 ? 1 : -1;
  if (!L[i]) return;
  seekLine(i);
}
$('#btnPlay').onclick = togglePlay;
$('#btnPrev').onclick = () => jumpLine(-1);
$('#btnNext').onclick = () => jumpLine(1);
function toggleLoop() {
  loopLine = loopLine == null ? Math.max(0, curLine) : null;
  $('#btnLoop').classList.toggle('on', loopLine != null);
}
function toggleShadow() { shadow = !shadow; $('#btnShadow').classList.toggle('on', shadow); if (!shadow) { shadowResumeAt = null; $('#shadowHint').classList.add('hidden'); } }
function toggleCloze() { cloze = !cloze; $('#btnCloze').classList.toggle('on', cloze); renderLyrics(); highlight(curLine); }
$('#btnLoop').onclick = toggleLoop;
$('#btnShadow').onclick = toggleShadow;
$('#btnCloze').onclick = toggleCloze;
$('#selRate').value = String(S.settings.rate);
$('#selRate').onchange = () => { S.settings.rate = +$('#selRate').value; save.settings(); if (ytReady) yt.setPlaybackRate(S.settings.rate); };
ytReadyP.then(() => yt.setPlaybackRate(S.settings.rate));
$('#selFuri').value = S.settings.furi;
$('#selFuri').onchange = () => { S.settings.furi = $('#selFuri').value; save.settings(); if (currentSong) { renderLyrics(); highlight(curLine); } };
function nudge(d) {
  currentSong.offset = Math.round(((currentSong.offset || 0) + d) * 100) / 100;
  $('#offsetVal').textContent = currentSong.offset.toFixed(2) + 's';
  save.songs();
}
$('#btnOffMinus').onclick = () => nudge(-0.25);
$('#btnOffPlus').onclick = () => nudge(0.25);

// ---------- tap-sync ----------
let syncing = false, syncIdx = 0, syncHistory = [];
function startSync() {
  syncing = true; syncIdx = 0; syncHistory = [];
  $('#syncBar').classList.remove('hidden');
  currentSong.offset = 0; $('#offsetVal').textContent = '0.00s';
  markSyncNext();
}
function markSyncNext() {
  $$('.line').forEach((el) => el.classList.toggle('syncnext', +el.dataset.l === syncIdx));
  const el = $(`.line[data-l="${syncIdx}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function syncTap() {
  if (!syncing) return;
  if (!playing()) { yt.playVideo(); return; }
  if (syncIdx >= currentSong.lines.length) return;
  syncHistory.push(currentSong.lines[syncIdx].t);
  currentSong.lines[syncIdx].t = Math.max(0, now() - 0.2); // reaction-time allowance
  const ts = $(`.line[data-l="${syncIdx}"] .ts`); if (ts) ts.textContent = fmtTime(currentSong.lines[syncIdx].t);
  syncIdx++;
  if (syncIdx >= currentSong.lines.length) finishSync(); else markSyncNext();
}
function finishSync() {
  syncing = false;
  $('#syncBar').classList.add('hidden');
  // untimed trailing lines: space them after the last timed one
  let last = 0;
  currentSong.lines.forEach((l) => { if (l.t == null) l.t = last += 3; else last = l.t; });
  save.songs(); renderLyrics();
}
$('#btnSyncTap').onclick = syncTap;
$('#btnSyncUndo').onclick = () => {
  if (!syncIdx) return;
  syncIdx--; currentSong.lines[syncIdx].t = syncHistory.pop();
  yt.seekTo(Math.max(0, (currentSong.lines[syncIdx - 1] || { t: 0 }).t || 0), true);
  markSyncNext();
};
$('#btnSyncDone').onclick = finishSync;
$('#btnTapSync').onclick = () => { yt.seekTo(0, true); yt.pauseVideo(); startSync(); };

// ---------- word sheet ----------
let sheetCtx = null;
async function openSheet(li, ui, song = currentSong, lineUnits = units[li]) {
  const u = lineUnits[ui];
  sheetCtx = { li, ui, u, song, sel: 0, entries: [] };
  $('#sheet').classList.remove('hidden');
  const conj = u.surface !== u.base ? `<span class="from">${esc(u.surface)} ← ${esc(u.base)}</span>` : '';
  const furi = u.toks.map((t) => rubyParts(t.surface_form, t.reading).map((p) => p.r ? `<ruby>${esc(p.t)}<rt>${esc(p.r)}</rt></ruby>` : esc(p.t)).join('')).join('');
  $('#sheetHead').innerHTML = furi + conj;
  $('#sheetEntries').innerHTML = '<p class="muted">Loading dictionary…</p>';
  await loadDict();
  if (!sheetCtx || sheetCtx.u !== u) return;
  sheetCtx.entries = lookup(u);
  renderSheetEntries();
}
function renderSheetEntries() {
  const { entries, sel, u } = sheetCtx;
  const box = $('#sheetEntries');
  if (!entries.length) { box.innerHTML = '<p class="muted">No dictionary entry. You can still save it.</p>'; }
  else box.innerHTML = entries.map((e, i) => `<div class="e${i === sel ? ' sel' : ''}" data-i="${i}">
      <div class="h">${esc(e[0].join('・') || e[1][0])} <span class="muted">【${esc(e[1].join('・'))}】</span></div>
      <ol>${e[3].map((s) => `<li>${s[0] ? `<span class="pos">${esc(s[0])}</span>` : ''}${esc(s[1])}</li>`).join('')}</ol></div>`).join('');
  box.querySelectorAll('.e').forEach((el) => el.onclick = () => { sheetCtx.sel = +el.dataset.i; renderSheetEntries(); });
  const e = entries[sel];
  const word = e ? entryWord(e, u) : u.base;
  const exists = S.cards.some((c) => c.word === word);
  $('#sheetSave').textContent = exists ? '★ Saved' : '★ Save card';
  $('#sheetSave').disabled = exists;
  $('#sheetKnown').textContent = S.known.has(u.base) ? '✓ Known (undo)' : '✓ Mark known';
  $('#sheetReading').classList.toggle('hidden', !hasKanji(u.surface) || sheetCtx.song !== currentSong || view !== 'player');
}
function closeSheet() { $('#sheet').classList.add('hidden'); sheetCtx = null; }
$('#sheetClose').onclick = closeSheet;
$('#sheetSave').onclick = () => {
  const { entries, sel, u, song, li } = sheetCtx;
  const e = entries[sel];
  const word = e ? entryWord(e, u) : u.base;
  const reading = e ? entryReading(e) : kataToHira(u.head.reading);
  const ov = song.overrides && song.overrides[li + ':' + sheetCtx.ui];
  S.cards.push({
    id: uid(), word, reading, surface: u.surface, sung: ov || null,
    gloss: e ? shortGloss(e) : '', senses: e ? e[3] : [],
    songId: song.id, line: li, text: song.lines[li].text,
    created: Date.now(), due: Date.now(), state: 'new', step: 0, ease: 2.5, ivl: 0, reps: 0, lapses: 0,
  });
  save.cards(); refreshDue(); renderSheetEntries();
  if (view === 'player') { renderLyrics(); highlight(curLine); }
};
$('#sheetKnown').onclick = () => {
  const b = sheetCtx.u.base;
  if (S.known.has(b)) S.known.delete(b); else S.known.add(b);
  save.known(); renderSheetEntries();
  if (view === 'player') { renderLyrics(); highlight(curLine); }
};
$('#sheetReading').onclick = () => {
  const { li, ui, u } = sheetCtx;
  const k = li + ':' + ui;
  currentSong.overrides = currentSong.overrides || {};
  const r = prompt(`How is 「${u.surface}」 sung here? (hiragana/katakana — blank to reset)`, currentSong.overrides[k] || kataToHira(u.toks.map((t) => t.reading || t.surface_form).join('')));
  if (r === null) return;
  if (r.trim()) currentSong.overrides[k] = r.trim(); else delete currentSong.overrides[k];
  save.songs(); renderLyrics(); highlight(curLine);
};

// ---------- review ----------
let rvCard = null, rvUnits = null, rvTarget = -1;
async function startReview() {
  closeSheet();
  refreshDue();
  const due = dueCards();
  rvCard = due[0] || null;
  $('#reviewEmpty').classList.toggle('hidden', !!rvCard);
  $('#reviewCard').classList.toggle('hidden', !rvCard);
  $('#playerWrap').classList.toggle('hidden', !rvCard);
  if (!rvCard) {
    const next = S.cards.slice().sort((a, b) => a.due - b.due)[0];
    $('#reviewEmptyMsg').textContent = S.cards.length ? (next ? `Next card in ${fmtIvl(next.due - Date.now())}.` : '') + ` ${S.cards.length} cards in deck.` : 'Save words while singing (tap a word → ★) and they show up here.';
    return;
  }
  const song = S.songs.find((s) => s.id === rvCard.songId);
  $('#rvSource').textContent = song ? `${song.title} — ${song.artist}` : '(song deleted)';
  $('#rvBack').classList.add('hidden');
  $('#rvGrades').classList.add('hidden');
  $('#rvShowRow').classList.remove('hidden');
  await tokenizerReady;
  rvUnits = toUnits(rvCard.text);
  rvTarget = rvUnits.findIndex((u) => u.surface === rvCard.surface);
  if (rvTarget < 0) rvTarget = rvUnits.findIndex((u) => u.base === rvCard.word);
  $('#rvSentence').innerHTML = rvUnits.map((u, j) => j === rvTarget
    ? `<span class="u target">${esc(u.surface)}</span>`
    : unitHtml(u, rvCard.line, j, { song, furi: S.settings.furi !== 'off' && showFuri(u), review: true })).join('');
  if (song) { await ensureVideo(song.videoId); playClip(1); }
}
function playClip(rate) {
  const song = S.songs.find((s) => s.id === rvCard.songId);
  if (!song || !ytReady) return;
  const L = song.lines, i = rvCard.line;
  if (!L[i] || L[i].t == null) return;
  const off = song.offset || 0;
  const end = i + 1 < L.length && L[i + 1].t != null ? L[i + 1].t + off : L[i].t + off + 6;
  yt.setPlaybackRate(rate);
  yt.seekTo(Math.max(0, L[i].t + off - 0.2), true);
  clipEnd = end; yt.playVideo();
}
function showAnswer() {
  if (!rvCard) return;
  const c = rvCard;
  const tgt = $('#rvSentence .target');
  if (tgt && rvUnits[rvTarget]) {
    tgt.innerHTML = c.sung && hasKanji(c.surface) ? `<ruby>${esc(c.surface)}<rt>${esc(c.sung)}</rt></ruby>`
      : rvUnits[rvTarget].toks.map((t) => rubyParts(t.surface_form, t.reading).map((p) => p.r ? `<ruby>${esc(p.t)}<rt>${esc(p.r)}</rt></ruby>` : esc(p.t)).join('')).join('');
  }
  $('#rvBack').innerHTML = `<div class="word"><ruby>${esc(c.word)}<rt>${esc(c.reading)}</rt></ruby></div>
    ${c.sung ? `<div class="muted">sung as <b>${esc(c.sung)}</b></div>` : ''}
    ${c.surface !== c.word ? `<div class="muted">${esc(c.surface)} ← ${esc(c.word)}</div>` : ''}
    <ol style="text-align:left;display:inline-block">${(c.senses || []).map((s) => `<li>${s[0] ? `<span class="pos">${esc(s[0])}</span> ` : ''}${esc(s[1])}</li>`).join('') || `<li>${esc(c.gloss)}</li>`}</ol>`;
  $('#rvBack').classList.remove('hidden');
  $('#rvShowRow').classList.add('hidden');
  $$('#rvGrades button').forEach((b) => { b.querySelector('small').textContent = fmtIvl(schedule(c, +b.dataset.g).due - Date.now()); });
  $('#rvGrades').classList.remove('hidden');
}
function grade(g) {
  if (!rvCard || $('#rvGrades').classList.contains('hidden')) return;
  const i = S.cards.findIndex((c) => c.id === rvCard.id);
  S.cards[i] = schedule(rvCard, g);
  save.cards();
  if (playing()) yt.pauseVideo();
  yt.setPlaybackRate(S.settings.rate);
  startReview();
}
$('#rvShow').onclick = showAnswer;
$('#rvPlay').onclick = () => playClip(1);
$('#rvSlow').onclick = () => playClip(0.75);
$$('#rvGrades button').forEach((b) => b.onclick = () => grade(+b.dataset.g));

// ---------- deck ----------
function renderDeck() {
  const byId = Object.fromEntries(S.songs.map((s) => [s.id, s]));
  const cards = S.cards.slice().sort((a, b) => a.due - b.due);
  const due = dueCards().length, mature = cards.filter((c) => c.ivl >= 21).length;
  $('#deckStats').textContent = `${cards.length} cards · ${due} due · ${mature} mature`;
  $('#deckBody').innerHTML = cards.map((c) => `<tr>
    <td class="w"><ruby>${esc(c.word)}<rt>${esc(c.reading)}</rt></ruby></td>
    <td>${esc(c.gloss)}<div class="muted small">「${esc(c.text)}」</div></td>
    <td class="small">${esc((byId[c.songId] || {}).title || '—')}</td>
    <td class="small">${c.due <= Date.now() ? '<b>now</b>' : fmtIvl(c.due - Date.now())}</td>
    <td><button data-del="${c.id}" title="Delete card">🗑</button></td></tr>`).join('');
  $$('#deckBody [data-del]').forEach((b) => b.onclick = () => {
    S.cards = S.cards.filter((c) => c.id !== b.dataset.del); save.cards(); refreshDue(); renderDeck();
  });
  $('#knownList').innerHTML = [...S.known].map((w) => `<span title="click to forget">${esc(w)}</span>`).join('') || '<span class="muted">none yet</span>';
  $$('#knownList span').forEach((s) => s.onclick = () => { S.known.delete(s.textContent); save.known(); renderDeck(); });
  $('#selKanjiLvl').value = String(S.settings.kanjiLvl);
}
$('#selKanjiLvl').onchange = () => { S.settings.kanjiLvl = +$('#selKanjiLvl').value; save.settings(); };
$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ v: 1, songs: S.songs, cards: S.cards, known: [...S.known], settings: S.settings }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `karaoke-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
$('#inImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!confirm(`Replace current data with backup (${d.songs.length} songs, ${d.cards.length} cards)?`)) return;
    S.songs = d.songs; S.cards = d.cards; S.known = new Set(d.known || []); Object.assign(S.settings, d.settings || {});
    save.songs(); save.cards(); save.known(); save.settings(); refreshDue(); renderDeck();
  } catch (err) { alert('Import failed: ' + err.message); }
};

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') return closeSheet();
  if (view === 'player' && currentSong) {
    if (e.code === 'Space') { e.preventDefault(); return syncing ? syncTap() : togglePlay(); }
    if (e.key === 'ArrowLeft') return jumpLine(-1);
    if (e.key === 'ArrowRight') return jumpLine(1);
    if (e.key === 'l') return toggleLoop();
    if (e.key === 's') return toggleShadow();
    if (e.key === 'c') return toggleCloze();
  }
  if (view === 'review' && rvCard) {
    if (e.code === 'Space') { e.preventDefault(); return $('#rvGrades').classList.contains('hidden') ? showAnswer() : grade(2); }
    if (e.key === 'r') return playClip(1);
    if ('1234'.includes(e.key)) return grade(+e.key - 1);
  }
});

// ---------- boot ----------
fetch('data/kanji.json').then((r) => r.json()).then((d) => { KANJI_LVL = d; }).catch(() => {});
refreshDue();
setInterval(refreshDue, 60e3);
show('library');
if (S.songs.some((s) => s.id === store.get('lastSong'))) $('#tabPlayer').disabled = false;
