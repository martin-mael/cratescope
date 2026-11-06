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

  // File quality verdict from probe + background check (t.quality).
  // Each issue: level 'bad' (a real defect of this copy) | 'warn' (worth a look) | 'info',
  // short (column label), text (detail), why (what it means, for the tooltip).
  const LOSSY = new Set(['mp3', 'aac', 'm4a', 'mp4', 'ogg', 'oga', 'opus', 'wma', 'webm']);
  const kHz = (hz) => (hz / 1000).toFixed(1).replace('.', ',') + ' kHz';
  function qualityIssues(t) {
    const out = [];
    const p = t.probe, q = t.quality;
    if (!p) return out;
    const add = (level, short, text, why) => out.push({ level, short, text, why });
    const lossy = LOSSY.has(t.ext) && p.codec !== 'alac' && p.codec !== 'flac';
    // (VBR V0 averages 220-260 kbps and is fine: only clearly low bitrates are flagged)
    if (lossy && p.bitrate && p.bitrate < 160) add('bad', 'Bitrate faible', `Bitrate faible : ${p.bitrate} kbps`, 'Perte audible sur un système de club. Une version 320 kbps ou lossless serait préférable.');
    else if (lossy && p.bitrate && p.bitrate < 210 && p.codec === 'mp3') add('warn', 'Bitrate moyen', `Bitrate moyen : ${p.bitrate} kbps`, 'Limite sur un gros système. Une version 320 kbps serait préférable.');
    if (p.sampleRate && p.sampleRate < 44100) add('warn', 'Échantillonnage', `Échantillonnage ${kHz(p.sampleRate)}`, 'En dessous de la qualité CD.');
    if (!q || q.error) return out;
    if (q.cutoff) {
      const c = q.cutoff;
      if (q.lossless) {
        if (c <= 17500) add('bad', 'Faux lossless', `Faux lossless : spectre coupé à ${kHz(c)}`, 'Source : MP3 128 kbps.');
        else if (c <= 19600) add('bad', 'Faux lossless', `Faux lossless : spectre coupé à ${kHz(c)}`, 'Source : MP3 192 kbps.');
        // LAME 320 kbps stops at ~20.0-20.4 kHz; higher cutoffs are mastering filters (inaudible, not reported)
        else if (c <= 20500) add('warn', 'Lossless douteux', `Spectre coupé à ${kHz(c)}`, 'Source possible : MP3 320 kbps (différence quasi inaudible).');
      } else if (p.bitrate >= 256) {
        if (c <= 17500) add('bad', 'Ré-encodé', `Ré-encodé : spectre coupé à ${kHz(c)} malgré ${p.bitrate} kbps`, 'Source : MP3 128 kbps.');
        else if (c <= 19600) add('warn', 'Ré-encodé ?', `Spectre coupé à ${kHz(c)} malgré ${p.bitrate} kbps`, 'Source probable : MP3 192 kbps.');
      }
    }
    // clipping only means something on lossless files (decoding a loud MP3 always overshoots 0 dB),
    // and it's a mastering choice (gabber, hardcore, donk…), never a defect of this copy: info only
    if (q.lossless && q.clipPerMin >= 500) add('info', 'Mastering saturé', 'Mastering très saturé', 'Choix de mastering, normal pour certains styles. Pas un défaut du fichier.');
    else if (q.lossless && q.clipPerMin >= 50) add('info', 'Écrêtage', 'Mastering légèrement saturé', 'Choix de mastering. Pas un défaut du fichier.');
    if (q.fakeStereo) add('warn', 'Faux stéréo', 'Mono enregistré en stéréo', 'Les deux canaux sont identiques.');
    return out;
  }
  // 'bad' | 'warn' | 'ok' | 'info' | null (not checked yet)
  function qualityLevel(t) {
    const issues = qualityIssues(t);
    if (issues.some((i) => i.level === 'bad')) return 'bad';
    if (issues.some((i) => i.level === 'warn')) return 'warn';
    if (!t.quality) return issues.length ? 'info' : null;
    return issues.length ? 'info' : 'ok';
  }

  // lower case, no accents: for search and duplicate matching
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // ---------- duplicates ----------
  // Same artist + title once normalised (no "original mix", "feat.", punctuation, accents) and the same
  // length within 2 s: copies and re-encodes of one track. Remixes / edits differ in title or length.
  const clean = (s) => fold(s)
    .replace(/[([](original mix|original|extended mix|free download|free dl)[)\]]/g, ' ')
    .replace(/\s-\s(original mix|original)$/g, ' ')
    .replace(/\b(feat|ft|featuring)\b\.?.*$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const LOSSLESS_EXT = new Set(['flac', 'wav', 'aif', 'aiff', 'alac', 'ape', 'wv']);
  // best copy first: not a fake / broken file, then lossless, then bitrate, then size
  const rank = (t) => [qualityLevel(t) === 'bad' ? 0 : 1, LOSSLESS_EXT.has(t.ext) ? 1 : 0, (t.probe && t.probe.bitrate) || 0, t.size || 0];
  const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
  // → Map id -> { group: key, size, best (to keep), tie (copies equivalent), ids (best first) }
  function duplicates(tracks) {
    const byName = new Map();
    for (const t of tracks) {
      const ti = clean(title(t));
      if (!ti) continue;
      const k = clean(artist(t)) + '|' + ti;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(t);
    }
    const out = new Map();
    for (const [k, list] of byName) {
      if (list.length < 2) continue;
      list.sort((a, b) => duration(a) - duration(b));
      let cluster = [list[0]];
      const flush = () => {
        if (cluster.length < 2) return;
        cluster.sort(better);
        const key = `${k}|${Math.round(duration(cluster[0]))}`;
        const tie = better(cluster[0], cluster[1]) === 0; // equivalent copies: no "best" one
        const ids = cluster.map((t) => t.id);
        cluster.forEach((t, i) => out.set(t.id, { group: key, size: cluster.length, best: i === 0 && !tie, tie, ids }));
      };
      for (let i = 1; i < list.length; i++) {
        if (Math.abs(duration(list[i]) - duration(list[i - 1])) <= 2) cluster.push(list[i]);
        else { flush(); cluster = [list[i]]; }
      }
      flush();
    }
    return out;
  }

  const api = { title, artist, genres, styles, year, label, album, rating, comment, duration, fold, splitList, qualityIssues, qualityLevel, duplicates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.meta = api;
})(typeof window !== 'undefined' ? window : globalThis);
