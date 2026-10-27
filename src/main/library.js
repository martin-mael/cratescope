'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const online = require('./online');

const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aif', 'aiff', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'alac', 'wma', 'ape', 'wv', 'mp4', 'webm', 'mka']);

const hashId = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);

// "01 - Artist - Title", "Artist - Album - 08 Title", "06-artist_name-title-grp"…
function parseFilename(name) {
  let s = name.replace(/\.[^.]+$/, '');
  if (!/\s/.test(s)) s = s.replace(/_/g, ' ');
  s = s.replace(/\s*\[(free download|lossless|free dl)[^\]]*\]/ig, '').trim();
  s = s.replace(/^\d{1,3}[\s._)-]+(?=\D)/, '');
  let parts = s.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1 && /-/.test(s) && !/\s/.test(name)) parts = s.split('-').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3 && /^\d{1,3}[\s.]/.test(parts[parts.length - 1])) {
    return { artist: parts[0], title: parts[parts.length - 1].replace(/^\d{1,3}[\s.]+/, '') };
  }
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return { artist: '', title: s };
}

class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.timer = null;
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2500);
  }
  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

class Library extends EventEmitter {
  constructor(dataDir, getSettings) {
    super();
    this.dataDir = dataDir;
    this.getSettings = getSettings;
    this.wavesDir = path.join(dataDir, 'waves');
    this.coversDir = path.join(dataDir, 'covers');
    this.playDir = path.join(dataDir, 'playback');
    fs.mkdirSync(this.wavesDir, { recursive: true });
    this.cache = new JsonStore(path.join(dataDir, 'library.json'));
    this.root = null;
    this.tracks = new Map(); // id -> track
    this.dirty = new Set();
    this.workers = [];
    this.idle = [];
    this.focusQueue = [];
    this.probeQueue = []; this.probeIdx = 0;
    this.analyzeQueue = []; this.analyzeIdx = 0;
    this.onlineQueue = []; this.onlineBusy = 0;
    this.watcher = null;
    this.flushTimer = setInterval(() => this.flushUpdates(), 200);
    this.startWorkers();
  }

  startWorkers() {
    const n = Math.max(1, Math.min(this.getSettings().concurrency || os.cpus().length - 1, 16));
    for (let i = 0; i < n; i++) {
      const w = new Worker(path.join(__dirname, 'worker.js'));
      w.on('message', (m) => this.onResult(w, m));
      w.on('error', (e) => console.error('worker error', e));
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  // ---------- scanning ----------
  async open(root) {
    this.root = root;
    this.tracks.clear();
    this.focusQueue = []; this.probeQueue = []; this.analyzeQueue = []; this.onlineQueue = [];
    this.probeIdx = this.analyzeIdx = 0;
    await this.scan();
    this.watch();
    return this.snapshot();
  }

  async walk(dir, out) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const subs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) subs.push(this.walk(full, out));
      else if (e.isFile() || e.isSymbolicLink()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (AUDIO_EXT.has(ext)) out.push(full);
      }
    }
    await Promise.all(subs);
  }

  async scan() {
    const files = [];
    await this.walk(this.root, files);
    const seen = new Set();
    const stats = await Promise.all(files.map((f) => fsp.stat(f).catch(() => null)));
    files.forEach((file, i) => {
      const st = stats[i];
      if (!st || !st.isFile()) return;
      const id = hashId(file);
      seen.add(id);
      const existing = this.tracks.get(id);
      if (existing && existing.size === st.size && existing.mtime === st.mtimeMs) return;
      this.addTrack(id, file, st);
    });
    for (const id of [...this.tracks.keys()]) {
      if (!seen.has(id)) { this.tracks.delete(id); this.emit('removed', id); }
    }
    this.pump();
  }

  addTrack(id, file, st) {
    const rel = path.relative(this.root, file);
    const name = path.basename(file);
    const c = this.cache.data[file];
    const valid = c && c.size === st.size && c.mtime === st.mtimeMs;
    const parsed = parseFilename(name);
    const t = {
      id, path: file, rel, name,
      dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      ext: path.extname(name).slice(1).toLowerCase(),
      size: st.size, mtime: st.mtimeMs,
      fileUrl: pathToFileURL(file).href,
      parsed,
      probe: valid ? c.probe || null : null,
      analysis: valid ? c.analysis || null : null,
      mini: valid ? c.mini || null : null,
      online: c && c.online ? c.online : null, // online data survives file edits
      error: null,
      busy: false,
    };
    const s = this.getSettings();
    if (t.analysis && (t.analysis.minBpm !== s.minBpm || t.analysis.maxBpm !== s.maxBpm)) t.staleRange = true;
    this.tracks.set(id, t);
    if (!t.probe) this.probeQueue.push(id);
    if (!t.analysis) this.analyzeQueue.push(id);
    if (t.probe) this.queueOnline(t);
    this.dirty.add(id);
  }

  watch() {
    if (this.watcher) this.watcher.close();
    let timer = null;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.scan().then(() => this.emit('rescanned')), 1500);
      });
    } catch { this.watcher = null; }
  }

  // ---------- scheduling ----------
  focus(dir, recursive) {
    const ids = [];
    for (const t of this.tracks.values()) {
      const inDir = recursive ? (dir === '' || t.dir === dir || t.dir.startsWith(dir + path.sep)) : t.dir === dir;
      if (inDir && (!t.probe || !t.analysis)) ids.push(t.id);
    }
    this.focusQueue = ids;
    this.pump();
  }

  nextJob() {
    const s = this.getSettings();
    const mk = (t, kind) => ({ id: t.id, path: t.path, kind, needProbe: !t.probe, minBpm: s.minBpm, maxBpm: s.maxBpm });
    while (this.focusQueue.length) {
      const t = this.tracks.get(this.focusQueue.shift());
      if (t && !t.busy && !t.error && (!t.analysis || !t.probe)) return mk(t, 'analyze');
    }
    while (this.probeIdx < this.probeQueue.length) {
      const t = this.tracks.get(this.probeQueue[this.probeIdx++]);
      if (t && !t.busy && !t.probe && !t.error) return mk(t, 'probe');
    }
    while (this.analyzeIdx < this.analyzeQueue.length) {
      const t = this.tracks.get(this.analyzeQueue[this.analyzeIdx++]);
      if (t && !t.busy && !t.analysis && !t.error) return mk(t, 'analyze');
    }
    return null;
  }

  pump() {
    while (this.idle.length) {
      const job = this.nextJob();
      if (!job) break;
      const w = this.idle.pop();
      this.tracks.get(job.id).busy = true;
      this.dirty.add(job.id);
      w.postMessage(job);
    }
  }

  onResult(w, m) {
    this.idle.push(w);
    const t = this.tracks.get(m.id);
    if (t) {
      t.busy = false;
      if (!m.ok) {
        t.error = m.error;
      } else {
        if (m.probe) { t.probe = m.probe; this.queueOnline(t); }
        if (m.analysis) {
          const s = this.getSettings();
          t.analysis = { ...m.analysis, minBpm: s.minBpm, maxBpm: s.maxBpm };
          t.staleRange = false;
          t.mini = Buffer.from(m.waves.mini).toString('base64');
          this.writeWaves(t.id, m.waves);
        }
        this.persist(t);
      }
      this.dirty.add(t.id);
    }
    this.pump();
  }

  writeWaves(id, waves) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(waves.overview.length / 4, 0);
    head.writeUInt32LE(waves.detail.length / 4, 4);
    fs.writeFile(path.join(this.wavesDir, id + '.bin'), Buffer.concat([head, Buffer.from(waves.overview), Buffer.from(waves.detail)]), () => {});
  }

  readWaves(id) {
    try {
      const b = fs.readFileSync(path.join(this.wavesDir, id + '.bin'));
      const nO = b.readUInt32LE(0), nD = b.readUInt32LE(4);
      return {
        overview: new Uint8Array(b.buffer, b.byteOffset + 8, nO * 4).slice(),
        detail: new Uint8Array(b.buffer, b.byteOffset + 8 + nO * 4, nD * 4).slice(),
      };
    } catch { return null; }
  }

  persist(t) {
    this.cache.data[t.path] = { size: t.size, mtime: t.mtime, probe: t.probe, analysis: t.analysis, mini: t.mini, online: t.online };
    this.cache.save();
  }

  reanalyze(ids) {
    for (const id of ids) {
      const t = this.tracks.get(id);
      if (!t) continue;
      t.analysis = null; t.error = null;
      this.analyzeQueue.push(id);
      this.dirty.add(id);
    }
    this.focusQueue.unshift(...ids);
    this.pump();
  }

  reanalyzeStale() {
    this.reanalyze([...this.tracks.values()].filter((t) => t.staleRange).map((t) => t.id));
  }

  // ---------- online enrichment ----------
  queryFor(t) {
    const tg = (t.probe && t.probe.tags) || {};
    const artist = tg.artist || t.parsed.artist;
    const title = tg.title || t.parsed.title;
    return { artist, title: (title || '').replace(/\s*\((original mix|extended mix)\)/i, '') };
  }

  queueOnline(t, force = false) {
    const s = this.getSettings();
    if (!force && (!s.autoOnline || t.online)) return;
    if (!s.useMusicBrainz && !s.discogsToken) return;
    if (t.onlinePending) return;
    t.onlinePending = true;
    if (force) this.onlineQueue.unshift(t.id); else this.onlineQueue.push(t.id);
    this.pumpOnline();
  }

  pumpOnline() {
    while (this.onlineBusy < 3 && this.onlineQueue.length) {
      const t = this.tracks.get(this.onlineQueue.shift());
      if (!t) continue;
      this.onlineBusy++;
      online.lookup(this.queryFor(t), this.getSettings())
        .then((res) => { t.online = res; })
        .catch((e) => { t.online = { error: e.message, fetchedAt: Date.now() }; })
        .finally(() => {
          t.onlinePending = false;
          this.onlineBusy--;
          this.persist(t);
          this.dirty.add(t.id);
          this.pumpOnline();
        });
    }
  }

  refetchOnline(ids) {
    for (const id of ids) { const t = this.tracks.get(id); if (t) this.queueOnline(t, true); }
  }

  // ---------- renderer data ----------
  publicTrack(t) {
    const { busy, error, onlinePending, staleRange, ...rest } = t;
    return { ...rest, status: error ? 'error' : busy ? 'busy' : t.analysis ? 'done' : 'pending', error, onlinePending: !!onlinePending, staleRange: !!staleRange };
  }

  stats() {
    let probed = 0, analyzed = 0, errors = 0, busy = 0;
    for (const t of this.tracks.values()) {
      if (t.probe) probed++;
      if (t.analysis) analyzed++;
      if (t.error) errors++;
      if (t.busy) busy++;
    }
    return { total: this.tracks.size, probed, analyzed, errors, busy, online: this.onlineQueue.length + this.onlineBusy };
  }

  snapshot() {
    return { root: this.root, tracks: [...this.tracks.values()].map((t) => this.publicTrack(t)), stats: this.stats() };
  }

  flushUpdates() {
    if (!this.dirty.size) return;
    const tracks = [];
    for (const id of this.dirty) { const t = this.tracks.get(id); if (t) tracks.push(this.publicTrack(t)); }
    this.dirty.clear();
    this.emit('update', { tracks, stats: this.stats() });
  }

  get(id) { return this.tracks.get(id); }

  close() {
    clearInterval(this.flushTimer);
    if (this.watcher) this.watcher.close();
    this.cache.flush();
    for (const w of this.workers) w.terminate();
  }
}

module.exports = { Library, parseFilename };
