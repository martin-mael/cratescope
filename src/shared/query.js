'use strict';
// Search syntax, shared by the renderer (search box) and main (smart playlist exports).
// Plain words must all appear (title, artist, genres, styles, label, album, comment, file name, key, BPM).
//   bpm:125-130  bpm:>140  bpm:128      key:8A  key:~8A  key:Am
//   genre:house  style:acid  label:…  artist:…  title:…  album:…  comment:…
//   year:1995-1999  rating:>=4  lufs:>-8  kbps:<320  time:>6 (minutes)  fmt:flac  fmt:lossless
//   quality:bad|warn|ok|issue  dup:yes|no  played:yes|no  pl:yes|no (in a playlist)
//   -word  -genre:trance (exclusion)   "two words" (exact phrase)
// An unknown field or a malformed value is searched as plain text, never an error.
(function (root) {
  const meta = typeof module !== 'undefined' && module.exports ? require('./meta') : root.meta;
  const keys = typeof module !== 'undefined' && module.exports ? require('./keys') : root.keys;

  const LOSSLESS = new Set(['flac', 'wav', 'aif', 'aiff', 'alac', 'ape', 'wv']);
  const TEXT = {
    genre: (t) => meta.genres(t).join(' '), style: (t) => meta.styles(t).join(' '), label: meta.label,
    artist: meta.artist, title: meta.title, album: meta.album, comment: meta.comment,
  };
  const NUM = {
    bpm: (t) => t.analysis && t.analysis.bpm, year: (t) => parseInt(meta.year(t), 10) || null,
    rating: meta.rating, lufs: (t) => t.analysis && t.analysis.lufs, kbps: (t) => t.probe && t.probe.bitrate,
    time: (t) => meta.duration(t) / 60,
  };
  const ALIAS = { genres: 'genre', styles: 'style', bitrate: 'kbps', duree: 'time', dur: 'time', note: 'rating', stars: 'rating', format: 'fmt', ext: 'fmt', q: 'quality', qualite: 'quality', playlist: 'pl', tonalite: 'key', annee: 'year', artiste: 'artist', titre: 'title', commentaire: 'comment' };
  const YES = /^(yes|oui|y|1|true)$/i, NO = /^(no|non|n|0|false)$/i;

  // "125-130", ">140", ">=4", "<-8", "128" → predicate (null if not a number expression)
  function numPredicate(v, exactTol) {
    let m = /^(-?\d+(?:[.,]\d+)?)\s*-\s*(-?\d+(?:[.,]\d+)?)$/.exec(v);
    const n = (x) => parseFloat(x.replace(',', '.'));
    if (m) { const a = n(m[1]), b = n(m[2]); const lo = Math.min(a, b), hi = Math.max(a, b); return (x) => x >= lo && x <= hi; }
    m = /^(>=|<=|>|<|=)?\s*(-?\d+(?:[.,]\d+)?)$/.exec(v);
    if (!m) return null;
    const x0 = n(m[2]);
    switch (m[1]) {
      case '>': return (x) => x > x0;
      case '<': return (x) => x < x0;
      case '>=': return (x) => x >= x0;
      case '<=': return (x) => x <= x0;
      default: return (x) => Math.abs(x - x0) <= exactTol;
    }
  }

  function tokenize(s) {
    const out = [];
    const re = /(-?)(?:([a-zé]+):)?(?:"([^"]*)"?|(\S+))/gi;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0].trim()) continue;
      out.push({ neg: m[1] === '-', field: m[2] ? m[2].toLowerCase() : null, value: m[3] != null ? m[3] : m[4] || '', quoted: m[3] != null, raw: m[0] });
    }
    return out;
  }

  // → [{ neg, test(t, ctx) }]
  function parse(s) {
    const terms = [];
    for (const tok of tokenize(String(s || '').trim())) {
      const field = tok.field && (ALIAS[meta.fold(tok.field)] || meta.fold(tok.field));
      const v = tok.value.trim();
      let test = null;
      if (field && v) {
        if (TEXT[field]) { const f = meta.fold(v); test = (t) => meta.fold(TEXT[field](t)).includes(f); }
        else if (NUM[field]) {
          const p = numPredicate(v, field === 'bpm' ? 0.5 : field === 'time' ? 0.5 : 0);
          if (p) test = (t) => { const x = NUM[field](t); return x != null && !Number.isNaN(x) && p(x); };
        } else if (field === 'key') {
          const compat = v.startsWith('~');
          const k = keys.normalizeKey(compat ? v.slice(1) : v);
          if (k) test = (t) => !!(t.analysis && t.analysis.camelot) && (compat ? keys.compatible(k, t.analysis.camelot) : t.analysis.camelot === k);
        } else if (field === 'fmt') {
          const f = meta.fold(v);
          test = f === 'lossless' ? (t) => LOSSLESS.has(t.ext) || !!(t.probe && t.probe.codec === 'alac') : f === 'lossy' ? (t) => !LOSSLESS.has(t.ext) : (t) => t.ext === f;
        } else if (field === 'quality') {
          const f = meta.fold(v);
          if (['bad', 'warn', 'ok', 'info'].includes(f)) test = (t) => meta.qualityLevel(t) === f;
          else if (['issue', 'probleme', 'problem'].includes(f)) test = (t) => ['bad', 'warn'].includes(meta.qualityLevel(t));
        } else if (field === 'dup' || field === 'played' || field === 'pl') {
          const want = YES.test(v) ? true : NO.test(v) ? false : null;
          const set = { dup: 'dups', played: 'played', pl: 'listed' }[field];
          if (want != null) test = (t, ctx) => !!(ctx && ctx[set] && ctx[set].has(t.id)) === want;
        }
      }
      if (!test) { // plain text (also the fallback for unknown fields)
        const f = meta.fold(tok.field && !tok.quoted ? tok.raw.replace(/^-/, '') : v);
        if (!f) continue;
        test = (t) => haystack(t).includes(f);
      }
      terms.push({ neg: tok.neg, test });
    }
    return terms;
  }

  const hayCache = new WeakMap();
  function haystack(t) {
    let h = hayCache.get(t);
    if (h == null) {
      const a = t.analysis;
      h = meta.fold(`${meta.title(t)} ${meta.artist(t)} ${meta.genres(t).join(' ')} ${meta.styles(t).join(' ')} ${meta.label(t)} ${meta.album(t)} ${meta.comment(t)} ${t.name} ${a ? `${a.camelot} ${a.key} ${a.bpm}` : ''}`);
      hayCache.set(t, h);
    }
    return h;
  }

  // ctx: { dups: Set<id>, played: Set<id>, listed: Set<id> } for dup: / played: / pl:
  const matches = (t, terms, ctx) => terms.every((x) => x.test(t, ctx) !== x.neg);
  const uses = (s, field) => tokenize(s || '').some((x) => x.field && (ALIAS[meta.fold(x.field)] || meta.fold(x.field)) === field);

  const api = { parse, matches, uses };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.query = api;
})(typeof window !== 'undefined' ? window : globalThis);
