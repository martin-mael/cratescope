'use strict';
// Online metadata enrichment: MusicBrainz (no key) + Discogs (personal token, gives genre AND style).
const UA = 'CrateScope/0.1 (local DJ library analyser)';

class RateLimited {
  constructor(intervalMs) { this.interval = intervalMs; this.last = 0; this.chain = Promise.resolve(); }
  run(fn) {
    const p = this.chain.then(async () => {
      const wait = this.last + this.interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = p.catch(() => {});
    return p;
  }
}

const mbLimiter = new RateLimited(1100);
const dgLimiter = new RateLimited(1100);

async function getJson(url, headers = {}, attempt = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if ((res.status === 503 || res.status === 429) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return getJson(url, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const luceneEscape = (s) => s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
const topNames = (arr, n = 6) => (arr || [])
  .filter((g) => g && g.name)
  .sort((a, b) => (b.count || 0) - (a.count || 0))
  .slice(0, n)
  .map((g) => g.name);

async function musicbrainz(artist, title) {
  const q = `recording:"${luceneEscape(title)}"` + (artist ? ` AND artist:"${luceneEscape(artist)}"` : '');
  const search = await mbLimiter.run(() => getJson(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=${encodeURIComponent(q)}`));
  const rec = (search.recordings || []).find((r) => (r.score || 0) >= 85);
  if (!rec) return null;
  const full = await mbLimiter.run(() => getJson(`https://musicbrainz.org/ws/2/recording/${rec.id}?fmt=json&inc=genres+tags+releases+artist-credits`));
  let genres = topNames(full.genres);
  let tags = topNames(full.tags);
  const artistId = full['artist-credit'] && full['artist-credit'][0] && full['artist-credit'][0].artist.id;
  if (!genres.length && artistId) {
    const a = await mbLimiter.run(() => getJson(`https://musicbrainz.org/ws/2/artist/${artistId}?fmt=json&inc=genres+tags`));
    genres = topNames(a.genres);
    if (!tags.length) tags = topNames(a.tags);
  }
  const release = (full.releases || [])[0];
  return {
    mbid: rec.id,
    mbUrl: `https://musicbrainz.org/recording/${rec.id}`,
    genres,
    tags: tags.filter((t) => !genres.includes(t)),
    year: (full['first-release-date'] || '').slice(0, 4) || null,
    album: release ? release.title : null,
    coverUrl: release ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
  };
}

async function discogs(artist, title, token) {
  if (!token) return null;
  const base = 'https://api.discogs.com/database/search?type=release&per_page=5';
  const auth = { Authorization: `Discogs token=${token}` };
  let j = await dgLimiter.run(() => getJson(`${base}&artist=${encodeURIComponent(artist || '')}&track=${encodeURIComponent(title)}`, auth));
  if (!j.results || !j.results.length) {
    j = await dgLimiter.run(() => getJson(`${base}&q=${encodeURIComponent(`${artist || ''} ${title}`.trim())}`, auth));
  }
  const r = (j.results || [])[0];
  if (!r) return null;
  return {
    discogsUrl: r.uri ? `https://www.discogs.com${r.uri}` : null,
    genres: r.genre || [],
    styles: r.style || [],
    year: r.year ? String(r.year) : null,
    label: (r.label || [])[0] || null,
    country: r.country || null,
    coverUrl: r.cover_image && !/spacer\.gif/.test(r.cover_image) ? r.cover_image : null,
  };
}

const uniq = (a) => [...new Set(a.filter(Boolean).map((s) => s.trim()))];
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

async function lookup({ artist, title: t }, settings) {
  if (!t) return { notFound: true, fetchedAt: Date.now() };
  const [mb, dg] = await Promise.all([
    settings.useMusicBrainz ? musicbrainz(artist, t).catch((e) => ({ error: e.message })) : null,
    settings.discogsToken ? discogs(artist, t, settings.discogsToken).catch((e) => ({ error: e.message })) : null,
  ]);
  const ok = (x) => x && !x.error;
  if (!ok(mb) && !ok(dg)) {
    const err = (mb && mb.error) || (dg && dg.error);
    return err ? { error: err, fetchedAt: Date.now() } : { notFound: true, fetchedAt: Date.now() };
  }
  const m = ok(mb) ? mb : {}, d = ok(dg) ? dg : {};
  return {
    genres: uniq([...(d.genres || []), ...(m.genres || []).map(title)]).slice(0, 6),
    styles: uniq([...(d.styles || []), ...(m.tags || []).map(title)]).slice(0, 8),
    year: d.year || m.year || null,
    label: d.label || null,
    country: d.country || null,
    album: m.album || null,
    coverUrl: d.coverUrl || m.coverUrl || null,
    discogsUrl: d.discogsUrl || null,
    mbUrl: m.mbUrl || null,
    sources: [ok(dg) && 'Discogs', ok(mb) && 'MusicBrainz'].filter(Boolean),
    fetchedAt: Date.now(),
  };
}

module.exports = { lookup };
