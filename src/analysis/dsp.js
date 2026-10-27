'use strict';
// Pure-JS DSP: waveform (3 bands), tempo (BPM + beat grid), musical key.
// Input: mono Float32Array at SR Hz (decoded by ffmpeg).

const SR = 11025;
const HOP = 64; // ~5.8 ms → 172 frames/s for onset detection
const FPS = SR / HOP;

// ---------- FFT (iterative radix-2, in place) ----------
const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// ---------- Biquad filters (RBJ cookbook) ----------
function biquad(type, f0, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
  else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function step(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

// ---------- Pass 1: band energies per hop ----------
function bandFrames(pcm) {
  const nFrames = Math.floor(pcm.length / HOP);
  const low = new Float32Array(nFrames);
  const mid = new Float32Array(nFrames);
  const high = new Float32Array(nFrames);
  const peak = new Float32Array(nFrames);
  // 4th-order (two cascaded biquads) for cleaner band split
  const lp1 = biquad('lp', 180), lp2 = biquad('lp', 180);
  const hp1 = biquad('hp', 2200), hp2 = biquad('hp', 2200);
  let i = 0;
  for (let f = 0; f < nFrames; f++) {
    let el = 0, em = 0, eh = 0, pk = 0;
    for (let k = 0; k < HOP; k++, i++) {
      const x = pcm[i];
      const l = step(lp2, step(lp1, x));
      const h = step(hp2, step(hp1, x));
      const m = x - l - h;
      el += l * l; em += m * m; eh += h * h;
      const a = x < 0 ? -x : x;
      if (a > pk) pk = a;
    }
    low[f] = el / HOP; mid[f] = em / HOP; high[f] = eh / HOP; peak[f] = pk;
  }
  return { low, mid, high, peak, nFrames };
}

// ---------- Waveform ----------
// Returns Uint8Array of [peak, low, mid, high] * bins
function waveform(bands, bins) {
  const { low, mid, high, peak, nFrames } = bands;
  const out = new Float32Array(bins * 4);
  const per = nFrames / bins;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * per), e = Math.max(s + 1, Math.floor((b + 1) * per));
    let pk = 0, l = 0, m = 0, h = 0, n = 0;
    for (let f = s; f < e && f < nFrames; f++, n++) {
      if (peak[f] > pk) pk = peak[f];
      l += low[f]; m += mid[f]; h += high[f];
    }
    n = n || 1;
    out[b * 4] = pk;
    out[b * 4 + 1] = Math.sqrt(l / n);
    out[b * 4 + 2] = Math.sqrt(m / n);
    out[b * 4 + 3] = Math.sqrt(h / n);
  }
  // normalise each channel to the track's max so quiet masters still read well
  const res = new Uint8Array(bins * 4);
  for (let c = 0; c < 4; c++) {
    let mx = 1e-9;
    for (let b = 0; b < bins; b++) if (out[b * 4 + c] > mx) mx = out[b * 4 + c];
    // shared scale for the 3 RMS bands keeps their relative balance
    if (c > 0) {
      mx = 1e-9;
      for (let b = 0; b < bins; b++) for (let k = 1; k < 4; k++) if (out[b * 4 + k] > mx) mx = out[b * 4 + k];
    }
    for (let b = 0; b < bins; b++) res[b * 4 + c] = Math.min(255, Math.round(255 * Math.pow(out[b * 4 + c] / mx, c === 0 ? 1 : 0.75)));
  }
  return res;
}

// ---------- Onset envelope ----------
function onsetEnvelope(bands) {
  const { low, mid, high, nFrames } = bands;
  const env = new Float32Array(nFrames);
  const L = new Float32Array(nFrames), M = new Float32Array(nFrames), H = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    L[f] = Math.log(1e-7 + low[f]);
    M[f] = Math.log(1e-7 + mid[f]);
    H[f] = Math.log(1e-7 + high[f]);
  }
  for (let f = 2; f < nFrames; f++) {
    const dl = L[f] - L[f - 2], dm = M[f] - M[f - 2], dh = H[f] - H[f - 2];
    env[f] = (dl > 0 ? dl : 0) * 1.2 + (dm > 0 ? dm : 0) + (dh > 0 ? dh : 0) * 0.8;
  }
  // remove local mean (~0.4 s), half-wave rectify
  const w = Math.round(FPS * 0.2);
  const out = new Float32Array(nFrames);
  let acc = 0;
  const pre = new Float64Array(nFrames + 1);
  for (let f = 0; f < nFrames; f++) { acc += env[f]; pre[f + 1] = acc; }
  for (let f = 0; f < nFrames; f++) {
    const a = Math.max(0, f - w), b = Math.min(nFrames, f + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    const v = env[f] - mean;
    out[f] = v > 0 ? v : 0;
  }
  return out;
}

function autocorr(env, maxLag) {
  let n = 1;
  while (n < env.length * 2) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= env.length;
  for (let i = 0; i < env.length; i++) re[i] = env[i] - mean;
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im); // real spectrum is symmetric, forward FFT == inverse up to scale
  const ac = new Float64Array(maxLag + 1);
  const z = re[0] || 1;
  for (let l = 0; l <= maxLag; l++) ac[l] = re[l] / z;
  return ac;
}

function interp(arr, x) {
  const i = Math.floor(x), f = x - i;
  if (i + 1 >= arr.length) return arr[arr.length - 1] || 0;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

// comb score for a period, maximised over beat phase; returns {score, phase}
function combScore(env, period) {
  let best = -1, bestPhase = 0;
  const nBeats = Math.floor((env.length - period) / period);
  for (let ph = 0; ph < period; ph += 1) {
    let s = 0;
    for (let k = 0; k < nBeats; k++) s += interp(env, ph + k * period);
    if (s > best) { best = s; bestPhase = ph; }
  }
  return { score: best / Math.max(1, nBeats), phase: bestPhase };
}

function tempo(env, minBpm = 88, maxBpm = 180) {
  const lagFor = (bpm) => (FPS * 60) / bpm;
  const maxLag = Math.ceil(lagFor(minBpm) * 4) + 2;
  const ac = autocorr(env, maxLag);
  const scoreBpm = (bpm) => {
    const L = lagFor(bpm);
    let s = 0;
    const w = [1, 0.6, 0.4, 0.35];
    for (let k = 1; k <= 4; k++) s += w[k - 1] * interp(ac, L * k);
    return s;
  };
  // 1) coarse scan of the autocorrelation in the allowed range
  let best = minBpm, bestS = -Infinity;
  for (let b = minBpm; b <= maxBpm; b += 0.1) {
    const s = scoreBpm(b);
    if (s > bestS) { bestS = s; best = b; }
  }
  // 2) metrical-level check: the ACF easily locks onto 2/3, 3/4 or 1/2 of the real tempo.
  //    Compare phase-aligned comb scores of related tempi; faster wins unless clearly worse.
  const localBest = (center, span, stepB) => {
    let bb = center, bs = -Infinity;
    for (let b = center - span; b <= center + span; b += stepB) {
      const r = combScore(env, lagFor(b));
      if (r.score > bs) { bs = r.score; bb = b; }
    }
    return { bpm: bb, score: bs };
  };
  const cands = [];
  for (const r of [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75]) {
    const b = best * r;
    if (b >= minBpm - 0.5 && b <= maxBpm + 0.5) cands.push(localBest(b, 0.6, 0.1));
  }
  cands.sort((a, b) => b.bpm - a.bpm); // fastest first
  let pick = cands[0];
  for (const c of cands) if (c.score > pick.score * 1.12) pick = c;
  // 3) fine search with full-length comb
  const fineR = localBest(pick.bpm, 0.15, 0.01);
  let fine = fineR.bpm;
  // snap near-integers (most produced music sits on whole BPMs)
  const rounded = Math.round(fine);
  if (Math.abs(fine - rounded) < 0.1) fine = rounded;
  fine = Math.round(fine * 10) / 10;
  const fin = combScore(env, lagFor(fine));
  // confidence: peak prominence vs. median of the scan
  const scan = [];
  for (let b = minBpm; b <= maxBpm; b += 1) scan.push(scoreBpm(b));
  scan.sort((a, b) => a - b);
  const med = scan[scan.length >> 1];
  const conf = Math.max(0, Math.min(1, (bestS - med) / (Math.abs(bestS) + 1e-9)));
  return { bpm: fine, beatOffset: fin.phase / FPS, confidence: Math.round(conf * 100) / 100 };
}

// ---------- Key detection ----------
// Profiles from libKeyFinder (Ibrahim Sha'ath), tuned for electronic music.
const MAJOR = [7.239, 3.5035, 3.5845, 2.8451, 5.819, 4.5587, 2.4478, 6.9947, 3.3911, 4.5561, 4.0739, 4.4593];
const MINOR = [7.0061, 3.1405, 4.3559, 5.4016, 3.6733, 4.0887, 3.4209, 6.1986, 4.4722, 3.208, 3.7757, 3.3162];
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function chromagram(pcm) {
  const N = 8192, HOPK = 8192;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const loM = 33, hiM = 96; // A1..C7
  const nS = hiM - loM + 1;
  // bin -> (semitone index, weight) map
  const binMap = [];
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    const m = 69 + 12 * Math.log2(f / 440);
    const r = Math.round(m);
    if (r < loM || r > hiM) continue;
    const w = Math.max(0, 1 - 2 * Math.abs(m - r));
    if (w > 0) binMap.push([k, r - loM, w]);
  }
  const chroma = new Float64Array(12);
  const re = new Float64Array(N), im = new Float64Array(N);
  const semi = new Float64Array(nS);
  for (let s = 0; s + N <= pcm.length; s += HOPK) {
    for (let i = 0; i < N; i++) { re[i] = pcm[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    semi.fill(0);
    for (const [k, idx, w] of binMap) semi[idx] += w * Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    for (let i = 0; i < nS; i++) semi[i] = Math.log(1 + 100 * semi[i]);
    // whitening: subtract local mean (+/- half an octave), keeps tonal peaks, drops drums/noise
    for (let i = 0; i < nS; i++) {
      let mean = 0, n = 0;
      for (let j = Math.max(0, i - 6); j <= Math.min(nS - 1, i + 6); j++) { mean += semi[j]; n++; }
      const v = semi[i] - mean / n;
      if (v > 0) chroma[(i + loM) % 12] += v * (i + loM < 57 ? 2 : 1); // bass carries the root
    }
  }
  return chroma;
}

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db + 1e-12);
}

function camelot(tonic, minor) {
  const rel = minor ? (tonic + 3) % 12 : tonic; // relative major
  const n = (((7 * rel) % 12) + 7) % 12 + 1;
  return `${n}${minor ? 'A' : 'B'}`;
}

function detectKey(pcm) {
  const chroma = chromagram(pcm);
  const results = [];
  for (let t = 0; t < 12; t++) {
    const rotMaj = new Array(12), rotMin = new Array(12);
    for (let i = 0; i < 12; i++) {
      rotMaj[(i + t) % 12] = MAJOR[i];
      rotMin[(i + t) % 12] = MINOR[i];
    }
    results.push({ tonic: t, minor: false, r: pearson(chroma, rotMaj) });
    results.push({ tonic: t, minor: true, r: pearson(chroma, rotMin) });
  }
  results.sort((a, b) => b.r - a.r);
  const best = results[0];
  return {
    key: `${NOTES[best.tonic]}${best.minor ? 'm' : ''}`,
    camelot: camelot(best.tonic, best.minor),
    keyConfidence: Math.round(Math.max(0, best.r - results[1].r) * 1000) / 1000,
  };
}

// ---------- Energy (1-10 heuristic) ----------
function energyScore(bands, env, lufs) {
  const { high, low, mid, nFrames } = bands;
  let h = 0, t = 0;
  for (let f = 0; f < nFrames; f++) { h += high[f]; t += low[f] + mid[f] + high[f]; }
  const brightness = t > 0 ? h / t : 0; // 0..1
  let on = 0;
  for (let f = 0; f < env.length; f++) on += env[f];
  const density = on / Math.max(1, env.length); // onset strength per frame
  const loud = lufs == null ? 0.5 : Math.min(1, Math.max(0, (lufs + 20) / 14)); // -20..-6 LUFS
  const s = 0.5 * loud + 0.3 * Math.min(1, density / 0.6) + 0.2 * Math.min(1, brightness * 6);
  return Math.max(1, Math.min(10, Math.round(1 + s * 9)));
}

function analyze(pcm, { minBpm = 88, maxBpm = 180, lufs } = {}) {
  const bands = bandFrames(pcm);
  const env = onsetEnvelope(bands);
  const t = tempo(env, minBpm, maxBpm);
  const k = detectKey(pcm);
  const duration = pcm.length / SR;
  const overview = waveform(bands, 1200);
  const mini = waveform(bands, 120);
  const detailBins = Math.max(1, Math.round(duration * 50)); // 50 bins / s
  const detail = waveform(bands, detailBins);
  return {
    ...t,
    ...k,
    energy: energyScore(bands, env, lufs),
    duration,
    waves: { mini, overview, detail },
  };
}

module.exports = { analyze, SR, camelot, NOTES };
module.exports._internals = { chromagram, pearson, bandFrames, onsetEnvelope, tempo };
