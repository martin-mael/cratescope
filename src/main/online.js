'use strict';
// Online metadata enrichment: MusicBrainz (no key) + Discogs (gives genre AND style).
// Discogs accepts a personal access token, or an application's consumer key + secret (enough for search).
// In Electron use Chromium's network stack (browser-like, the same one the app's pages use);
// plain fetch when run from Node (scripts / tests).
const httpFetch = (() => {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch.bind(net);
  } catch {}
  return fetch;
})();

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
  // a slow answer (Discogs sometimes takes 20 s+) must not stall the serialized queue
  const res = await httpFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) });
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

// Discogs search works without credentials (25 requests/min, no cover images). A personal token
// or an application's consumer key + secret raises that to 60/min and returns covers.
function discogsAuth(s) {
  if (s.discogsToken) return { Authorization: `Discogs token=${s.discogsToken}` };
  if (s.discogsKey && s.discogsSecret) return { Authorization: `Discogs key=${s.discogsKey}, secret=${s.discogsSecret}` };
  return null;
}

async function discogs(artist, title, settings) {
  const auth = discogsAuth(settings);
  dgLimiter.interval = auth ? 1100 : 2500;
  const headers = auth || {};
  const base = 'https://api.discogs.com/database/search?type=release&per_page=5';
  let j = await dgLimiter.run(() => getJson(`${base}&artist=${encodeURIComponent(artist || '')}&track=${encodeURIComponent(title)}`, headers));
  if (!j.results || !j.results.length) {
    j = await dgLimiter.run(() => getJson(`${base}&q=${encodeURIComponent(`${artist || ''} ${title}`.trim())}`, headers));
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

// newer result first, earlier one fills the gaps
function merge(prev, next) {
  return {
    genres: uniq([...(next.genres || []), ...(prev.genres || [])]).slice(0, 6),
    styles: uniq([...(next.styles || []), ...(prev.styles || [])]).slice(0, 8),
    year: next.year || prev.year || null,
    label: next.label || prev.label || null,
    country: next.country || prev.country || null,
    album: prev.album || next.album || null,
    coverUrl: next.coverUrl || prev.coverUrl || null,
    discogsUrl: next.discogsUrl || prev.discogsUrl || null,
    mbUrl: prev.mbUrl || next.mbUrl || null,
    sources: uniq([...(next.sources || []), ...(prev.sources || [])]),
    tried: uniq([...(next.tried || []), ...(prev.tried || prev.sources || [])]),
    fetchedAt: next.fetchedAt,
  };
}

// previous: an earlier result to complete with Discogs only (no new MusicBrainz request)
async function lookup({ artist, title: t }, settings, previous = null) {
  const useMb = settings.useMusicBrainz && !previous;
  const useDg = settings.useDiscogs !== false;
  if (!t) return { notFound: true, tried: [useDg && 'Discogs', useMb && 'MusicBrainz'].filter(Boolean), fetchedAt: Date.now() };
  const [mb, dg] = await Promise.all([
    useMb ? musicbrainz(artist, t).catch((e) => ({ error: e.message })) : null,
    useDg ? discogs(artist, t, settings).catch((e) => ({ error: e.message })) : null,
  ]);
  const ok = (x) => x && !x.error;
  // a source counts as tried when it answered, even "not found"; errors are retried later
  const tried = [useDg && !(dg && dg.error) && 'Discogs', useMb && !(mb && mb.error) && 'MusicBrainz'].filter(Boolean);
  let res;
  if (!ok(mb) && !ok(dg)) {
    const err = (mb && mb.error) || (dg && dg.error);
    res = err && !tried.length ? { error: err, tried, fetchedAt: Date.now() } : { notFound: true, tried, fetchedAt: Date.now() };
  } else {
    const m = ok(mb) ? mb : {}, d = ok(dg) ? dg : {};
    res = {
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
      tried,
      fetchedAt: Date.now(),
    };
  }
  if (!previous || previous.error) return res;
  const merged = merge(previous, res);
  if (!merged.sources.length) merged.notFound = true;
  return merged;
}

module.exports = { lookup, discogsAuth };
