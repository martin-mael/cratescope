'use strict';
// Sanity check of an ffmpeg/ffprobe pair + the analyser (used in CI on the bundled binaries).
// usage: node scripts/ci-check.js [dir containing ffmpeg/ffprobe]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const dir = process.argv[2];
const exe = process.platform === 'win32' ? '.exe' : '';
if (dir) {
  process.env.CRATESCOPE_FFMPEG = path.resolve(dir, 'ffmpeg' + exe);
  process.env.CRATESCOPE_FFPROBE = path.resolve(dir, 'ffprobe' + exe);
}
const { probe, decode, FFMPEG, FFPROBE } = require('../src/analysis/ffmpeg');
const { analyze } = require('../src/analysis/dsp');

(async () => {
  console.log('ffmpeg :', FFMPEG);
  console.log('ffprobe:', FFPROBE);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')), 'click.flac');
  // 40 s: 128 BPM clicks over an A minor triad
  const expr = "0.6*(lt(mod(t,60/128),0.03))*sin(2*PI*1500*t)+0.15*(sin(2*PI*110*t)+sin(2*PI*220*t)+sin(2*PI*261.63*t)+sin(2*PI*329.63*t))";
  execFileSync(FFMPEG, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}':s=44100:d=40`,
    '-metadata', 'artist=CI', '-metadata', 'title=Click', '-y', out], { windowsHide: true });
  const p = await probe(out);
  const d = await decode(out);
  const a = analyze(d.pcm, { lufs: d.lufs });
  const res = { title: p.tags.title, duration: p.duration, bpm: a.bpm, key: `${a.camelot} ${a.key}`, lufs: d.lufs };
  console.log(res);
  const fail = [];
  if (res.title !== 'Click') fail.push('tags');
  if (Math.abs(res.duration - 40) > 0.5) fail.push('duration');
  if (Math.abs(a.bpm - 128) > 1) fail.push('bpm');
  if (d.lufs == null) fail.push('loudness');
  if (fail.length) { console.error('FAILED:', fail.join(', ')); process.exit(1); }
  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
