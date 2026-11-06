'use strict';
// Listening history: one session per app launch (created on the first played track), the tracks in
// the order they were played (>= 30 s of actual playback, measured by the renderer).
// Stored in userData/history.json.
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { hashId } = require('./library');

const MAX_SESSIONS = 300;

class History extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.sessions = [];
    try { this.sessions = JSON.parse(fs.readFileSync(file, 'utf8')).sessions || []; } catch {}
    this.current = null; // id of this launch's session
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ sessions: this.sessions }));
    fs.renameSync(tmp, this.file);
    this.emit('change');
  }

  get(id) { return this.sessions.find((s) => s.id === id); }

  add(path) {
    let s = this.current && this.get(this.current);
    if (!s) {
      s = { id: crypto.randomBytes(6).toString('hex'), start: Date.now(), end: Date.now(), tracks: [] };
      this.sessions.push(s);
      this.current = s.id;
      if (this.sessions.length > MAX_SESSIONS) this.sessions.splice(0, this.sessions.length - MAX_SESSIONS);
    }
    s.tracks.push({ path, at: Date.now() });
    s.end = Date.now();
    this.save();
  }

  // "mark as not played": out of this session
  unplay(paths) {
    const s = this.current && this.get(this.current);
    if (!s) return;
    const drop = new Set(paths);
    s.tracks = s.tracks.filter((x) => !drop.has(x.path));
    this.save();
  }

  remove(id) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.current === id) this.current = null;
    this.save();
  }

  sessionIds() {
    const s = this.current && this.get(this.current);
    return new Set(s ? s.tracks.map((x) => hashId(x.path)) : []);
  }

  // for the renderer: sessions newest first (track ids in play order, unique) + play counts by id
  public() {
    const counts = {};
    for (const s of this.sessions) for (const x of s.tracks) { const id = hashId(x.path); counts[id] = (counts[id] || 0) + 1; }
    const sessions = [...this.sessions].reverse().filter((s) => s.tracks.length).map((s) => ({
      id: s.id, start: s.start, end: s.end, current: s.id === this.current,
      ids: [...new Set(s.tracks.map((x) => hashId(x.path)))],
    }));
    return { sessions, counts, current: [...this.sessionIds()] };
  }

  paths(id) {
    const s = this.get(id);
    return s ? [...new Set(s.tracks.map((x) => x.path))] : [];
  }
}

module.exports = { History };
