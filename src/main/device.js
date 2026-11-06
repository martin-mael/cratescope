'use strict';
// "Copy to a USB stick": copies the files of one or more playlists to a folder on the stick
// (<dest>/<Playlist>/<Artist - Title>.ext), carries their analysis over to the copies (no re-analysis
// when the stick is opened), and writes a rekordbox XML next to them that points to the copies.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const meta = require('../shared/meta');
const { hashId } = require('./library');
const { buildXml, mp3Offsets, KIND } = require('./rekordbox');

// FAT32 / exFAT: no \ / : * ? " < > |, no control chars, no trailing dot or space, short enough
const fatName = (s, max = 120) => String(s)
  .replace(/[\\/]/g, '-').replace(/:/g, ' -').replace(/[*?"<>|\u0000-\u001f]/g, '')
  .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, max).trim() || 'sans titre';

// lists: [{ name, paths }]; returns the copy plan without touching the disk
function plan(library, lists, dest) {
  const seen = new Map(); // source path -> destination (a track in several playlists is copied once)
  const taken = new Set();
  const files = [], skipped = [];
  const out = lists.map((l) => ({ name: l.name, paths: [] }));
  lists.forEach((l, li) => {
    const dir = path.join(dest, fatName(l.name, 80));
    for (const src of l.paths) {
      const t = library.get(hashId(src));
      if (!t || !fs.existsSync(src)) { skipped.push({ path: src, why: 'introuvable' }); continue; }
      if (!KIND[t.ext]) { skipped.push({ path: src, why: `format ${t.ext.toUpperCase()} non lu par rekordbox` }); continue; }
      if (!t.analysis || !t.analysis.bpm) { skipped.push({ path: src, why: 'pas encore analysé' }); continue; }
      let dst = seen.get(src);
      if (!dst) {
        const base = fatName(`${meta.artist(t) ? meta.artist(t) + ' - ' : ''}${meta.title(t)}`);
        dst = path.join(dir, `${base}.${t.ext}`);
        for (let n = 2; taken.has(dst.toLowerCase()); n++) dst = path.join(dir, `${base} (${n}).${t.ext}`);
        taken.add(dst.toLowerCase());
        seen.set(src, dst);
        files.push({ src, dst, size: t.size, track: t });
      }
      out[li].paths.push(dst);
    }
  });
  return { files, skipped, lists: out };
}

// already there with the same size and date (FAT keeps mtimes to 2 s)
async function upToDate(src, dst) {
  const [a, b] = await Promise.all([fsp.stat(src).catch(() => null), fsp.stat(dst).catch(() => null)]);
  return !!(a && b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) <= 2000);
}

// onProgress({ done, total, bytes, totalBytes, file }); job.cancelled stops between files
async function copyToDevice(library, lists, dest, { onProgress = () => {}, job = {}, today } = {}) {
  const p = plan(library, lists, dest);
  const todo = [];
  for (const f of p.files) if (!(await upToDate(f.src, f.dst))) todo.push(f);
  const need = todo.reduce((s, f) => s + f.size, 0);
  const fsInfo = await fsp.statfs(dest).catch(() => null);
  if (fsInfo && fsInfo.bavail * fsInfo.bsize < need + 5e6) {
    throw new Error(`Pas assez de place : ${(need / 1e9).toFixed(2)} Go à copier, ${((fsInfo.bavail * fsInfo.bsize) / 1e9).toFixed(2)} Go libres`);
  }
  let bytes = 0, done = 0;
  for (const f of p.files) {
    if (job.cancelled) break;
    onProgress({ done, total: p.files.length, bytes, totalBytes: need, file: path.basename(f.dst) });
    if (todo.includes(f)) {
      await fsp.mkdir(path.dirname(f.dst), { recursive: true });
      const tmp = f.dst + '.cratescope-part';
      await fsp.copyFile(f.src, tmp);
      const st = await fsp.stat(f.src);
      await fsp.utimes(tmp, st.atime, st.mtime);
      await fsp.rename(tmp, f.dst);
      bytes += f.size;
    }
    library.cloneEntry(f.src, f.dst);
    done++;
  }
  if (job.cancelled) return { cancelled: true, copied: done, total: p.files.length };
  onProgress({ done, total: p.files.length, bytes, totalBytes: need, file: 'rekordbox XML' });

  // rekordbox XML on the stick, pointing to the copies (same analysis, manual grid edits included)
  const copies = p.files.map((f) => ({ ...f.track, path: f.dst, analysis: library.effectiveAnalysis(f.track) }));
  const offsets = await mp3Offsets(copies);
  const res = buildXml(copies, { playlists: p.lists, offsets, today });
  const xmlPath = path.join(dest, 'CrateScope-rekordbox.xml');
  await fsp.writeFile(xmlPath, res.xml);
  return { copied: todo.length, kept: p.files.length - todo.length, total: p.files.length, skipped: p.skipped, xmlPath, bytes };
}

module.exports = { copyToDevice, plan, fatName };
