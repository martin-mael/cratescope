'use strict';
// App-wide playlists, independent of the folder being browsed: each one is an ordered list of
// absolute file paths, stored in userData/playlists.json.
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class Playlists extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.list = [];
    try { this.list = JSON.parse(fs.readFileSync(file, 'utf8')).playlists || []; } catch {}
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ playlists: this.list }, null, 1));
    fs.renameSync(tmp, this.file);
    this.emit('change');
  }

  get(id) { return this.list.find((p) => p.id === id); }

  allPaths() { return [...new Set(this.list.flatMap((p) => p.paths))]; }

  create(name, paths = []) {
    const p = { id: crypto.randomBytes(6).toString('hex'), name: name.trim() || 'Nouvelle playlist', paths: [...new Set(paths)], created: Date.now() };
    this.list.push(p);
    this.save();
    return p;
  }

  rename(id, name) {
    const p = this.get(id);
    if (!p || !name.trim()) return;
    p.name = name.trim();
    this.save();
  }

  remove(id) {
    this.list = this.list.filter((p) => p.id !== id);
    this.save();
  }

  // appends, skipping tracks already in the playlist; returns how many were added
  add(id, paths) {
    const p = this.get(id);
    if (!p) return 0;
    const have = new Set(p.paths);
    const fresh = [...new Set(paths)].filter((x) => !have.has(x));
    p.paths.push(...fresh);
    if (fresh.length) this.save();
    return fresh.length;
  }

  removeTracks(id, paths) {
    const p = this.get(id);
    if (!p) return;
    const drop = new Set(paths);
    p.paths = p.paths.filter((x) => !drop.has(x));
    this.save();
  }
}

module.exports = { Playlists };
