'use strict';
/* global api, keys, waveform */

const $ = (id) => document.getElementById(id);
const state = {
  root: null,
  tracks: new Map(),
  view: [],            // filtered + sorted ids
  folder: '',          // '' = root
  playlists: [],       // [{ id, name, ids }]
  playlist: null,      // id of the playlist being viewed (instead of a folder)
  sort: { key: 'title', dir: 1 },
  selected: new Set(),
  anchor: null,        // last clicked id (shift-select)
  loaded: null,        // id in the deck
  waves: null,         // { overview, detail } of loaded track
  settings: {},
  dirtyView: true,
  dirtyTree: true,
};

const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';
const ROW_H = 34;

// ---------- helpers ----------
const tags = (t) => (t.probe && t.probe.tags) || {};
const fTitle = (t) => tags(t).title || t.parsed.title || t.name;
const fArtist = (t) => tags(t).artist || t.parsed.artist || '';
const fGenres = (t) => {
  const g = [];
  if (tags(t).genre) g.push(...tags(t).genre.split(/[;/,]\s*/));
  if (t.online && t.online.genres) g.push(...t.online.genres);
  return [...new Set(g.filter(Boolean))];
};
const fStyles = (t) => (t.online && t.online.styles) || [];
const fYear = (t) => tags(t).year || (t.online && t.online.year) || '';
const fLabel = (t) => tags(t).label || (t.online && t.online.label) || '';
const fDur = (t) => (t.analysis && t.analysis.duration) || (t.probe && t.probe.duration) || 0;
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
const COLS = [
  { key: 'status', label: '', sort: (t) => t.status },
  { key: 'wave', label: 'Waveform', sort: (t) => fDur(t) },
  { key: 'title', label: 'Titre', sort: (t) => fTitle(t).toLowerCase() },
  { key: 'artist', label: 'Artiste', sort: (t) => fArtist(t).toLowerCase() },
  { key: 'bpm', label: 'BPM', sort: (t) => (t.analysis ? t.analysis.bpm : 1e9) },
  { key: 'key', label: 'Key', sort: (t) => camSort(t.analysis && t.analysis.camelot) },
  { key: 'lufs', label: 'LUFS', sort: (t) => (t.analysis && t.analysis.lufs != null ? t.analysis.lufs : -99) },
  { key: 'genre', label: 'Genre', sort: (t) => (fGenres(t)[0] || '~').toLowerCase() },
  { key: 'style', label: 'Style', sort: (t) => (fStyles(t)[0] || '~').toLowerCase() },
  { key: 'time', label: 'Durée', sort: fDur },
  { key: 'year', label: 'Année', sort: (t) => fYear(t) || '9999' },
  { key: 'label', label: 'Label', sort: (t) => (fLabel(t) || '~').toLowerCase() },
  { key: 'fmt', label: 'Format', sort: (t) => t.ext },
];

function renderHead() {
  $('thead').innerHTML = COLS.map((c) => `<div data-k="${c.key}" class="${state.sort.key === c.key ? 'sorted' : ''}">${c.label}${state.sort.key === c.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</div>`).join('');
}
$('thead').addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]');
  if (!k) return;
  const key = k.dataset.k;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
  renderHead();
  invalidate();
});

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

function computeView() {
  const q = $('search').value.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const bMin = parseFloat($('bpmMin').value), bMax = parseFloat($('bpmMax').value);
  const kf = $('keyFilter').value;
  const ref = $('compatible').checked && state.loaded ? state.tracks.get(state.loaded) : null;
  const refA = ref && ref.analysis;
  const out = [];
  const pl = currentPlaylist();
  const source = pl ? pl.ids.map((id) => state.tracks.get(id)).filter(Boolean) : state.tracks.values();
  for (const t of source) {
    if (!pl && !inFolder(t)) continue;
    const a = t.analysis;
    if (!isNaN(bMin) && (!a || a.bpm < bMin)) continue;
    if (!isNaN(bMax) && (!a || a.bpm > bMax)) continue;
    if (kf && (!a || (!kf.startsWith('~') ? a.camelot !== kf : !keys.compatible(kf.slice(1), a.camelot)))) continue;
    if (refA && t.id !== ref.id && (!a || !keys.compatible(refA.camelot, a.camelot) || !bpmCompatible(refA.bpm, a.bpm))) continue;
    if (terms.length) {
      const hay = `${fTitle(t)} ${fArtist(t)} ${fGenres(t).join(' ')} ${fStyles(t).join(' ')} ${fLabel(t)} ${t.name} ${tags(t).album || ''} ${a ? a.camelot + ' ' + a.key + ' ' + a.bpm : ''}`.toLowerCase();
      if (!terms.every((x) => hay.includes(x))) continue;
    }
    out.push(t);
  }
  if (pl && state.sort.key === 'pos') { // playlist order
    state.view = (state.sort.dir > 0 ? out : out.reverse()).map((t) => t.id);
    return;
  }
  const col = COLS.find((c) => c.key === state.sort.key) || COLS[2];
  const dir = state.sort.dir;
  const keyed = out.map((t) => [col.sort(t), fTitle(t).toLowerCase(), t]);
  keyed.sort((x, y) => (x[0] < y[0] ? -dir : x[0] > y[0] ? dir : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  state.view = keyed.map((x) => x[2].id);
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
  const a = t.analysis;
  const tagBpm = parseFloat(tags(t).tagBpm);
  const diff = a && tagBpm > 0 && Math.abs(tagBpm - a.bpm) > 1 && Math.abs(tagBpm * 2 - a.bpm) > 1 && Math.abs(tagBpm / 2 - a.bpm) > 1;
  return `<div><div class="dot ${t.status}" title="${t.status === 'error' ? esc(t.error) : t.status}"></div></div>
<div><canvas></canvas></div>
<div class="c-title" title="${esc(t.rel)}">${esc(fTitle(t))}</div>
<div class="c-artist">${esc(fArtist(t))}</div>
<div class="c-bpm${a && a.bpmDetected ? ' bpm-fixed' : ''}"${a && a.bpmDetected ? ` title="Détecté : ${fmtBpm(a.bpmDetected)}"` : ''}>${a ? fmtBpm(a.bpm) : ''}${diff ? `<span class="bpm-tag-diff" title="Tag du fichier : ${tagBpm}">*</span>` : ''}</div>
<div class="c-key">${a ? `<span class="key" style="background:${keyColor(a.camelot)}">${a.camelot}</span><span class="key-name">${a.key}</span>` : ''}</div>
<div class="c-lufs">${a && a.lufs != null ? a.lufs.toFixed(1) : ''}</div>
<div class="c-genre">${esc(fGenres(t).join(', '))}${t.onlinePending && !fGenres(t).length ? '<span class="dim">…</span>' : ''}</div>
<div class="c-style">${esc(fStyles(t).join(', '))}</div>
<div class="c-time">${fDur(t) ? fmtTime(fDur(t)) : ''}</div>
<div class="c-year">${esc(fYear(t))}</div>
<div class="c-label">${esc(fLabel(t))}</div>
<div class="c-fmt">${esc(fFormat(t))}</div>`;
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
    const sig = `${t.id}|${t.edit ? JSON.stringify(t.edit) : ''}|${t.analysis ? t.analysis.version : 0}|${t.status}|${t.onlinePending}|${t.online ? t.online.fetchedAt : 0}|${t.probe ? 1 : 0}`;
    if (el._sig !== sig) {
      el._sig = sig;
      el.dataset.id = t.id;
      el.innerHTML = rowHtml(t);
      waveform.drawMini(el.querySelector('canvas'), miniOf(t));
    }
    el.classList.toggle('sel', state.selected.has(t.id));
    el.classList.toggle('loaded', state.loaded === t.id);
  }
  for (const [i, el] of rowPool) if (!keep.has(i)) { el.remove(); rowPool.delete(i); }
}
function renderEmpty() {
  const pl = currentPlaylist();
  const folderTracks = [...state.tracks.values()].some((t) => !t.external);
  $('emptyState').classList.toggle('hidden', pl ? pl.ids.length > 0 : folderTracks);
  $('emptyBig').textContent = pl ? 'Playlist vide' : state.root && !folderTracks ? 'Aucun fichier audio trouvé ici' : 'Ouvre un dossier de musique';
  $('emptyText').classList.toggle('hidden', !!pl);
  $('btnOpen2').classList.toggle('hidden', !!pl);
  $('emptyPl').classList.toggle('hidden', !pl);
}

tbody.addEventListener('scroll', () => renderRows(false), { passive: true });
window.addEventListener('resize', () => { lastRange = ''; renderRows(true); drawDeck(); });

function rowFromEvent(e) { const r = e.target.closest('.trow'); return r ? r.dataset.id : null; }

tbody.addEventListener('mousedown', (e) => {
  const id = rowFromEvent(e);
  if (!id || e.button !== 0) return;
  if (e.target.tagName === 'CANVAS') {
    // click on the mini waveform: load and play from that point
    const rect = e.target.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    select(id, e);
    loadTrack(id, { play: true, at: frac });
    return;
  }
  select(id, e);
});
tbody.addEventListener('dblclick', (e) => { const id = rowFromEvent(e); if (id) loadTrack(id, { play: true }); });
tbody.addEventListener('contextmenu', (e) => {
  const id = rowFromEvent(e);
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

function select(id, e, { load = true } = {}) {
  if (e.shiftKey && state.anchor) {
    const a = state.view.indexOf(state.anchor), b = state.view.indexOf(id);
    if (a >= 0 && b >= 0) {
      state.selected = new Set(state.view.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
  } else if (e.metaKey || e.ctrlKey) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    state.anchor = id;
  } else {
    state.selected = new Set([id]);
    state.anchor = id;
    // browsing: single click loads into the deck, keeps playing if we were playing
    if (load) loadTrack(id, { play: !audio.paused });
  }
  renderRows(true);
}

function moveSelection(delta) {
  if (!state.view.length) return;
  let i = state.view.indexOf(state.anchor);
  i = i < 0 ? 0 : Math.max(0, Math.min(state.view.length - 1, i + delta));
  const id = state.view[i];
  select(id, {});
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
      <div class="lbl ${!state.playlist && state.folder === n.path ? 'active' : ''}"><span class="tw">${kids.length ? (open ? '▼' : '▶') : ''}</span><span class="nm">${depth === 0 ? '🎧 ' : '📁 '}${esc(n.name || 'Dossier')}</span><span class="ct">${n.count}</span></div>
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
    if (state.playlist) showPlaylist(null);
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
  const html = state.playlists.map((p) => {
    const missing = p.ids.filter((id) => !state.tracks.has(id)).length;
    return `<div class="pl ${p.id === state.playlist ? 'active' : ''}" data-id="${p.id}" title="${esc(p.name)}">
      <span>♫</span><span class="nm">${esc(p.name)}</span>
      ${missing ? `<span class="ct miss" title="${missing} fichier(s) introuvable(s) (déplacé ou supprimé)">⚠ ${missing}</span>` : ''}
      <span class="ct">${p.ids.length}</span></div>`;
  }).join('');
  $('plList').innerHTML = html || '<div class="pl-empty">Aucune playlist. ＋ pour en créer une.</div>';
}

function showPlaylist(id) {
  state.playlist = id;
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
$('btnNewPl').addEventListener('click', () => newPlaylist());
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
  const el = e.target.closest('.pl');
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
  const el = e.target.closest('.pl');
  if (el) dropInto(el.dataset.id, e);
});
// files dropped on the list while a playlist is shown go into it
const listEl = document.querySelector('.list');
listEl.addEventListener('dragover', (e) => {
  if (!state.playlist || !accepts(e)) return;
  e.preventDefault();
  listEl.classList.add('drop');
});
listEl.addEventListener('dragleave', (e) => { if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('drop'); });
listEl.addEventListener('drop', (e) => {
  listEl.classList.remove('drop');
  if (!state.playlist) return;
  e.preventDefault();
  dropInto(state.playlist, e);
});
window.addEventListener('dragover', (e) => e.preventDefault()); // a stray drop never navigates away
window.addEventListener('drop', (e) => { e.preventDefault(); dragIds = null; });

function removeSelectedFromPlaylist() {
  if (!state.playlist || !state.selected.size) return;
  api.removeFromPlaylist(state.playlist, [...state.selected]);
  state.selected.clear();
}

let flashTimer;
function flash(msg) {
  $('statusRight').textContent = msg;
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
  const chips = [
    ...fGenres(t).map((g) => `<span class="chip">${esc(g)}</span>`),
    ...fStyles(t).map((s) => `<span class="chip style">${esc(s)}</span>`),
  ];
  if (tg.grouping) chips.push(`<span class="chip tag">${esc(tg.grouping)}</span>`);
  if (!chips.length && t.onlinePending) chips.push('<span class="chip tag">recherche en ligne…</span>');
  if (!chips.length && o.notFound) chips.push('<span class="chip tag">introuvable en ligne</span>');
  $('dChips').innerHTML = chips.join('');
  $('dChips').title = [...fGenres(t), ...fStyles(t)].join(', '); // full list when chips are clipped
  const meta = [];
  const yl = [fYear(t), fLabel(t), o.country].filter(Boolean).join(' · ');
  if (yl) meta.push(yl);
  meta.push(`${fFormat(t)} · ${(t.size / 1048576).toFixed(1)} Mo${a.lra != null ? ` · LRA ${a.lra} LU` : ''}`);
  const tagInfo = [tg.tagBpm && `BPM ${tg.tagBpm}`, tg.tagKey && `Key ${tg.tagKey}`].filter(Boolean).join(', ');
  if (tagInfo) meta.push(`Tags du fichier : ${tagInfo}`);
  if (a.bpm && a.gridRmsMs != null) {
    const parts = [a.tempoStable ? `Grille : tempo stable (écart moyen ${a.gridRmsMs} ms)` : `<span class="grid-warn">⚠ Tempo variable (dérive ${a.gridDriftMs} ms) : grille approximative</span>`];
    if (!a.gridEdited) parts.push(a.downbeatConfidence >= 0.2 ? '1er temps détecté' : '<span class="grid-warn">1er temps incertain, à vérifier</span>');
    else parts.push('calage manuel');
    meta.push(parts.join(' · '));
  }
  const links = [o.discogsUrl && `<a data-href="${esc(o.discogsUrl)}">Discogs ↗</a>`, o.mbUrl && `<a data-href="${esc(o.mbUrl)}">MusicBrainz ↗</a>`].filter(Boolean);
  if (links.length) meta.push(links.join(' &nbsp; '));
  if (t.error) meta.push(`<span style="color:#ff4d5e">Erreur : ${esc(t.error)}</span>`);
  $('dMeta').innerHTML = meta.join('<br>');
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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || $('nameDlg').open || $('settingsDlg').open) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + (e.shiftKey ? 30 : 8));
  else if (e.key === 'ArrowLeft' && audio.duration) audio.currentTime = Math.max(0, audio.currentTime - (e.shiftKey ? 30 : 8));
  else if (e.key === 'Enter' && state.anchor) loadTrack(state.anchor, { play: true });
  else if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); state.selected = new Set(state.view); renderRows(true); }
  else if (e.key === 'm') $('compatible').click();
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
  $('statusRight').textContent = msg;
  $('statusRight').title = res.skipped.join('\n');
}
api.onExportDone(reportExport);
$('exportMenu').addEventListener('click', (e) => {
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

// ---------- library ----------
function applySnapshot(snap) {
  if (!snap) return;
  state.root = snap.root;
  state.tracks = new Map(snap.tracks.map((t) => [t.id, t]));
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
  for (const t of tracks) {
    if (!state.tracks.has(t.id)) state.dirtyTree = true;
    state.tracks.set(t.id, t);
    if (t.id === state.loaded) { renderDeckInfo(t); metro.next = null; requestAnimationFrame(drawDeck); }
  }
  if (stats.total !== lastCount) state.dirtyTree = true;
  updateStats(stats);
  invalidate();
});
api.onRemoved((id) => { state.tracks.delete(id); state.dirtyTree = true; invalidate(); });
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
    txt = `${s.total} titres analysés`;
    t0.at = Date.now(); t0.done = s.analyzed;
  }
  if (s.errors) txt += ` · ${s.errors} erreur(s)`;
  $('status').textContent = txt;
  $('statusRight').textContent = s.online ? `Métadonnées en ligne : ${s.online} en attente` : '';
}

// ---------- settings ----------
async function openSettings() {
  const s = state.settings = await api.getSettings();
  $('sMin').value = s.minBpm; $('sMax').value = s.maxBpm; $('sConc').value = s.concurrency;
  $('sAuto').checked = s.autoOnline; $('sMb').checked = s.useMusicBrainz; $('sDg').checked = s.useDiscogs !== false; $('sDiscogs').value = s.discogsToken || ''; $('sDgKey').value = s.discogsKey || ''; $('sDgSecret').value = s.discogsSecret || '';
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
    autoOnline: $('sAuto').checked, useMusicBrainz: $('sMb').checked, useDiscogs: $('sDg').checked, discogsToken: $('sDiscogs').value.trim(), discogsKey: $('sDgKey').value.trim(), discogsSecret: $('sDgSecret').value.trim(),
  });
});

// ---------- boot ----------
renderHead();
api.getSettings().then((s) => { state.settings = s; });
api.openLast().then((snap) => { if (snap) applySnapshot(snap); else schedule(); })
  .then(() => api.playlists()).then((list) => { state.playlists = list; state.dirtyTree = true; invalidate(); });
