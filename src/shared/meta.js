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

  // File quality verdict from probe + background check (t.quality). level: 'bad' | 'warn' | 'info'
  const LOSSY = new Set(['mp3', 'aac', 'm4a', 'mp4', 'ogg', 'oga', 'opus', 'wma', 'webm']);
  const kHz = (hz) => (hz / 1000).toFixed(1).replace('.', ',') + ' kHz';
  function qualityIssues(t) {
    const out = [];
    const p = t.probe, q = t.quality;
    if (!p) return out;
    const lossy = LOSSY.has(t.ext) && p.codec !== 'alac' && p.codec !== 'flac';
    // (VBR V0 averages 220-260 kbps and is fine: only clearly low bitrates are flagged)
    if (lossy && p.bitrate && p.bitrate < 160) out.push({ level: 'bad', text: `Bitrate faible (${p.bitrate} kbps)` });
    else if (lossy && p.bitrate && p.bitrate < 210 && p.codec === 'mp3') out.push({ level: 'warn', text: `Bitrate moyen (${p.bitrate} kbps)` });
    if (p.sampleRate && p.sampleRate < 44100) out.push({ level: 'warn', text: `Échantillonnage ${kHz(p.sampleRate)}` });
    if (!q || q.error) return out;
    if (q.cutoff) {
      const c = q.cutoff;
      if (q.lossless) {
        if (c <= 17500) out.push({ level: 'bad', text: `Faux lossless : spectre coupé à ${kHz(c)} (sans doute un MP3 ≈ 128 kbps)` });
        else if (c <= 19600) out.push({ level: 'bad', text: `Faux lossless : spectre coupé à ${kHz(c)} (sans doute un MP3 / AAC ≈ 192 kbps)` });
        else if (c <= 20900) out.push({ level: 'warn', text: `Spectre coupé à ${kHz(c)} : peut-être un MP3 320 kbps (ou un mastering filtré)` });
      } else if (p.bitrate >= 256) {
        if (c <= 17500) out.push({ level: 'bad', text: `Ré-encodé : spectre coupé à ${kHz(c)} malgré ${p.bitrate} kbps (source ≈ 128 kbps)` });
        else if (c <= 19600) out.push({ level: 'warn', text: `Spectre coupé à ${kHz(c)} malgré ${p.bitrate} kbps (source ≈ 192 kbps ?)` });
      }
    }
    if (q.clipPerMin >= 200) out.push({ level: 'bad', text: `Saturation forte (${Math.round(q.clipPerMin)} écrêtages / min)` });
    else if (q.clipPerMin >= 20) out.push({ level: 'warn', text: `Saturation (${Math.round(q.clipPerMin)} écrêtages / min)` });
    if (q.fakeStereo) out.push({ level: 'warn', text: 'Mono enregistré en stéréo (gauche = droite)' });
    if (q.leadSilence >= 2) out.push({ level: 'info', text: `Silence de ${String(q.leadSilence).replace('.', ',')} s au début` });
    if (q.trailSilence >= 4) out.push({ level: 'info', text: `Silence de ${String(q.trailSilence).replace('.', ',')} s à la fin` });
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
  // → Map id -> { group: key, size, best }
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
        cluster.forEach((t, i) => out.set(t.id, { group: key, size: cluster.length, best: i === 0 }));
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
