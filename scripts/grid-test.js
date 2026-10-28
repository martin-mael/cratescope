'use strict';
// Synthetic ground-truth test for BPM, beat grid, downbeat and drop detection.
// usage: node scripts/grid-test.js
const { analyze, SR } = require('../src/analysis/dsp');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function synth({ bpm, preroll, pickup, style, seed = 1 }) {
  const rand = rng(seed);
  const beat = 60 / bpm;
  // structure in bars: intro (drums), break (pad only), drop (full), outro (drums)
  const parts = [['intro', 16], ['break', 8], ['drop', 32], ['outro', 8]];
  const totalBars = parts.reduce((s, p) => s + p[1], 0);
  const firstDownbeat = preroll + pickup * beat;
  const len = Math.ceil((firstDownbeat + totalBars * 4 * beat + 2) * SR);
  const x = new Float32Array(len);
  const add = (t0, dur, fn) => {
    const s = Math.round(t0 * SR);
    for (let i = 0; i < dur * SR && s + i < len; i++) if (s + i >= 0) x[s + i] += fn(i / SR);
  };
  const kick = (t0, v = 1) => {
    let ph = 0;
    add(t0, 0.3, (t) => { ph += (2 * Math.PI * (45 + 80 * Math.exp(-t / 0.03))) / SR; return 0.9 * v * Math.exp(-t / 0.16) * Math.sin(ph); });
  };
  const snare = (t0, v = 1) => add(t0, 0.25, (t) => v * (0.35 * (rand() * 2 - 1) * Math.exp(-t / 0.06) + 0.2 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05)));
  const hat = (t0, v = 1) => { let prev = 0; add(t0, 0.06, (t) => { const n = rand() * 2 - 1; const y = n - prev; prev = n; return 0.12 * v * y * Math.exp(-t / 0.015); }); };
  const roots = [55, 43.65, 65.41, 49];
  const tone = (t0, dur, f, a) => add(t0, dur, (t) => a * Math.sin(2 * Math.PI * f * t) * Math.min(1, t / 0.01, (dur - t) / 0.02));

  // pickup beats before bar 1 (anacrusis): hats only
  for (let b = 0; b < pickup; b++) hat(preroll + b * beat);
  let bar = 0;
  const truth = { downbeat: firstDownbeat, drop: null, beat };
  for (const [name, n] of parts) {
    if (name === 'drop') truth.drop = firstDownbeat + bar * 4 * beat;
    for (let j = 0; j < n; j++, bar++) {
      const t = firstDownbeat + bar * 4 * beat;
      const v = () => 0.85 + 0.15 * rand();
      if (j % 8 === 0) add(t, 1.2, (tt) => 0.15 * (rand() * 2 - 1) * Math.exp(-tt / 0.4)); // crash on phrase start
      if (name === 'break') {
        for (const f of [220, 261.63, 329.63]) tone(t, 4 * beat, f * (roots[bar % 4] / 55), 0.06);
        continue;
      }
      const drums = name !== 'break';
      if (drums) {
        if (style === 'house') {
          for (let b = 0; b < 4; b++) { kick(t + b * beat, v()); hat(t + (b + 0.5) * beat, v()); }
          snare(t + beat, 0.7 * v()); snare(t + 3 * beat, 0.7 * v());
        } else {
          kick(t, v()); kick(t + 2.5 * beat, 0.9 * v());
          snare(t + beat, v()); snare(t + 3 * beat, v());
          for (let h = 0; h < 8; h++) hat(t + h * 0.5 * beat, v());
        }
      }
      if (name === 'drop') tone(t, 4 * beat, roots[bar % 4], 0.35);
    }
  }
  for (let i = 0; i < len; i++) x[i] = Math.tanh(x[i]) + 0.002 * (rand() * 2 - 1);
  return { pcm: x, truth };
}

const CASES = [
  { bpm: 124, preroll: 0.437, pickup: 0, style: 'house' },
  { bpm: 128, preroll: 1.9, pickup: 1, style: 'house' },
  { bpm: 140.5, preroll: 0.05, pickup: 2, style: 'house' },
  { bpm: 174, preroll: 0.81, pickup: 0, style: 'breaks' },
  { bpm: 170, preroll: 2.33, pickup: 3, style: 'breaks' },
  { bpm: 93, preroll: 0.6, pickup: 1, style: 'breaks' },
  { bpm: 160, preroll: 0.0, pickup: 0, style: 'breaks' },
];

let ok = 0;
const signed = [];
for (const [i, c] of CASES.entries()) {
  const { pcm, truth } = synth({ ...c, seed: i + 7 });
  const a = analyze(pcm, { minBpm: 88, maxBpm: 180 });
  const beat = 60 / a.bpm;
  // grid error over the drop section (beats of the true grid)
  const errs = [];
  for (let k = 0; k < 128; k++) {
    const tt = truth.drop + k * truth.beat;
    const n = Math.round((tt - a.beatOffset) / beat);
    errs.push((a.beatOffset + n * beat - tt) * 1000);
  }
  const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
  const maxAbs = Math.max(...errs.map(Math.abs));
  const dbBeats = Math.round((a.downbeat - truth.downbeat) / truth.beat);
  const dbOk = ((dbBeats % 4) + 4) % 4 === 0;
  const dropOk = a.mainDrop != null && Math.abs(a.mainDrop - truth.drop) < truth.beat / 2;
  const bpmOk = Math.abs(a.bpm - c.bpm) < 0.02;
  const pass = bpmOk && maxAbs < 10 && dbOk;
  if (pass) ok++;
  signed.push(mean);
  console.log(`${c.style.padEnd(6)} ${String(c.bpm).padStart(5)} → ${String(a.bpm).padStart(6)} ${bpmOk ? '✓' : '✗'}  grid mean ${mean.toFixed(1)}ms max ${maxAbs.toFixed(1)}ms ${maxAbs < 10 ? '✓' : '✗'}  bar1 ${dbOk ? '✓' : `✗ (${dbBeats} beats, conf ${a.downbeatConfidence})`}  drop ${dropOk ? '✓' : `✗ (${a.mainDrop} vs ${truth.drop.toFixed(2)})`}  stable ${a.tempoStable} rms ${a.gridRmsMs}ms  sections ${a.sections.map((s) => s.type[0] + s.bar).join(' ')}`);
}
console.log(`\n${ok}/${CASES.length} passed · mean signed grid error ${(signed.reduce((s, v) => s + v, 0) / signed.length).toFixed(2)} ms`);
process.exitCode = ok === CASES.length ? 0 : 1;
