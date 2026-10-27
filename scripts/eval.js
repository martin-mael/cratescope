'use strict';
// Benchmark the analyser against BPM/key tags already present in a folder.
// usage: node scripts/eval.js <folder>
const fs = require('fs');
const path = require('path');
const { probe, decode } = require('../src/analysis/ffmpeg');
const { analyze } = require('../src/analysis/dsp');
const { normalizeKey } = require('../src/shared/keys');

const EXT = /\.(mp3|wav|flac|aiff?|ogg|opus|m4a|aac|alac|wma)$/i;

(async () => {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter((f) => EXT.test(f)).map((f) => path.join(dir, f));
  let nb = 0, okB = 0, okBo = 0, nk = 0, okK = 0, okKr = 0;
  const t0 = Date.now();
  for (const f of files) {
    const p = await probe(f);
    const t1 = Date.now();
    const d = await decode(f);
    const t2 = Date.now();
    const a = analyze(d.pcm, { lufs: d.lufs });
    const t3 = Date.now();
    const tb = parseFloat(p.tags.tagBpm);
    const tk = normalizeKey(p.tags.tagKey);
    let mark = '';
    if (tb > 0) {
      nb++;
      if (Math.abs(tb - a.bpm) <= 0.6) okB++;
      if ([1, 2, 0.5, 1.5, 2 / 3].some((m) => Math.abs(tb * m - a.bpm) <= 0.6)) okBo++;
      else mark += ' BPM✗';
    }
    if (tk) {
      nk++;
      if (tk === a.camelot) okK++;
      const [n, l] = [parseInt(tk, 10), tk.slice(-1)];
      const [an, al] = [parseInt(a.camelot, 10), a.camelot.slice(-1)];
      if (tk === a.camelot || (n === an) || (l === al && (Math.abs(n - an) === 1 || Math.abs(n - an) === 11))) okKr++;
      else mark += ' KEY✗';
    }
    console.log(`${path.basename(f).slice(0, 50).padEnd(50)} bpm ${String(a.bpm).padStart(6)} (tag ${p.tags.tagBpm || '-'}) key ${a.camelot.padStart(3)} ${a.key.padEnd(3)} (tag ${p.tags.tagKey || '-'}→${tk || '-'}) lufs ${d.lufs} E${a.energy}  dec ${t2 - t1}ms dsp ${t3 - t2}ms${mark}`);
  }
  console.log(`\nBPM exact ${okB}/${nb}, incl. octave ${okBo}/${nb}; key exact ${okK}/${nk}, neighbour/relative ${okKr}/${nk}; total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
