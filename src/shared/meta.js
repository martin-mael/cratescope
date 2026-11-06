'use strict';
// Effective track metadata, shared by main & renderer (renderer gets a copy via window.meta).
// Priority: the user's corrections (t.meta, never written to the files), then the file tags, then
// online data, then the file name.
(function (root) {
  const tags = (t) => (t.probe && t.probe.tags) || {};
  const user = (t) => t.meta || {};
  const online = (t) => t.online || {};
  const splitList = (s) => String(s || '').split(/[;/,]\s*/).map((x) => x.trim()).filter(Boolean);

  const title = (t) => user(t).title || tags(t).title || (t.parsed && t.parsed.title) || t.name;
  const artist = (t) => user(t).artist || tags(t).artist || (t.parsed && t.parsed.artist) || '';
  // a corrected genre replaces tags + online genres (so a wrong one can be removed)
  function genres(t) {
    if (user(t).genre != null) return [...new Set(splitList(user(t).genre))];
    return [...new Set([...splitList(tags(t).genre), ...(online(t).genres || [])])];
  }
  const styles = (t) => online(t).styles || [];
  const year = (t) => tags(t).year || online(t).year || '';
  const label = (t) => tags(t).label || online(t).label || '';
  const album = (t) => tags(t).album || online(t).album || '';
  const rating = (t) => user(t).rating || 0;
  const comment = (t) => user(t).comment || '';
  const duration = (t) => (t.analysis && t.analysis.duration) || (t.probe && t.probe.duration) || 0;

  // lower case, no accents: for search and duplicate matching
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const api = { title, artist, genres, styles, year, label, album, rating, comment, duration, fold, splitList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.meta = api;
})(typeof window !== 'undefined' ? window : globalThis);
