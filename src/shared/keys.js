'use strict';
// Key notation helpers shared by main & renderer (renderer gets a copy via window.keys).
(function (root) {
  const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const ALIASES = { DB: 1, 'C#': 1, 'D#': 3, EB: 3, GB: 6, 'F#': 6, 'G#': 8, AB: 8, 'A#': 10, BB: 10, C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, CB: 11, FB: 4, 'E#': 5, 'B#': 0 };

  function camelot(tonic, minor) {
    const rel = minor ? (tonic + 3) % 12 : tonic;
    return `${(((7 * rel) % 12) + 7) % 12 + 1}${minor ? 'A' : 'B'}`;
  }

  // Accepts "Am", "A minor", "F#m", "Ebmaj", "8A", "10m" / "10d" (Open Key)…
  function normalizeKey(s) {
    if (!s) return null;
    s = String(s).trim();
    let m = s.match(/^(\d{1,2})\s*([ABab])$/);
    if (m) { const n = +m[1]; return n >= 1 && n <= 12 ? `${n}${m[2].toUpperCase()}` : null; }
    m = s.match(/^(\d{1,2})\s*([mdMD])$/); // Open Key: 1d = C, 1m = Am
    if (m) {
      const n = +m[1];
      if (n < 1 || n > 12) return null;
      return `${((n - 1 + 7) % 12) + 1}${m[2].toLowerCase() === 'm' ? 'A' : 'B'}`;
    }
    m = s.match(/^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major|M)?$/);
    if (m) {
      const name = (m[1].toUpperCase() + (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2])).toUpperCase();
      const t = ALIASES[name];
      if (t == null) return null;
      const minor = m[3] && /^m(in(or)?)?$/.test(m[3]);
      return camelot(t, !!minor);
    }
    return null;
  }

  function camelotToName(c) {
    const m = /^(\d+)([AB])$/.exec(c || '');
    if (!m) return '';
    const n = +m[1], minor = m[2] === 'A';
    for (let t = 0; t < 12; t++) if (camelot(t, minor) === c) return NOTES[t] + (minor ? 'm' : '');
    return '';
  }

  function compatible(a, b) {
    const ma = /^(\d+)([AB])$/.exec(a || ''), mb = /^(\d+)([AB])$/.exec(b || '');
    if (!ma || !mb) return false;
    const na = +ma[1], nb = +mb[1];
    if (na === nb) return true; // same or relative
    if (ma[2] !== mb[2]) return false;
    const d = Math.abs(na - nb);
    return d === 1 || d === 11;
  }

  const api = { NOTES, camelot, normalizeKey, camelotToName, compatible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.keys = api;
})(typeof window !== 'undefined' ? window : globalThis);
