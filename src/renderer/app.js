'use strict';
/* global api, keys, meta, query, waveform */

const $ = (id) => document.getElementById(id);
const state = {
  root: null,
  tracks: new Map(),
  view: [],            // filtered + sorted ids
  folder: '',          // '' = root
  playlists: [],       // [{ id, name, ids }]
  playlist: null,      // id of the playlist being viewed (instead of a folder)
  special: null,       // 'dups' | 'hist:<session id>': a view of its own (instead of a folder / playlist)
  played: new Set(),   // ids played (>= 30 s) during this session
  history: { sessions: [], counts: {} }, // from main (history.json)
  histOpen: false,     // history sessions listed in the sidebar
  trackStamp: 0,       // bumped on every track change (cache key for duplicates)
  sort: { key: 'title', dir: 1 },
  sort2: null,         // secondary sort (shift-click on a header)
  selected: new Set(),
  anchor: null,        // last clicked id (shift-select)
  cursor: null,        // moving end of a shift selection
  loaded: null,        // id in the deck
  waves: null,         // { overview, detail } of loaded track
  settings: {},
  dirtyView: true,
  dirtyTree: true,
};

const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';
const ROW_H = 34;

// ---------- helpers ----------
// effective metadata (user corrections > tags > online > file name), shared with the exports
const tags = (t) => (t.probe && t.probe.tags) || {};
const fTitle = meta.title;
const fArtist = meta.artist;
const fGenres = meta.genres;
const fStyles = meta.styles;
const fYear = meta.year;
const fLabel = meta.label;
const fDur = meta.duration;
const fmtTime = (s) => { if (s == null || isNaN(s)) return ''; s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtBpm = (b) => (Math.abs(b - Math.round(b)) < 0.005 ? String(Math.round(b)) : b.toFixed(2).replace(/0$/, ''));
const LOSSLESS = new Set(['flac', 'wav', 'aif', 'aiff', 'alac', 'ape', 'wv']);
function fFormat(t) {
  const p = t.probe;
  const ext = t.ext.toUpperCase();
  if (!p) return ext;
  if (LOSSLESS.has(t.ext) || p.codec === 'alac') return `${ext} ${p.bitDepth ? p.bitDepth + '/' : ''}${(p.sampleRate / 1000).toFixed(1).replace('.0', '')}k`;
  return `${ext} ${p.bitrate}k`;
}
function keyColor(cam) {
  const m = /^(\d+)([AB])$/.exec(cam || '');
  if (!m) return '#444';
  const hue = ((+m[1] - 1) * 30 + 150) % 360;
  return `hsl(${hue} ${m[2] === 'B' ? 75 : 60}% ${m[2] === 'B' ? 62 : 55}%)`;
}
const camSort = (c) => { const m = /^(\d+)([AB])$/.exec(c || ''); return m ? +m[1] * 2 + (m[2] === 'B' ? 1 : 0) : 999; };
const miniCache = new WeakMap();
function miniOf(t) {
  if (!t.mini) return null;
  let m = miniCache.get(t);
  if (!m) { const bin = atob(t.mini); m = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) m[i] = bin.charCodeAt(i); miniCache.set(t, m); }
  return m;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- columns ----------
// width: CSS grid track; hidden: not shown until enabled from the header's context menu
const stars = (n) => [1, 2, 3, 4, 5].map((i) => `<span class="star${i <= n ? ' on' : ''}" data-star="${i}">★</span>`).join('');
const COLS = [
  { key: 'status', label: '', width: '18px', sort: (t) => t.status, cell: (t) => `<div class="dot ${t.status}" title="${t.status === 'error' ? esc(t.error) : t.status}"></div>` },
  { key: 'wave', label: 'Waveform', width: '136px', sort: (t) => fDur(t), cell: () => '<canvas></canvas>' },
  { key: 'title', label: 'Titre', width: 'minmax(120px, 2fr)', sort: (t) => meta.fold(fTitle(t)), cell: (t) => `<span${t.meta && t.meta.title ? ' class="edited" title="Titre d\'origine : ' + esc(tags(t).title || t.parsed.title || '–') + '"' : ` title="${esc(t.rel)}"`}>${esc(fTitle(t))}</span>${dupBadge(t)}` },
  { key: 'artist', label: 'Artiste', width: 'minmax(80px, 1.4fr)', sort: (t) => meta.fold(fArtist(t)), cell: (t) => (t.meta && t.meta.artist ? `<span class="edited" title="Artiste d'origine : ${esc(tags(t).artist || t.parsed.artist || '–')}">${esc(fArtist(t))}</span>` : esc(fArtist(t))) },
  { key: 'rating', label: 'Note', width: '78px', sort: (t) => -meta.rating(t), cell: (t) => stars(meta.rating(t)) },
  { key: 'bpm', label: 'BPM', width: '62px', sort: (t) => (t.analysis ? t.analysis.bpm : 1e9), cell: bpmCell },
  { key: 'key', label: 'Key', width: '62px', sort: (t) => camSort(t.analysis && t.analysis.camelot), cell: (t) => (t.analysis ? `<span class="key" style="background:${keyColor(t.analysis.camelot)}">${t.analysis.camelot}</span><span class="key-name">${t.analysis.key}</span>` : '') },
  { key: 'lufs', label: 'LUFS', width: '58px', sort: (t) => (t.analysis && t.analysis.lufs != null ? t.analysis.lufs : -99), cell: (t) => (t.analysis && t.analysis.lufs != null ? t.analysis.lufs.toFixed(1) : '') },
  { key: 'genre', label: 'Genre', width: 'minmax(70px, 1fr)', sort: (t) => (fGenres(t)[0] || '~').toLowerCase(), cell: (t) => `${t.meta && t.meta.genre != null ? '<span class="edited">' : '<span>'}${esc(fGenres(t).join(', '))}</span>${t.onlinePending && !fGenres(t).length ? '<span class="dim">…</span>' : ''}` },
  { key: 'style', label: 'Style', width: 'minmax(70px, 1.2fr)', sort: (t) => (fStyles(t)[0] || '~').toLowerCase(), cell: (t) => esc(fStyles(t).join(', ')) },
  { key: 'comment', label: 'Commentaire', width: 'minmax(80px, 1.2fr)', hidden: true, sort: (t) => meta.fold(meta.comment(t)) || '~', cell: (t) => esc(meta.comment(t)) },
  { key: 'album', label: 'Album', width: 'minmax(70px, 1fr)', hidden: true, sort: (t) => meta.fold(meta.album(t)) || '~', cell: (t) => esc(meta.album(t)) },
  { key: 'time', label: 'Durée', width: '58px', sort: fDur, cell: (t) => (fDur(t) ? fmtTime(fDur(t)) : '') },
  { key: 'year', label: 'Année', width: '52px', sort: (t) => fYear(t) || '9999', cell: (t) => esc(fYear(t)) },
  { key: 'label', label: 'Label', width: 'minmax(60px, 0.9fr)', sort: (t) => (fLabel(t) || '~').toLowerCase(), cell: (t) => esc(fLabel(t)) },
  { key: 'quality', label: 'Qualité', width: '118px', sort: (t) => qualitySort(t), cell: (t) => qualityCell(t) },
  { key: 'fmt', label: 'Format', width: '92px', sort: (t) => t.ext, cell: (t) => esc(fFormat(t)) },
  { key: 'played', label: 'Écoutes', width: '62px', hidden: true, sort: (t) => -(playCount(t) || 0), cell: (t) => playCount(t) || '' },
  { key: 'path', label: 'Chemin', width: 'minmax(100px, 1.5fr)', hidden: true, sort: (t) => t.path.toLowerCase(), cell: (t) => `<span title="${esc(t.path)}">${esc(t.external ? t.path : t.rel)}</span>` },
];
const colByKey = new Map(COLS.map((c) => [c.key, c]));
const defaultCols = () => COLS.filter((c) => !c.hidden).map((c) => c.key);
let visibleCols = COLS.filter((c) => !c.hidden);

function bpmCell(t) {
  const a = t.analysis;
  if (!a) return '';
  const tagBpm = parseFloat(tags(t).tagBpm);
  const diff = tagBpm > 0 && Math.abs(tagBpm - a.bpm) > 1 && Math.abs(tagBpm * 2 - a.bpm) > 1 && Math.abs(tagBpm / 2 - a.bpm) > 1;
  return `<span${a.bpmDetected ? ` class="bpm-fixed" title="Détecté : ${fmtBpm(a.bpmDetected)}"` : ''}>${fmtBpm(a.bpm)}</span>${diff ? `<span class="bpm-tag-diff" title="Tag du fichier : ${tagBpm}">*</span>` : ''}`;
}

// visible columns from the settings (in COLS order), grid template on the list
function applyColumns(keys) {
  const want = new Set((keys && keys.length ? keys : defaultCols()).filter((k) => colByKey.has(k)));
  ['status', 'title'].forEach((k) => want.add(k)); // always shown
  visibleCols = COLS.filter((c) => want.has(c.key));
  document.querySelector('.list').style.setProperty('--cols', visibleCols.map((c) => c.width).join(' '));
  for (const el of rowPool.values()) el._sig = '';
  renderHead();
  lastRange = '';
  schedule();
}
function toggleColumn(key) {
  const keys = key === '*reset' ? defaultCols() : visibleCols.map((c) => c.key);
  if (key !== '*reset') { const i = keys.indexOf(key); if (i >= 0) keys.splice(i, 1); else keys.push(key); }
  state.settings.columns = keys;
  api.setSettings({ columns: keys });
  applyColumns(keys);
}

function renderHead() {
  const mark = (c) => {
    if (state.sort.key === c.key) return ` <b>${state.sort.dir > 0 ? '▲' : '▼'}</b>`;
    if (state.sort2 && state.sort2.key === c.key) return ` <i title="Tri secondaire">²${state.sort2.dir > 0 ? '▲' : '▼'}</i>`;
    return '';
  };
  const headTip = (c) => (c.key === 'quality' ? QUALITY_LEGEND : '<b>' + esc(c.label || 'État') + '</b><br>Clic : trier · ⇧ clic : tri secondaire<br>Clic droit : afficher / masquer des colonnes');
  $('thead').innerHTML = visibleCols.map((c) => `<div data-k="${c.key}" class="${state.sort.key === c.key ? 'sorted' : state.sort2 && state.sort2.key === c.key ? 'sorted2' : ''}" data-tip="${esc(headTip(c))}">${c.label}${mark(c)}</div>`).join('');
}
// click: primary sort · shift-click: secondary sort (Genre then BPM…)
$('thead').addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]');
  if (!k) return;
  const key = k.dataset.k;
  if (e.shiftKey && state.sort.key !== key && state.sort.key !== 'pos') {
    state.sort2 = { key, dir: state.sort2 && state.sort2.key === key ? -state.sort2.dir : 1 };
  } else {
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
    if (!e.shiftKey) state.sort2 = null;
  }
  renderHead();
  invalidate();
});
$('thead').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const shown = new Set(visibleCols.map((c) => c.key));
  api.columnsMenu(COLS.filter((c) => c.label && c.key !== 'title').map((c) => ({ key: c.key, label: c.label, checked: shown.has(c.key) })));
});

const QUALITY_LEGEND = '<b>Qualité du fichier</b><div class="tip-sep"></div>'
  + '<b class="q-bad">✖ Problème</b> : faux lossless, MP3 ré-encodé, bitrate faible<br>'
  + '<b class="q-warn">▲ À vérifier</b> : lossless douteux, bitrate moyen, faux stéréo<br>'
  + '<b class="q-info">• Info</b> : silence au début ou à la fin, mastering saturé ou filtré<br>'
  + '<b class="q-ok">✓ OK</b> : rien à signaler';

// ---------- tooltips ----------
// instant, styled tooltips for [data-tip] (HTML built by us, escaped where it holds file data)
const tipBox = document.createElement('div');
tipBox.className = 'tip hidden';
document.body.appendChild(tipBox);
let tipFor = null, tipTimer = null;
function hideTip() { clearTimeout(tipTimer); tipFor = null; tipBox.classList.add('hidden'); }
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el === tipFor) return;
  hideTip();
  if (!el) return;
  tipFor = el;
  tipTimer = setTimeout(() => {
    if (!el.isConnected) return;
    tipBox.innerHTML = el.dataset.tip;
    tipBox.classList.remove('hidden');
    const r = el.getBoundingClientRect(), b = tipBox.getBoundingClientRect();
    let x = Math.min(window.innerWidth - b.width - 8, Math.max(8, r.left));
    let y = r.bottom + 6;
    if (y + b.height > window.innerHeight - 8) y = Math.max(8, r.top - b.height - 6);
    tipBox.style.left = x + 'px';
    tipBox.style.top = y + 'px';
  }, 180);
});
['mousedown', 'wheel', 'keydown'].forEach((ev) => window.addEventListener(ev, hideTip, true));
$('tbody').addEventListener('scroll', hideTip, { passive: true });

// filled in by the quality / duplicates / history sections below
const Q_ICON = { bad: '✖', warn: '▲', info: '•', ok: '✓' };
const Q_ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
const Q_LABEL = { bad: 'Problème', warn: 'À vérifier', info: 'Info', ok: 'OK' };
// issues, worst first
const issuesOf = (t) => meta.qualityIssues(t).sort((a, b) => Q_ORDER[a.level] - Q_ORDER[b.level]);
function qualityTip(t) {
  const issues = issuesOf(t);
  if (!issues.length) return '<b class="q-ok">✓ Aucun problème détecté</b>';
  return issues.map((i) => `<b class="q-${i.level}">${Q_ICON[i.level]} ${esc(i.text)}</b>${i.why ? '<br>' + esc(i.why) : ''}`).join('<div class="tip-sep"></div>');
}
function qualityCell(t) {
  const lvl = meta.qualityLevel(t);
  if (!lvl) return '';
  const issues = issuesOf(t);
  const label = issues.length ? issues[0].short + (issues.length > 1 ? ` +${issues.length - 1}` : '') : 'OK';
  return `<span class="q q-${lvl}" data-tip="${esc(qualityTip(t))}">${Q_ICON[lvl]} ${esc(label)}</span>`;
}
function qualitySort(t) { const l = meta.qualityLevel(t); return l ? Q_ORDER[l] : 9; }
// duplicates over everything loaded (open folder + playlist tracks), recomputed when tracks change
let dupMap = new Map(), dupStamp = -1;
function dups() {
  if (dupStamp !== state.trackStamp) { dupMap = meta.duplicates([...state.tracks.values()]); dupStamp = state.trackStamp; }
  return dupMap;
}
function dupTip(t, d) {
  const lines = d.ids.map((id, i) => {
    const c = state.tracks.get(id);
    if (!c) return '';
    const q = meta.qualityLevel(c) === 'bad' ? ` · <span class="q-bad">✖ ${esc(issuesOf(c)[0].short)}</span>` : '';
    const mark = i === 0 && d.best ? '<span class="q-ok">✓</span>' : '•';
    return `<div class="${id === t.id ? 'tip-me' : ''}">${mark} ${esc(fFormat(c))} · ${(c.size / 1048576).toFixed(1)} Mo${q}${id === t.id ? ' <i>(celle-ci)</i>' : ''}<br><span class="tip-path">${esc(c.external ? c.path : c.rel)}</span></div>`;
  }).join('');
  return `<b>${d.size} copies de ce titre</b><div class="tip-sep"></div>${lines}`;
}
function dupBadge(t) {
  const d = dups().get(t.id);
  if (!d) return '';
  const label = d.best ? ' · meilleure' : d.tie ? ' · identiques' : '';
  return `<span class="dup${d.best ? ' best' : ''}" data-tip="${esc(dupTip(t, d))}">⧉ ${d.size} copies${label}</span>`;
}
function dupSig(t) { const d = dups().get(t.id); return d ? d.ids.join(',') + (d.best ? 'b' : '') : ''; }
// history (sessions from main) — see the history section below
function playCount(t) { return state.history.counts[t.id] || 0; }
function isPlayed(t) { return state.played.has(t.id); }
function historyRows() {
  const h = state.history.sessions;
  const rows = [`<div class="pl view" data-hist-toggle="1" title="Titres écoutés, par session. Clic droit sur une session : convertir en playlist, exporter, supprimer.">
    <span>🕘</span><span class="nm">Historique</span><span class="ct">${h.length ? (state.histOpen ? '▼' : '▶') : ''}</span></div>`];
  if (state.histOpen) {
    for (const s of h.slice(0, 40)) {
      const when = new Date(s.start).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      rows.push(`<div class="pl view sub ${state.special === 'hist:' + s.id ? 'active' : ''}" data-view="hist:${s.id}"><span class="nm">${s.current ? 'Session en cours' : esc(when)}</span><span class="ct">${s.ids.length}</span></div>`);
    }
  }
  return rows;
}
function historyTracks(id) {
  const s = state.history.sessions.find((x) => x.id === id);
  return s ? s.ids.map((x) => state.tracks.get(x)).filter(Boolean) : [];
}

// ---------- filtering ----------
function inFolder(t) {
  if (t.external) return false; // loaded for a playlist, lives outside the open folder
  const f = state.folder;
  if (!f) return $('recursive').checked || t.dir === '';
  if ($('recursive').checked) return t.dir === f || t.dir.startsWith(f + SEP);
  return t.dir === f;
}

function bpmCompatible(a, b) {
  if (!a || !b) return false;
  return [1, 2, 0.5].some((m) => Math.abs((b * m) / a - 1) <= 0.06);
}

// what the list shows before filters: { list, ordered (has a 'pos' order), grouped (duplicates), terms (smart playlist) }
function viewSource() {
  const pl = currentPlaylist();
  if (pl && pl.query != null) return { list: [...state.tracks.values()], terms: query.parse(pl.query) };
  if (pl) return { list: pl.ids.map((id) => state.tracks.get(id)).filter(Boolean), ordered: true };
  if (state.special === 'dups') { const d = dups(); return { list: [...state.tracks.values()].filter((t) => d.has(t.id)), grouped: true }; }
  if (state.special && state.special.startsWith('hist:')) return { list: historyTracks(state.special.slice(5)), ordered: true };
  return { list: state.tracks.values(), folder: true };
}
const queryCtx = () => ({
  dups: new Set(dups().keys()),
  played: state.played,
  listed: new Set(state.playlists.filter((p) => p.query == null).flatMap((p) => p.ids)),
});

function computeView() {
  const terms = query.parse($('search').value);
  const bMin = parseFloat($('bpmMin').value), bMax = parseFloat($('bpmMax').value);
  const kf = $('keyFilter').value;
  const ref = $('compatible').checked && state.loaded ? state.tracks.get(state.loaded) : null;
  const refA = ref && ref.analysis;
  const src = viewSource();
  const ctx = queryCtx();
  // "Hors playlist": tracks no playlist contains yet (meaningless inside a playlist)
  const listed = src.folder && $('noPlaylist').checked ? ctx.listed : null;
  const out = [];
  for (const t of src.list) {
    if (src.folder && !inFolder(t)) continue;
    if (listed && listed.has(t.id)) continue;
    if (src.terms && !query.matches(t, src.terms, ctx)) continue;
    const a = t.analysis;
    if (!isNaN(bMin) && (!a || a.bpm < bMin)) continue;
    if (!isNaN(bMax) && (!a || a.bpm > bMax)) continue;
    if (kf && (!a || (!kf.startsWith('~') ? a.camelot !== kf : !keys.compatible(kf.slice(1), a.camelot)))) continue;
    if (refA && t.id !== ref.id && (!a || !keys.compatible(refA.camelot, a.camelot) || !bpmCompatible(refA.bpm, a.bpm))) continue;
    if (terms.length && !query.matches(t, terms, ctx)) continue;
    out.push(t);
  }
  if (src.ordered && state.sort.key === 'pos') { // playlist / history order
    state.view = (state.sort.dir > 0 ? out : out.reverse()).map((t) => t.id);
    return;
  }
  if (src.grouped && state.sort.key === 'dup') { // copies together, best one first
    const d = dups();
    const rankIn = (t) => d.get(t.id).ids.indexOf(t.id);
    out.sort((a, b) => d.get(a.id).group.localeCompare(d.get(b.id).group) || rankIn(a) - rankIn(b));
    state.view = out.map((t) => t.id);
    return;
  }
  const col = colByKey.get(state.sort.key) || colByKey.get('title');
  const col2 = state.sort2 && colByKey.get(state.sort2.key);
  const dir = colByKey.has(state.sort.key) ? state.sort.dir : 1, dir2 = col2 ? state.sort2.dir : 1;
  const keyed = out.map((t) => [col.sort(t), col2 ? col2.sort(t) : 0, meta.fold(fTitle(t)), t]);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  keyed.sort((x, y) => cmp(x[0], y[0]) * dir || cmp(x[1], y[1]) * dir2 || cmp(x[2], y[2]));
  state.view = keyed.map((x) => x[3].id);
}

function invalidate() { state.dirtyView = true; schedule(); }
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (state.dirtyTree) { renderTree(); renderPlaylists(); state.dirtyTree = false; }
    if (state.dirtyView) { computeView(); state.dirtyView = false; }
    renderRows(true);
  });
}

// ---------- virtual table ----------
const tbody = $('tbody');
const rowPool = new Map(); // index -> element
let lastRange = '';

function rowHtml(t) {
  return visibleCols.map((c) => `<div class="c-${c.key}">${c.cell(t)}</div>`).join('');
}

function renderRows(force) {
  $('spacer').style.height = state.view.length * ROW_H + 'px';
  renderEmpty();
  const top = tbody.scrollTop, h = tbody.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW_H) - 4);
  const last = Math.min(state.view.length, Math.ceil((top + h) / ROW_H) + 4);
  const range = `${first}-${last}`;
  if (!force && range === lastRange) return;
  lastRange = range;
  const keep = new Set();
  for (let i = first; i < last; i++) {
    keep.add(i);
    const t = state.tracks.get(state.view[i]);
    let el = rowPool.get(i);
    if (!el) {
      el = document.createElement('div');
      el.className = 'row trow';
      el.style.top = i * ROW_H + 'px';
      el.draggable = true;
      tbody.appendChild(el);
      rowPool.set(i, el);
    }
    const sig = `${t.id}|${t.edit ? JSON.stringify(t.edit) : ''}|${t.meta ? JSON.stringify(t.meta) : ''}|${t.analysis ? t.analysis.version : 0}|${t.status}|${t.onlinePending}|${t.online ? t.online.fetchedAt : 0}|${t.probe ? 1 : 0}|${t.quality ? t.quality.v : 0}|${dupSig(t)}|${playCount(t) || 0}|${isPlayed(t) ? 1 : 0}`;
    if (el._sig !== sig) {
      el._sig = sig;
      el.dataset.id = t.id;
      el.innerHTML = rowHtml(t);
      const cv = el.querySelector('canvas');
      if (cv) waveform.drawMini(cv, miniOf(t));
    }
    el.classList.toggle('sel', state.selected.has(t.id));
    el.classList.toggle('loaded', state.loaded === t.id);
    el.classList.toggle('played', isPlayed(t));
  }
  for (const [i, el] of rowPool) if (!keep.has(i)) { el.remove(); rowPool.delete(i); }
}
function renderEmpty() {
  const pl = currentPlaylist();
  const folderTracks = [...state.tracks.values()].some((t) => !t.external);
  const plain = pl && pl.query == null;
  let show = !folderTracks, big = state.root && !folderTracks ? 'Aucun fichier audio trouvé ici' : 'Ouvre un dossier de musique';
  if (plain) { show = !pl.ids.length; big = 'Playlist vide'; }
  else if (pl || state.special) { show = !state.view.length; big = pl ? 'Aucun titre ne correspond à cette recherche' : state.special === 'dups' ? 'Aucun doublon' : 'Session vide'; }
  $('emptyState').classList.toggle('hidden', !show);
  $('emptyBig').textContent = big;
  $('emptyText').classList.toggle('hidden', !!(pl || state.special));
  $('btnOpen2').classList.toggle('hidden', !!(pl || state.special));
  $('emptyPl').classList.toggle('hidden', !plain);
}

tbody.addEventListener('scroll', () => renderRows(false), { passive: true });
window.addEventListener('resize', () => { lastRange = ''; renderRows(true); drawDeck(); });

function rowFromEvent(e) { const r = e.target.closest('.trow'); return r ? r.dataset.id : null; }

// Pressing a row that is part of a multi-selection keeps the selection so it can be dragged as a
// whole; the click only narrows it down on release (Finder behaviour).
let pendingClick = null;
let ctrlClick = false; // macOS turns Ctrl+click into a context menu too: here it only toggles the selection
function rowClick(id, e, frac) {
  select(id, e);
  if (frac != null) loadTrack(id, { play: true, at: frac }); // mini waveform: load and play from that point
}
tbody.addEventListener('mousedown', (e) => {
  const id = rowFromEvent(e);
  if (id && e.button === 0 && e.target.dataset.star) { // star in the rating column
    e.preventDefault();
    const ids = state.selected.has(id) && state.selected.size > 1 ? [...state.selected] : [id];
    const t = state.tracks.get(id), n = +e.target.dataset.star;
    setRating(ids, t && meta.rating(t) === n ? 0 : n); // clicking the current rating clears it
    return;
  }
  ctrlClick = e.button === 0 && e.ctrlKey; // reset by any other press (right click, Windows Ctrl+click)
  if (!id || e.button !== 0) return;
  let frac = null;
  if (e.target.tagName === 'CANVAS') {
    const rect = e.target.getBoundingClientRect();
    frac = (e.clientX - rect.left) / rect.width;
  }
  const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey;
  if (plain && state.selected.size > 1 && state.selected.has(id)) { pendingClick = { id, frac }; return; }
  pendingClick = null;
  rowClick(id, e, frac);
});
window.addEventListener('mouseup', () => {
  if (!pendingClick) return;
  const { id, frac } = pendingClick;
  pendingClick = null;
  rowClick(id, {}, frac);
});
tbody.addEventListener('dblclick', (e) => { const id = rowFromEvent(e); if (id) loadTrack(id, { play: true }); });
tbody.addEventListener('contextmenu', (e) => {
  const id = rowFromEvent(e);
  if (ctrlClick) { ctrlClick = false; e.preventDefault(); return; }
  if (!id) return;
  if (!state.selected.has(id)) select(id, {}, { load: false }); // right click selects, never loads
  api.contextMenu([...state.selected], state.playlist);
});
// rows are dragged as real files (drop into rekordbox, the Finder… or onto a playlist)
let dragIds = null;
tbody.addEventListener('dragstart', (e) => {
  const id = rowFromEvent(e);
  if (!id) return;
  e.preventDefault();
  pendingClick = null; // it was a drag, not a click
  const ids = state.selected.has(id) ? state.view.filter((x) => state.selected.has(x)) : [id];
  dragIds = ids;
  api.startDrag(ids, dragImage(ids));
});

// Finder-like drag label: a record, the title and artist (or the number of tracks), drawn at 2×
function dragImage(ids) {
  const W = 240, H = 44, R = 2;
  const c = document.createElement('canvas');
  c.width = W * R; c.height = H * R;
  const g = c.getContext('2d');
  g.scale(R, R);
  g.fillStyle = 'rgba(27, 30, 36, 0.94)';
  g.strokeStyle = '#2fb5ff';
  g.lineWidth = 1;
  g.beginPath(); g.roundRect(0.5, 0.5, W - 1, H - 1, 8); g.fill(); g.stroke();
  // record with a coloured label (key colour of the first track)
  const t = state.tracks.get(ids[0]);
  const cx = 22, cy = H / 2;
  g.fillStyle = '#0b0c0f'; g.beginPath(); g.arc(cx, cy, 15, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const r of [12, 9.5]) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = keyColor(t && t.analysis && t.analysis.camelot);
  g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0b0c0f'; g.beginPath(); g.arc(cx, cy, 1.4, 0, Math.PI * 2); g.fill();
  const fit = (txt, w) => { if (g.measureText(txt).width <= w) return txt; while (txt && g.measureText(txt + '…').width > w) txt = txt.slice(0, -1); return txt + '…'; };
  const x = 46, w = W - x - 10;
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  g.textBaseline = 'middle';
  g.font = `600 13px ${font}`; g.fillStyle = '#e7e9ee';
  g.fillText(fit(ids.length > 1 ? `${ids.length} titres` : t ? fTitle(t) : '', w), x, 16);
  g.font = `11.5px ${font}`; g.fillStyle = '#8b919e';
  const sub = ids.length > 1 ? (t ? `${fTitle(t)}, …` : '') : t ? [fArtist(t), t.analysis && fmtBpm(t.analysis.bpm) + ' BPM'].filter(Boolean).join(' · ') : '';
  g.fillText(fit(sub, w), x, 31);
  return c.toDataURL('image/png');
}

// anchor = where a shift range starts, cursor = its moving end (shift + arrows)
function rangeAnchor() {
  for (const id of [state.anchor, state.loaded]) if (id && state.view.includes(id)) return id;
  return null;
}
function selectRange(id) {
  const a = state.view.indexOf(state.anchor), b = state.view.indexOf(id);
  state.selected = new Set(state.view.slice(Math.min(a, b), Math.max(a, b) + 1));
  state.cursor = id;
}

function select(id, e, { load = true } = {}) {
  if (e.shiftKey && rangeAnchor()) {
    state.anchor = rangeAnchor();
    selectRange(id);
  } else if (e.metaKey || e.ctrlKey) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    state.anchor = state.cursor = id;
  } else {
    state.selected = new Set([id]);
    state.anchor = state.cursor = id;
    // browsing: single click loads into the deck, keeps playing if we were playing
    if (load) loadTrack(id, { play: !audio.paused });
  }
  renderRows(true);
}

// shift extends the selection from the anchor without loading the track
function moveSelection(delta, extend = false) {
  if (!state.view.length) return;
  const from = extend && rangeAnchor() ? (state.view.includes(state.cursor) ? state.cursor : rangeAnchor()) : state.anchor;
  let i = state.view.indexOf(from);
  i = i < 0 ? 0 : Math.max(0, Math.min(state.view.length - 1, i + delta));
  const id = state.view[i];
  if (extend && rangeAnchor()) { state.anchor = rangeAnchor(); selectRange(id); renderRows(true); } else select(id, {});
  const y = i * ROW_H;
  if (y < tbody.scrollTop) tbody.scrollTop = y;
  else if (y + ROW_H > tbody.scrollTop + tbody.clientHeight) tbody.scrollTop = y + ROW_H - tbody.clientHeight;
}

// ---------- folder tree ----------
function buildTree() {
  const root = { name: state.root ? state.root.split(SEP).pop() : '', path: '', kids: new Map(), count: 0, own: 0 };
  for (const t of state.tracks.values()) {
    if (t.external) continue;
    root.count++;
    if (!t.dir) { root.own++; continue; }
    let node = root;
    let acc = '';
    for (const part of t.dir.split(SEP)) {
      acc = acc ? acc + SEP + part : part;
      if (!node.kids.has(part)) node.kids.set(part, { name: part, path: acc, kids: new Map(), count: 0, own: 0 });
      node = node.kids.get(part);
      node.count++;
    }
    node.own++;
  }
  return root;
}
const openNodes = new Set(['']);
function renderTree() {
  const root = buildTree();
  const html = (n, depth) => {
    const kids = [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const open = openNodes.has(n.path);
    return `<div class="node ${open ? '' : 'closed'}" data-path="${esc(n.path)}">
      <div class="lbl ${!state.playlist && !state.special && state.folder === n.path ? 'active' : ''}"><span class="tw">${kids.length ? (open ? '▼' : '▶') : ''}</span><span class="nm">${depth === 0 ? '🎧 ' : '📁 '}${esc(n.name || 'Dossier')}</span><span class="ct">${n.count}</span></div>
      ${kids.length ? `<div class="kids">${kids.map((k) => html(k, depth + 1)).join('')}</div>` : ''}
    </div>`;
  };
  $('tree').innerHTML = state.root ? html(root, 0) : '';
}
$('tree').addEventListener('click', (e) => {
  const node = e.target.closest('.node');
  if (!node) return;
  const p = node.dataset.path;
  if (e.target.classList.contains('tw')) {
    if (openNodes.has(p)) openNodes.delete(p); else openNodes.add(p);
  } else {
    state.folder = p;
    if (state.playlist || state.special) showPlaylist(null);
    openNodes.add(p);
    api.focus(p, $('recursive').checked);
    tbody.scrollTop = 0;
  }
  state.dirtyTree = true;
  invalidate();
});

// ---------- playlists ----------
const currentPlaylist = () => (state.playlist && state.playlists.find((p) => p.id === state.playlist)) || null;

function renderPlaylists() {
  const ctx = queryCtx();
  const all = [...state.tracks.values()];
  const html = state.playlists.map((p) => {
    if (p.query != null) { // smart playlist: count what its search matches right now
      const terms = query.parse(p.query);
      const n = all.filter((t) => query.matches(t, terms, ctx)).length;
      return `<div class="pl smart ${p.id === state.playlist ? 'active' : ''}" data-id="${p.id}" title="${esc(p.name)} · recherche : ${esc(p.query)}">
      <span>✦</span><span class="nm">${esc(p.name)}</span><span class="ct">${n}</span></div>`;
    }
    const missing = p.ids.filter((id) => !state.tracks.has(id)).length;
    return `<div class="pl ${p.id === state.playlist ? 'active' : ''}" data-id="${p.id}" title="${esc(p.name)}">
      <span>♫</span><span class="nm">${esc(p.name)}</span>
      ${missing ? `<span class="ct miss" title="${missing} fichier(s) introuvable(s) (déplacé ou supprimé)">⚠ ${missing}</span>` : ''}
      <span class="ct">${p.ids.length}</span></div>`;
  }).join('');
  $('plList').innerHTML = html || '<div class="pl-empty">Aucune playlist. ＋ pour en créer une.</div>';
  renderViews();
}

// ---------- views: duplicates, history ----------
function renderViews() {
  const groups = new Set([...dups().values()].map((d) => d.group)).size;
  const rows = [`<div class="pl view ${state.special === 'dups' ? 'active' : ''}" data-view="dups" data-tip="${esc('<b>Doublons</b><br>Titres présents en plusieurs exemplaires. « meilleure » : la copie à garder.')}">
    <span>⧉</span><span class="nm">Doublons</span><span class="ct">${groups || ''}</span></div>`];
  rows.push(...historyRows());
  $('views').innerHTML = rows.join('');
}
function showSpecial(key) {
  state.special = key;
  state.playlist = null;
  $('noPlaylist').parentElement.classList.toggle('off', !!key);
  state.sort = key === 'dups' ? { key: 'dup', dir: 1 } : key ? { key: 'pos', dir: 1 } : { key: 'title', dir: 1 };
  state.sort2 = null;
  state.selected.clear();
  tbody.scrollTop = 0;
  renderHead();
  state.dirtyTree = true;
  invalidate();
}
$('views').addEventListener('click', async (e) => {
  if (e.target.closest('[data-hist-toggle]')) { state.histOpen = !state.histOpen; renderViews(); return; }
  const el = e.target.closest('[data-view]');
  if (!el) return;
  if (el.dataset.view.startsWith('hist:')) await api.historyOpen(el.dataset.view.slice(5)); // load tracks from other folders
  showSpecial(el.dataset.view);
});

// a track counts as played after 30 s of actual playback (seeking around doesn't count)
const PLAYED_AFTER = 30;
const listen = { id: null, secs: 0, last: null };
const player = $('audio'); // (the deck's `audio` constant is declared further down)
player.addEventListener('timeupdate', () => {
  const id = player.dataset.id, now = player.currentTime;
  if (id !== listen.id) { listen.id = id; listen.secs = 0; listen.last = now; return; }
  const d = now - listen.last;
  listen.last = now;
  if (player.paused || d <= 0 || d > 1) return;
  listen.secs += d;
  if (listen.secs >= PLAYED_AFTER && !state.played.has(id)) { state.played.add(id); api.historyAdd(id); }
});
function applyHistory(h) {
  state.history = h;
  state.played = new Set(h.current);
  for (const el of rowPool.values()) el._sig = '';
  state.dirtyTree = true;
  invalidate();
}
api.onHistory(applyHistory);
api.onHistoryToPlaylist((id) => showPlaylist(id));
api.history().then(applyHistory);
$('views').addEventListener('contextmenu', (e) => { const el = e.target.closest('[data-view^="hist:"]'); if (el) api.historyMenu(el.dataset.view.slice(5)); });

function showPlaylist(id) {
  state.playlist = id;
  state.special = null;
  $('noPlaylist').parentElement.classList.toggle('off', !!id); // no effect inside a playlist
  if (id) state.sort = { key: 'pos', dir: 1 };
  else if (state.sort.key === 'pos') state.sort = { key: 'title', dir: 1 };
  state.selected.clear();
  tbody.scrollTop = 0;
  renderHead();
  state.dirtyTree = true;
  invalidate();
}

// small modal asking for a name; resolves to the trimmed name or null
function askName(title, value = '') {
  return new Promise((resolve) => {
    const dlg = $('nameDlg');
    $('nameTitle').textContent = title;
    $('nameInput').value = value;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      const v = $('nameInput').value.trim();
      resolve(dlg.returnValue === 'ok' && v ? v : null);
    }, { once: true });
    dlg.showModal();
    $('nameInput').select();
  });
}

async function newPlaylist(ids = []) {
  const name = await askName('Nouvelle playlist');
  if (!name) return;
  const id = await api.createPlaylist(name, ids);
  if (!ids.length) showPlaylist(id);
}

$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('nameDlg').close('ok'); } });
$('btnNewPl').addEventListener('click', () => api.newPlaylistMenu($('search').value.trim()));
api.onNewSmartPlaylist(async () => {
  const q = await askName('Playlist intelligente : recherche', $('search').value.trim());
  if (!q) return;
  const name = await askName('Nom de la playlist intelligente', q);
  if (!name) return;
  showPlaylist(await api.createPlaylist(name, [], q));
  $('search').value = '';
  invalidate();
});
api.onEditPlaylistQuery(async (id) => {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  const q = await askName(`Recherche de « ${p.name} »`, p.query);
  if (q) api.setPlaylistQuery(id, q);
});
$('plList').addEventListener('click', (e) => {
  const el = e.target.closest('.pl');
  if (!el) return;
  if (el.dataset.id === state.playlist && state.sort.key !== 'pos') { state.sort = { key: 'pos', dir: 1 }; renderHead(); invalidate(); return; } // back to playlist order
  showPlaylist(el.dataset.id);
});
$('plList').addEventListener('dblclick', (e) => { const el = e.target.closest('.pl'); if (el) renamePlaylist(el.dataset.id); });
$('plList').addEventListener('contextmenu', (e) => { const el = e.target.closest('.pl'); if (el) api.playlistMenu(el.dataset.id); });

async function renamePlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  const name = await askName('Renommer la playlist', p.name);
  if (name) api.renamePlaylist(id, name);
}

// drop: tracks from the list, or files / folders from the disk
function dropInto(playlistId, e) {
  const files = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (files.length) {
    api.addFilesToPlaylist(playlistId, files).then((n) => flash(n ? `${n} titre(s) ajouté(s)` : 'Déjà dans la playlist'));
  } else if (dragIds) {
    api.addToPlaylist(playlistId, dragIds);
  }
  dragIds = null;
}
const accepts = (e) => [...e.dataTransfer.types].includes('Files') || dragIds;
$('plList').addEventListener('dragover', (e) => {
  const el = e.target.closest('.pl:not(.smart)');
  document.querySelectorAll('.pl.drop').forEach((x) => x !== el && x.classList.remove('drop'));
  if (!el || !accepts(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  el.classList.add('drop');
});
$('plList').addEventListener('dragleave', (e) => { if (!$('plList').contains(e.relatedTarget)) document.querySelectorAll('.pl.drop').forEach((x) => x.classList.remove('drop')); });
$('plList').addEventListener('drop', (e) => {
  e.preventDefault();
  document.querySelectorAll('.pl.drop').forEach((x) => x.classList.remove('drop'));
  const el = e.target.closest('.pl:not(.smart)');
  if (el) dropInto(el.dataset.id, e);
});
// files dropped on the list while a playlist is shown go into it
const listEl = document.querySelector('.list');
const dropTarget = () => { const p = currentPlaylist(); return p && p.query == null ? p : null; };
listEl.addEventListener('dragover', (e) => {
  if (!dropTarget() || !accepts(e)) return;
  // reordering: the row under the pointer shows where the dragged tracks land
  markDropRow(e);
  e.preventDefault();
  listEl.classList.add('drop');
});
listEl.addEventListener('dragleave', (e) => { if (!listEl.contains(e.relatedTarget)) { listEl.classList.remove('drop'); clearDropRow(); } });
listEl.addEventListener('drop', (e) => {
  listEl.classList.remove('drop');
  if (!dropTarget()) return;
  e.preventDefault();
  const at = dropIndex(e);
  clearDropRow();
  // tracks dragged from this very playlist (in playlist order): move them; anything else: add
  if (dragIds && state.sort.key === 'pos' && dragIds.every((id) => dropTarget().ids.includes(id))) {
    const order = dropTarget().ids.filter((id) => !dragIds.includes(id));
    const before = state.view[at];
    api.movePlaylistTracks(state.playlist, dragIds, before ? order.indexOf(before) : order.length);
    dragIds = null;
    return;
  }
  dropInto(state.playlist, e);
});
window.addEventListener('dragover', (e) => e.preventDefault()); // a stray drop never navigates away
window.addEventListener('drop', (e) => { e.preventDefault(); dragIds = null; });

// drop position in the list for reordering: index of the row the dragged tracks go before
function dropIndex(e) {
  const r = tbody.getBoundingClientRect();
  return Math.max(0, Math.min(state.view.length, Math.round((e.clientY - r.top + tbody.scrollTop) / ROW_H)));
}
function markDropRow(e) {
  if (state.sort.key !== 'pos' || !dragIds) return clearDropRow();
  $('dropLine').style.top = dropIndex(e) * ROW_H - tbody.scrollTop + 'px';
  $('dropLine').classList.remove('hidden');
}
function clearDropRow() { $('dropLine').classList.add('hidden'); }

function removeSelectedFromPlaylist() {
  if (!dropTarget() || !state.selected.size) return;
  api.removeFromPlaylist(state.playlist, [...state.selected]);
  state.selected.clear();
}

let flashTimer;
let statusHold = 0; // until then, library stats don't overwrite the message on the right of the status bar
function flash(msg) {
  statusHold = Date.now() + 4000; $('statusRight').textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if ($('statusRight').textContent === msg) $('statusRight').textContent = ''; }, 4000);
}

api.onPlaylists((list) => {
  state.playlists = list;
  if (state.playlist && !currentPlaylist()) showPlaylist(null);
  state.dirtyTree = true;
  invalidate();
});
api.onNewPlaylist((ids) => newPlaylist(ids));
api.onRenamePlaylist((id) => renamePlaylist(id));

// ---------- deck / player ----------
const audio = $('audio');
audio.volume = 0.9;
let loadSeq = 0;
let dragging = null;

async function loadTrack(id, { play = false, at = 0 } = {}) {
  const t = state.tracks.get(id);
  if (!t) return;
  const seq = ++loadSeq;
  if (state.loaded !== id) {
    state.loaded = id;
    state.waves = null;
    renderDeckInfo(t);
    const needsTranscode = ['aif', 'aiff', 'wma', 'ape', 'wv', 'alac'].includes(t.ext);
    let src = t.fileUrl;
    if (needsTranscode) {
      $('status').textContent = 'Préparation de la lecture (conversion)…';
      src = await api.playable(id).catch(() => null);
      $('status').textContent = '';
      if (seq !== loadSeq) return;
    }
    audio.src = src || t.fileUrl;
    audio.dataset.id = id;
    audio.dataset.fallback = needsTranscode ? '1' : '';
    api.waves(id).then((w) => { if (seq === loadSeq) { state.waves = w; drawDeck(); } });
    api.cover(id).then((url) => {
      if (seq !== loadSeq) return;
      const img = $('cover');
      img.classList.remove('ok');
      if (url) { img.onload = () => img.classList.add('ok'); img.src = url; } else img.removeAttribute('src');
    });
    if ($('compatible').checked) invalidate();
    renderRows(true);
  }
  const dur = fDur(t);
  if (at && dur) {
    const seek = () => { audio.currentTime = at * (audio.duration || dur); };
    if (audio.readyState >= 1) seek(); else audio.addEventListener('loadedmetadata', seek, { once: true });
  }
  if (play) audio.play().catch(() => {});
  drawDeck();
}

audio.addEventListener('error', async () => {
  const id = audio.dataset.id;
  if (!id || audio.dataset.fallback) return;
  audio.dataset.fallback = '1';
  const src = await api.playable(id).catch(() => null);
  if (src && audio.dataset.id === id) { audio.src = src; audio.play().catch(() => {}); }
});

function renderDeckInfo(t) {
  $('deck').classList.toggle('empty', !t);
  if (!t) return;
  const a = t.analysis || {};
  const tg = tags(t);
  const o = t.online || {};
  $('dTitle').textContent = fTitle(t);
  $('dTitle').title = t.path;
  $('dArtist').textContent = [fArtist(t), tg.album || o.album].filter(Boolean).join(' — ');
  $('dBpm').textContent = a.bpm ? fmtBpm(a.bpm) : '…';
  $('dBpm').classList.toggle('bpm-fixed', !!a.bpmDetected);
  $('dBpm').title = (a.bpmDetected ? `Corrigé à la main (détecté : ${fmtBpm(a.bpmDetected)}). ` : '') + 'Cliquer pour saisir le BPM';
  $('gAuto').classList.toggle('edited', !!t.edit);
  $('dKey').innerHTML = a.camelot ? `<span class="key" style="background:${keyColor(a.camelot)}">${a.camelot}</span> <span class="key-name">${a.key}</span>` : '…';
  $('dLufs').textContent = a.lufs != null ? a.lufs.toFixed(1) : '…';
  $('dRating').innerHTML = stars(meta.rating(t));
  const chips = [
    ...fGenres(t).map((g) => `<span class="chip">${esc(g)}</span>`),
    ...fStyles(t).map((s) => `<span class="chip style">${esc(s)}</span>`),
  ];
  if (tg.grouping) chips.push(`<span class="chip tag">${esc(tg.grouping)}</span>`);
  if (!chips.length && t.onlinePending) chips.push('<span class="chip tag">recherche en ligne…</span>');
  if (!chips.length && o.notFound) chips.push('<span class="chip tag">introuvable en ligne</span>');
  $('dChips').innerHTML = chips.join('');
  $('dChips').title = [...fGenres(t), ...fStyles(t)].join(', '); // full list when chips are clipped
  const lines = [];
  const yl = [fYear(t), fLabel(t), o.country].filter(Boolean).join(' · ');
  if (yl) lines.push(yl);
  lines.push(`${fFormat(t)} · ${(t.size / 1048576).toFixed(1)} Mo${a.lra != null ? ` · LRA ${a.lra} LU` : ''}`);
  meta.comment(t)
    ? lines.push(`<span class="d-comment" title="Cliquer pour modifier">💬 ${esc(meta.comment(t))}</span>`)
    : lines.push('<span class="d-comment add">＋ commentaire</span>');
  const tagInfo = [tg.tagBpm && `BPM ${tg.tagBpm}`, tg.tagKey && `Key ${tg.tagKey}`].filter(Boolean).join(', ');
  if (tagInfo) lines.push(`Tags du fichier : ${tagInfo}`);
  if (a.bpm && a.gridRmsMs != null) {
    const parts = [a.tempoStable ? `Grille : tempo stable (écart moyen ${a.gridRmsMs} ms)` : `<span class="grid-warn">⚠ Tempo variable (dérive ${a.gridDriftMs} ms) : grille approximative</span>`];
    if (!a.gridEdited) parts.push(a.downbeatConfidence >= 0.2 ? '1er temps détecté' : '<span class="grid-warn">1er temps incertain, à vérifier</span>');
    else parts.push('calage manuel');
    lines.push(parts.join(' · '));
  }
  const links = [o.discogsUrl && `<a data-href="${esc(o.discogsUrl)}">Discogs ↗</a>`, o.mbUrl && `<a data-href="${esc(o.mbUrl)}">MusicBrainz ↗</a>`].filter(Boolean);
  if (links.length) lines.push(links.join(' &nbsp; '));
  for (const i of issuesOf(t)) lines.push(`<span class="q-${i.level}" data-tip="${esc(`<b class="q-${i.level}">${Q_ICON[i.level]} ${esc(i.text)}</b><br>${esc(i.why)}`)}">${Q_ICON[i.level]} ${esc(i.text)}</span>`);
  if (t.error) lines.push(`<span style="color:#ff4d5e">Erreur : ${esc(t.error)}</span>`);
  $('dMeta').innerHTML = lines.join('<br>');
}
$('dMeta').addEventListener('click', (e) => { const a = e.target.closest('a[data-href]'); if (a) api.openExternal(a.dataset.href); });

function zoomSeconds() { return +$('zoom').value; }

function drawDeck() {
  const t = state.loaded && state.tracks.get(state.loaded);
  const dur = audio.duration || (t && fDur(t)) || 0;
  const time = audio.currentTime || 0;
  const w = state.waves;
  const zs = zoomSeconds();
  waveform.drawOverview($('overWave'), w && w.overview, dur ? time / dur : 0, { window: dur ? [(time - zs / 2) / dur, (time + zs / 2) / dur] : null, analysis: t && t.analysis, duration: dur });
  waveform.drawZoom($('zoomWave'), w && w.detail, time, zs, t && t.analysis);
  $('tPos').textContent = fmtTime(time);
  $('tDur').textContent = fmtTime(dur);
  $('btnPlay').textContent = audio.paused ? '▶' : '❚❚';
}

function loop() {
  if (!audio.paused || dragging) drawDeck();
  metroTick();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop); // first frame runs after the whole script (metronome) is defined
['pause', 'play', 'seeked', 'loadedmetadata'].forEach((ev) => audio.addEventListener(ev, drawDeck));
audio.addEventListener('ended', () => moveSelection(1)); // auto-advance like a crate preview

$('btnPlay').addEventListener('click', togglePlay);
function togglePlay() {
  if (!state.loaded) { if (state.view[0]) loadTrack(state.view[0], { play: true }); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
$('overWave').addEventListener('mousedown', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
// drag the zoomed waveform to scrub (like a jog wheel)
$('zoomWave').addEventListener('mousedown', (e) => { dragging = { x: e.clientX, t: audio.currentTime, wasPlaying: !audio.paused }; audio.pause(); });
window.addEventListener('mousemove', (e) => {
  if (!dragging || !audio.duration) return;
  const w = $('zoomWave').clientWidth;
  audio.currentTime = Math.max(0, Math.min(audio.duration, dragging.t - ((e.clientX - dragging.x) / w) * zoomSeconds()));
});
window.addEventListener('mouseup', () => { if (dragging) { if (dragging.wasPlaying) audio.play(); dragging = null; } });
$('zoomWave').addEventListener('wheel', (e) => {
  e.preventDefault();
  const z = $('zoom');
  z.value = Math.max(+z.min, Math.min(+z.max, +z.value + Math.sign(e.deltaY)));
  drawDeck();
}, { passive: false });
$('zoom').addEventListener('input', drawDeck);
$('volume').addEventListener('input', (e) => { audio.volume = +e.target.value; });

// ---------- BPM x2 / ÷2 ----------
// applies to the selection, or to the track in the deck when nothing is selected
function fixBpm(factor) {
  const ids = state.selected.size ? [...state.selected] : state.loaded ? [state.loaded] : [];
  if (ids.length) api.setBpm(ids, factor);
}
$('bpmDouble').addEventListener('click', () => state.loaded && api.setBpm([state.loaded], 2));
$('bpmHalf').addEventListener('click', () => state.loaded && api.setBpm([state.loaded], 0.5));

// ---------- manual BPM ----------
function startBpmEdit() {
  const t = state.loaded && state.tracks.get(state.loaded);
  if (!t || !t.analysis) return;
  const inp = $('bpmInput');
  inp.value = fmtBpm(t.analysis.bpm);
  $('dBpm').classList.add('hidden');
  inp.classList.remove('hidden');
  inp.focus();
  inp.select();
}
function endBpmEdit(commit) {
  const inp = $('bpmInput');
  if (inp.classList.contains('hidden')) return;
  inp.classList.add('hidden');
  $('dBpm').classList.remove('hidden');
  const v = parseFloat(inp.value.replace(',', '.'));
  if (commit && state.loaded && v >= 30 && v <= 300) api.setGrid(state.loaded, { bpm: v });
}
$('dBpm').addEventListener('click', startBpmEdit);
$('bpmInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); endBpmEdit(true); }
  else if (e.key === 'Escape') { e.preventDefault(); endBpmEdit(false); }
  e.stopPropagation();
});
$('bpmInput').addEventListener('blur', () => endBpmEdit(true));

// ---------- rating, comment, info ----------
// applies to the selection, or to the track in the deck when nothing is selected
const targetIds = () => (state.selected.size ? [...state.selected] : state.loaded ? [state.loaded] : []);
function setRating(ids, n) { if (ids.length) api.setMeta(ids, { rating: n }); }
$('dRating').addEventListener('click', (e) => {
  const st = e.target.dataset.star, t = state.loaded && state.tracks.get(state.loaded);
  if (st && t) setRating([t.id], meta.rating(t) === +st ? 0 : +st);
});
$('dMeta').addEventListener('click', (e) => { if (e.target.closest('.d-comment') && state.loaded) editInfo([state.loaded], 'iComment'); });

// one dialog for title / artist / genre / comment, single track or a batch
const INFO = [['title', 'iTitle'], ['artist', 'iArtist'], ['genre', 'iGenre'], ['comment', 'iComment']];
const fileValue = { title: (t) => tags(t).title || t.parsed.title || t.name, artist: (t) => tags(t).artist || t.parsed.artist || '', genre: (t) => meta.genres({ ...t, meta: null }).join(', '), comment: () => '' };
const shownValue = { title: fTitle, artist: fArtist, genre: (t) => fGenres(t).join(', '), comment: meta.comment };
function editInfo(ids, focus = 'iTitle') {
  const tracks = ids.map((id) => state.tracks.get(id)).filter(Boolean);
  if (!tracks.length) return;
  const dlg = $('infoDlg');
  $('infoTitle').textContent = tracks.length > 1 ? `Modifier les infos de ${tracks.length} titres` : 'Modifier les infos';
  const initial = {};
  for (const [f, el] of INFO) {
    const vals = [...new Set(tracks.map(shownValue[f]))];
    const inp = $(el);
    inp.dataset.reset = '';
    inp.classList.remove('reset');
    initial[f] = vals.length === 1 ? vals[0] : '';
    inp.value = initial[f];
    inp.placeholder = vals.length > 1 ? '(plusieurs valeurs : laisser vide pour ne pas changer)' : '';
  }
  dlg.returnValue = '';
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const patch = {};
    for (const [f, el] of INFO) {
      const inp = $(el), v = inp.value.trim();
      if (inp.dataset.reset) { patch[f] = ''; continue; }
      if (v === initial[f] || (!v && tracks.length > 1)) continue;
      // typing the file's own value back removes the correction
      patch[f] = tracks.length === 1 && v === fileValue[f](tracks[0]) ? '' : v;
    }
    if (Object.keys(patch).length) api.setMeta(tracks.map((t) => t.id), patch);
  }, { once: true });
  dlg.showModal();
  $(focus).focus();
  $(focus).select();
}
document.querySelectorAll('.reset-field').forEach((b) => b.addEventListener('click', () => {
  const f = b.dataset.f, inp = $(INFO.find((x) => x[0] === f)[1]);
  const t = state.tracks.get(targetIds()[0]);
  inp.dataset.reset = '1';
  inp.value = t && state.selected.size <= 1 ? fileValue[f](t) : '';
  inp.placeholder = "valeur d'origine";
  inp.classList.add('reset');
}));
document.querySelectorAll('#infoDlg input').forEach((inp) => inp.addEventListener('input', () => { inp.dataset.reset = ''; inp.classList.remove('reset'); }));
api.onEditInfo(({ ids, field }) => editInfo(ids, field === 'comment' ? 'iComment' : 'iTitle'));

// ---------- grid editing ----------
// The grid is anchor + k * beat; bars start every 4 beats from the anchor. Every tool moves the anchor.
function loadedGrid() {
  const t = state.loaded && state.tracks.get(state.loaded);
  return t && t.analysis && t.analysis.bpm ? t.analysis : null;
}
function setAnchor(v) { if (state.loaded) api.setGrid(state.loaded, { downbeat: Math.max(0, v) }); }
const grid = {
  nudge(ms) { const a = loadedGrid(); if (a) setAnchor(a.anchor + ms / 1000); },
  shiftBar(dir) { const a = loadedGrid(); if (a) setAnchor(a.anchor + (dir * 60) / a.bpm); },
  barHere() {
    const a = loadedGrid();
    if (!a) return;
    const beat = 60 / a.bpm;
    setAnchor(a.anchor + Math.round((audio.currentTime - a.anchor) / beat) * beat);
  },
  snapHere() { if (loadedGrid()) setAnchor(audio.currentTime); },
  auto() { if (state.loaded) api.setGrid(state.loaded, { reset: true }); },
};
$('gNudgeL').addEventListener('click', (e) => grid.nudge(e.altKey ? -1 : -5));
$('gNudgeR').addEventListener('click', (e) => grid.nudge(e.altKey ? 1 : 5));
$('gBarPrev').addEventListener('click', () => grid.shiftBar(-1));
$('gBarNext').addEventListener('click', () => grid.shiftBar(1));
$('gBarHere').addEventListener('click', grid.barHere);
$('gSnapHere').addEventListener('click', grid.snapHere);
$('gAuto').addEventListener('click', grid.auto);

// ---------- metronome ----------
// Clicks are scheduled on an AudioContext slightly ahead of the <audio> playhead.
const metro = { on: false, ctx: null, next: null };
function metroClick(when, bar) {
  const ctx = metro.ctx;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.frequency.value = bar ? 1760 : 1175;
  const vol = 0.55 * audio.volume;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(vol, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  osc.connect(g).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.06);
}
function metroTick() {
  const a = loadedGrid();
  if (!metro.on || audio.paused || !a) { metro.next = null; return; }
  if (!metro.ctx) metro.ctx = new AudioContext();
  const beat = 60 / a.bpm, now = audio.currentTime;
  if (metro.next == null || metro.next < now - 0.05 || metro.next > now + 0.5) {
    metro.next = a.beatOffset + Math.ceil((now - a.beatOffset) / beat) * beat;
  }
  while (metro.next < now + 0.12) {
    const n = Math.round((metro.next - a.downbeat) / beat);
    metroClick(metro.ctx.currentTime + Math.max(0, metro.next - now) / (audio.playbackRate || 1), ((n % 4) + 4) % 4 === 0);
    metro.next += beat;
  }
}
function toggleMetro() {
  metro.on = !metro.on;
  metro.next = null;
  $('gClick').classList.toggle('on', metro.on);
  if (metro.on && metro.ctx && metro.ctx.state === 'suspended') metro.ctx.resume();
}
$('gClick').addEventListener('click', toggleMetro);
audio.addEventListener('seeked', () => { metro.next = null; });

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || document.querySelector('dialog[open]')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1, e.shiftKey); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1, e.shiftKey); }
  else if (e.key === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + (e.shiftKey ? 30 : 8));
  else if (e.key === 'ArrowLeft' && audio.duration) audio.currentTime = Math.max(0, audio.currentTime - (e.shiftKey ? 30 : 8));
  else if (e.key === 'Enter' && state.anchor) loadTrack(state.anchor, { play: true });
  else if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); state.selected = new Set(state.view); renderRows(true); }
  else if (e.key === 'm') $('compatible').click();
  else if (/^[0-5]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) setRating(targetIds(), +e.key);
  else if (e.key === 'F2') editInfo(targetIds());
  else if (e.key === 'p') $('noPlaylist').click();
  else if (e.key === '*') fixBpm(2);
  else if (e.key === 'c') toggleMetro();
  else if (e.key === '[') grid.shiftBar(-1);
  else if (e.key === ']') grid.shiftBar(1);
  else if (e.key === ',') grid.nudge(e.altKey ? -1 : -5);
  else if (e.key === '.') grid.nudge(e.altKey ? 1 : 5);
  else if (e.key === 'g') grid.barHere();
  else if (e.key === 'G') grid.snapHere();
  else if (e.key === '/') { e.preventDefault(); fixBpm(0.5); }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && state.playlist) { e.preventDefault(); removeSelectedFromPlaylist(); }
});

// ---------- filters ----------
['search', 'bpmMin', 'bpmMax', 'keyFilter'].forEach((id) => $(id).addEventListener('input', invalidate));
$('recursive').addEventListener('change', () => { api.focus(state.folder, $('recursive').checked); invalidate(); });
$('compatible').addEventListener('change', invalidate);
$('noPlaylist').addEventListener('change', invalidate);
(function fillKeys() {
  const opts = [];
  for (let n = 1; n <= 12; n++) for (const l of ['A', 'B']) opts.push(`${n}${l}`);
  $('keyFilter').innerHTML = '<option value="">Toutes tonalités</option>' +
    opts.map((c) => `<option value="${c}">${c} — ${keys.camelotToName(c)}</option>`).join('') +
    '<optgroup label="Compatibles avec…">' + opts.map((c) => `<option value="~${c}">≈ ${c} (${keys.camelotToName(c)})</option>`).join('') + '</optgroup>';
})();

// ---------- export ----------
$('btnExport').addEventListener('click', (e) => { e.stopPropagation(); $('exportMenu').classList.toggle('hidden'); });
window.addEventListener('click', () => $('exportMenu').classList.add('hidden'));
function reportExport(res) {
  if (!res || !res.count && !res.skipped) return;
  let msg = `rekordbox XML : ${res.count} titre(s) exporté(s)`;
  if (res.skipped.length) msg += ` · ${res.skipped.length} ignoré(s) (format non lu par rekordbox ou pas encore analysé)`;
  statusHold = Date.now() + 10000; $('statusRight').textContent = msg;
  $('statusRight').title = res.skipped.join('\n');
}
api.onExportDone(reportExport);
$('exportMenu').addEventListener('click', (e) => {
  if (e.target.closest('[data-copy]')) {
    if (!state.playlists.length) { flash('Aucune playlist à copier'); return; }
    api.copyToDevice(null);
    return;
  }
  const all = e.target.closest('[data-pl]');
  if (all) {
    if (!state.playlists.length) { flash('Aucune playlist à exporter'); return; }
    api.exportPlaylists(all.dataset.pl).then(reportExport);
    return;
  }
  const b = e.target.closest('[data-fmt]');
  if (!b) return;
  const ids = state.selected.size > 1 ? state.view.filter((id) => state.selected.has(id)) : state.view;
  // rekordbox playlist named after the playlist / folder being viewed
  const pl = currentPlaylist();
  const name = pl ? pl.name : 'CrateScope · ' + ((state.folder || state.root || '').split(SEP).pop() || 'export');
  api.exportList(b.dataset.fmt, ids, name).then(reportExport);
});

// ---------- copy to a USB stick ----------
const mb = (b) => (b / 1048576).toFixed(0) + ' Mo';
api.onCopyProgress((p) => {
  $('copyCancel').classList.remove('hidden');
  statusHold = Date.now() + 3000; $('statusRight').textContent = `Copie vers la clé : ${p.done} / ${p.total}${p.totalBytes ? ` · ${mb(p.bytes)} / ${mb(p.totalBytes)}` : ''} · ${p.file}`;
});
api.onCopyDone((r) => {
  $('copyCancel').classList.add('hidden');
  if (r.error) { statusHold = Date.now() + 10000; $('statusRight').textContent = `Copie impossible : ${r.error}`; return; }
  if (r.cancelled) { statusHold = Date.now() + 10000; $('statusRight').textContent = `Copie annulée (${r.copied} / ${r.total} titres copiés)`; return; }
  let msg = `Clé prête : ${r.copied} copié(s)${r.kept ? `, ${r.kept} déjà à jour` : ''} · rekordbox XML écrit sur la clé`;
  if (r.skipped.length) msg += ` · ${r.skipped.length} ignoré(s)`;
  statusHold = Date.now() + 10000; $('statusRight').textContent = msg;
  $('statusRight').title = r.skipped.join('\n');
});
$('copyCancel').addEventListener('click', () => api.cancelCopy());

// ---------- library ----------
function applySnapshot(snap) {
  if (!snap) return;
  state.root = snap.root;
  state.tracks = new Map(snap.tracks.map((t) => [t.id, t]));
  state.trackStamp++;
  $('rootName').textContent = snap.root;
  $('rootName').title = snap.root;
  if (state.folder && ![...state.tracks.values()].some((t) => t.dir != null && (t.dir === state.folder || t.dir.startsWith(state.folder + SEP)))) state.folder = '';
  updateStats(snap.stats);
  state.dirtyTree = true;
  for (const el of rowPool.values()) el._sig = '';
  invalidate();
  api.focus(state.folder, $('recursive').checked);
}

async function chooseFolder() {
  $('status').textContent = 'Scan du dossier…';
  const snap = await api.chooseFolder();
  if (snap) { state.folder = ''; state.selected.clear(); if (state.playlist) showPlaylist(null); applySnapshot(snap); }
  else $('status').textContent = 'Prêt';
}
$('btnOpen').addEventListener('click', chooseFolder);
$('btnOpen2').addEventListener('click', chooseFolder);

let lastCount = 0;
api.onUpdate(({ tracks, stats }) => {
  state.trackStamp++;
  for (const t of tracks) {
    if (!state.tracks.has(t.id)) state.dirtyTree = true;
    state.tracks.set(t.id, t);
    if (t.id === state.loaded) { renderDeckInfo(t); metro.next = null; requestAnimationFrame(drawDeck); }
  }
  if (stats.total !== lastCount) state.dirtyTree = true;
  updateStats(stats);
  invalidate();
});
api.onRemoved((id) => { state.tracks.delete(id); state.trackStamp++; state.dirtyTree = true; invalidate(); });
api.onSnapshot((snap) => applySnapshot(snap));

const t0 = { at: Date.now(), done: 0 };
function updateStats(s) {
  lastCount = s.total;
  const pct = s.total ? (s.analyzed / s.total) * 100 : 0;
  $('progressBar').style.width = pct + '%';
  let txt;
  if (!s.total) txt = state.root ? 'Aucun fichier audio' : 'Prêt';
  else if (s.analyzed + s.errors < s.total) {
    if (t0.done > s.analyzed) { t0.at = Date.now(); t0.done = s.analyzed; }
    const rate = (s.analyzed - t0.done) / Math.max(1, (Date.now() - t0.at) / 1000);
    const eta = rate > 0 ? Math.round((s.total - s.analyzed - s.errors) / rate) : 0;
    txt = `Analyse : ${s.analyzed} / ${s.total}${rate > 0 ? ` · ${rate.toFixed(1)} titres/s · reste ~${fmtTime(eta)}` : ''}`;
  } else {
    txt = `${s.total} titres analysés${s.quality ? ` · contrôle qualité : ${s.quality} restant(s)` : ''}`;
    t0.at = Date.now(); t0.done = s.analyzed;
  }
  if (s.errors) txt += ` · ${s.errors} erreur(s)`;
  $('status').textContent = txt;
  if (Date.now() > statusHold) $('statusRight').textContent = s.online ? `Métadonnées en ligne : ${s.online} en attente` : '';
}

// ---------- settings ----------
async function openSettings() {
  const s = state.settings = await api.getSettings();
  $('sMin').value = s.minBpm; $('sMax').value = s.maxBpm; $('sConc').value = s.concurrency;
  $('sAuto').checked = s.autoOnline; $('sMb').checked = s.useMusicBrainz; $('sDg').checked = s.useDiscogs !== false; $('sDiscogs').value = s.discogsToken || ''; $('sDgKey').value = s.discogsKey || ''; $('sDgSecret').value = s.discogsSecret || ''; $('sUpd').checked = s.autoUpdate !== false;
  $('settingsDlg').showModal();
}
$('btnSettings').addEventListener('click', openSettings);
$('discogsLink').addEventListener('click', (e) => { e.preventDefault(); api.openExternal('https://www.discogs.com/settings/developers'); });
$('btnStale').addEventListener('click', () => { api.reanalyzeStale(); });
$('settingsDlg').addEventListener('close', async () => {
  if ($('settingsDlg').returnValue !== 'ok') return;
  const min = Math.max(40, +$('sMin').value || 88), max = Math.max(min * 1.9, +$('sMax').value || 180);
  state.settings = await api.setSettings({
    minBpm: min, maxBpm: Math.round(max), concurrency: Math.max(1, Math.min(16, +$('sConc').value || 4)),
    autoOnline: $('sAuto').checked, useMusicBrainz: $('sMb').checked, useDiscogs: $('sDg').checked, discogsToken: $('sDiscogs').value.trim(), discogsKey: $('sDgKey').value.trim(), discogsSecret: $('sDgSecret').value.trim(), autoUpdate: $('sUpd').checked,
  });
});

// ---------- updates ----------
let upd = null;
function updText(st) {
  switch (st.status) {
    case 'checking': return 'Recherche en cours…';
    case 'uptodate': return `À jour (${st.current})`;
    case 'available': return `Version ${st.latest} disponible`;
    case 'downloading': return `Téléchargement de ${st.latest} : ${Math.round(st.progress * 100)} %`;
    case 'ready': return `${st.latest} prête, installée au redémarrage`;
    case 'installing': return 'Installation…';
    case 'error': return `Erreur : ${st.error}`;
    default: return `Version installée : ${st.current}`;
  }
}
function renderUpdate(st) {
  upd = st;
  $('updInfo').textContent = updText(st);
  const b = $('updBtn');
  const show = ['available', 'downloading', 'ready'].includes(st.status) || (st.status === 'error' && st.latest);
  b.classList.toggle('hidden', !show);
  b.classList.toggle('ready', st.status === 'ready');
  b.classList.toggle('error', st.status === 'error');
  b.textContent = st.status === 'ready' ? `⟳ Redémarrer pour passer à ${st.latest}`
    : st.status === 'downloading' ? `⬇ ${st.latest} : ${Math.round(st.progress * 100)} %`
    : st.status === 'error' ? '⚠ Mise à jour impossible' : `⬆ ${st.latest} disponible`;
  b.title = st.status === 'error' ? `${st.error}\nCliquer pour ouvrir la page de la version` : st.status === 'available' ? 'Cliquer pour télécharger la mise à jour' : '';
}
$('updBtn').addEventListener('click', () => {
  if (!upd) return;
  if (upd.status === 'ready') api.installUpdate();
  else if (upd.status === 'available') api.downloadUpdate();
  else if (upd.status === 'error' && upd.url) api.openExternal(upd.url);
});
$('btnCheckUpd').addEventListener('click', () => api.checkUpdate());
api.onUpdateState(renderUpdate);
api.updateState().then(renderUpdate);

// ---------- boot ----------
applyColumns(null);
api.onColumnToggle(toggleColumn);
api.getSettings().then((s) => { state.settings = s; applyColumns(s.columns); });
api.openLast().then((snap) => { if (snap) applySnapshot(snap); else schedule(); })
  .then(() => api.playlists()).then((list) => { state.playlists = list; state.dirtyTree = true; invalidate(); });
