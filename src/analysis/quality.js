'use strict';
// File quality check, run in the background after the main analysis (its own version, so changing it
// never re-analyses BPM / key / grid). One ffmpeg pass at the file's own sample rate, on excerpts
// (2 s every 30 s) to keep it cheap, plus a silencedetect branch over the whole file.
//  - spectrum cutoff: a lossless file whose spectrum stops dead at 16 / 19 / 20 kHz was made from a lossy one
//  - clipping: runs of consecutive samples at full scale
//  - fake stereo: left == right
//  - silence at the start / end
const { run, FFMPEG } = require('./ffmpeg');
const { fft } = require('./dsp')._internals;

const QUALITY_VERSION = 1;
const N = 4096;
const EVERY = 30, TAKE = 2; // seconds
const LOSSLESS = new Set(['flac', 'wav', 'aif', 'aiff', 'alac', 'ape', 'wv']);

async function scan(file) {
  const { code, stdout, stderr } = await run(FFMPEG, [
    '-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-i', file,
    '-filter_complex',
    `[0:a:0]asplit=2[a][b];[a]aselect='lt(mod(t\\,${EVERY})\\,${TAKE})',asetpts=N/SR/TB,aformat=sample_fmts=flt:channel_layouts=stereo[o];` +
    '[b]silencedetect=n=-60dB:d=1,anullsink',
    '-map', '[o]', '-f', 'f32le', 'pipe:1',
  ], { maxBuffer: 2 * 4 * 192000 * 60 * 8, timeout: 300000 });
  if (code !== 0 && !stdout.length) throw new Error('ffmpeg quality scan failed');
  const ab = new ArrayBuffer(stdout.length - (stdout.length % 8));
  new Uint8Array(ab).set(stdout.subarray(0, ab.byteLength));
  return { pcm: new Float32Array(ab), stderr };
}

// average spectrum of the non-silent excerpts, in 250 Hz bands, relative to the music's body
function spectrum(pcm, sr) {
  const frames = Math.floor(pcm.length / 2 / N);
  const power = new Float64Array(N / 2);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N), im = new Float64Array(N);
  let used = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const k = (f * N + i) * 2;
      const x = (pcm[k] + pcm[k + 1]) * 0.5;
      re[i] = x * win[i]; im[i] = 0; e += x * x;
    }
    if (e / N < 1e-6) continue; // below -60 dBFS: silence, says nothing about the encoder
    fft(re, im);
    for (let b = 0; b < N / 2; b++) power[b] += re[b] * re[b] + im[b] * im[b];
    used++;
  }
  if (used < 4) return null;
  const hz = sr / N;
  const db = (b0, b1) => { let s = 0; for (let b = b0; b < b1; b++) s += power[b]; return 10 * Math.log10(s / (b1 - b0) / used + 1e-30); };
  // 250 Hz bands
  const bw = Math.max(1, Math.round(250 / hz));
  const bands = [];
  for (let b = Math.round(1000 / hz); b + bw <= N / 2; b += bw) bands.push({ f: (b + bw) * hz, db: db(b, b + bw) });
  const ref = Math.max(...bands.filter((x) => x.f < 8000).map((x) => x.db)); // body of the music
  for (const b of bands) b.db -= ref;
  return { bands };
}

// An encoder's lowpass is a brick wall: a drop of 18+ dB within 750 Hz, then a flat floor up to Nyquist
// (window leakage keeps that floor ~45 dB under the music, not at -inf). Real lossless rolls off gradually.
// Returns the cutoff in Hz, or null when the spectrum goes all the way up.
function findCutoff(bands, from = 11000) {
  const lv = bands.map((b) => b.db);
  for (let i = bands.findIndex((b) => b.f >= from); i >= 0 && i < lv.length - 3; i++) {
    const floor = lv.slice(i + 1);
    const mean = floor.reduce((a, b) => a + b, 0) / floor.length;
    if (Math.max(...floor) - Math.min(...floor) > 6) continue;
    const edge = Math.max(...lv.slice(Math.max(0, i - 2), i + 1));
    if (edge - mean >= 18) return { cutoff: Math.round(bands[i].f), drop: Math.round(edge - mean) };
  }
  return null;
}

function silences(stderr, duration) {
  const starts = [...stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  let lead = 0, trail = 0;
  if (starts.length && starts[0] < 0.05) lead = ends[0] != null ? ends[0] : duration;
  const last = starts[starts.length - 1];
  if (starts.length && (ends.length < starts.length || ends[ends.length - 1] > duration - 0.1) && last > 0.05) trail = Math.max(0, duration - last);
  return { lead, trail };
}

function measure(pcm) {
  let peak = 0, clipRuns = 0, run = [0, 0], diff = 0, energy = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    for (let c = 0; c < 2; c++) {
      const a = Math.abs(pcm[i + c]);
      if (a > peak) peak = a;
      if (a >= 0.9999) { run[c]++; if (run[c] === 3) clipRuns++; } else run[c] = 0;
    }
    const d = pcm[i] - pcm[i + 1];
    diff += d * d; energy += pcm[i] * pcm[i];
  }
  return { peak, clipRuns, sideRatio: energy > 0 ? diff / energy : 1 };
}

// probe: { sampleRate, channels, bitrate, duration, codec }; ext: file extension
async function checkQuality(file, probe, ext) {
  const sr = probe.sampleRate || 44100;
  const { pcm, stderr } = await scan(file);
  const seconds = pcm.length / 2 / sr;
  const spec = spectrum(pcm, sr);
  const m = measure(pcm);
  const sil = silences(stderr, probe.duration || 0);
  const cut = spec && findCutoff(spec.bands);
  return {
    v: QUALITY_VERSION,
    seconds: Math.round(seconds),
    cutoff: cut ? cut.cutoff : null, // null: full band
    drop: cut ? cut.drop : null,
    nyquist: sr / 2,
    peakDb: m.peak > 0 ? Math.round(20 * Math.log10(m.peak) * 10) / 10 : -99,
    clipPerMin: seconds > 0 ? Math.round((m.clipRuns / seconds) * 60 * 10) / 10 : 0,
    fakeStereo: probe.channels >= 2 && m.sideRatio < 1e-7,
    leadSilence: Math.round(sil.lead * 10) / 10,
    trailSilence: Math.round(sil.trail * 10) / 10,
    lossless: LOSSLESS.has(ext) || probe.codec === 'alac',
  };
}

module.exports = { checkQuality, QUALITY_VERSION, _internals: { spectrum, findCutoff, silences, measure } };
