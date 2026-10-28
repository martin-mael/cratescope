'use strict';
// Beat grid refinement, downbeat (bar 1) and section / drop detection.
// Everything runs on frame-rate signals (onset envelope + band energies) at `fps` frames per second.

// Detected onset peaks sit slightly after the audible attack (2-frame log difference +
// filter group delay). Calibrated on synthetic kicks (scripts/grid-test.js).
const LATENCY_S = 0.0016;

// strongest onset peak within ±radius frames of `center`, refined by parabolic interpolation
function peakNear(env, center, radius) {
  const lo = Math.max(1, Math.floor(center - radius));
  const hi = Math.min(env.length - 2, Math.ceil(center + radius));
  let best = -1, bi = -1;
  for (let i = lo; i <= hi; i++) if (env[i] > best) { best = env[i]; bi = i; }
  if (bi < 0 || best <= 0) return null;
  const y0 = env[bi - 1], y1 = env[bi], y2 = env[bi + 1];
  const d = y0 - 2 * y1 + y2;
  const off = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;
  return { pos: bi + off, val: best };
}

function weightedLine(pts) {
  let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
  for (const p of pts) { sw += p.w; sk += p.w * p.k; st += p.w * p.t; skk += p.w * p.k * p.k; skt += p.w * p.k * p.t; }
  const den = sw * skk - sk * sk;
  const b = den !== 0 ? (sw * skt - sk * st) / den : 0;
  return { a: (st - b * sk) / sw, b };
}

const rmsResidual = (pts, a, b) => {
  let s = 0, w = 0;
  for (const p of pts) { const r = p.t - (a + b * p.k); s += p.w * r * r; w += p.w; }
  return Math.sqrt(s / Math.max(w, 1e-9));
};

// Track individual beats around a first estimate (period/phase in frames), then fit
// time = phase + k * period by weighted least squares over the whole track.
function fitGrid(env, period, phase) {
  let a = phase, b = period;
  let pts = [];
  const radii = [0.12, 0.08, 0.05];
  for (const r of radii) {
    const n = Math.floor((env.length - 2 - a) / b);
    const cand = [];
    for (let k = 0; k <= n; k++) {
      const p = peakNear(env, a + k * b, r * b);
      if (p) cand.push({ k, t: p.pos, w: p.val });
    }
    if (cand.length < 8) break;
    // keep reasonably strong onsets: weak ones are mostly noise around breakdowns
    const vals = cand.map((c) => c.w).sort((x, y) => x - y);
    const thr = vals[Math.floor(vals.length * 0.35)];
    pts = cand.filter((c) => c.w >= thr);
    ({ a, b } = weightedLine(pts));
  }
  return { phase: a, period: b, pts };
}

// Prefer a whole (or half) BPM when it explains the beats as well as the free fit.
function snapTempo(fit, fps) {
  const bpm = (fps * 60) / fit.period;
  const free = rmsResidual(fit.pts, fit.phase, fit.period);
  let best = { bpm, phase: fit.phase, period: fit.period, rms: free };
  for (const target of [Math.round(bpm), Math.round(bpm * 2) / 2]) {
    if (Math.abs(target - bpm) > 0.06) continue;
    const P = (fps * 60) / target;
    let sw = 0, s = 0;
    for (const p of fit.pts) { s += p.w * (p.t - p.k * P); sw += p.w; }
    const a = s / sw;
    const rms = rmsResidual(fit.pts, a, P);
    if (rms <= free * 1.1 + 0.25) { best = { bpm: target, phase: a, period: P, rms }; break; }
  }
  return best;
}

// Stability: does a single tempo hold over the whole track?
function stability(pts, phase, period, fps) {
  if (pts.length < 16) return { rmsMs: null, driftMs: null, stable: false };
  const q = [[], [], [], []];
  const kMin = pts[0].k, kSpan = pts[pts.length - 1].k - kMin + 1;
  for (const p of pts) q[Math.min(3, Math.max(0, Math.floor(((p.k - kMin) / kSpan) * 4)))].push(p.t - (phase + period * p.k));
  const means = q.filter((x) => x.length).map((x) => x.reduce((s, v) => s + v, 0) / x.length);
  const driftMs = ((Math.max(...means) - Math.min(...means)) / fps) * 1000;
  const rmsMs = (rmsResidual(pts, phase, period) / fps) * 1000;
  return { rmsMs: Math.round(rmsMs * 10) / 10, driftMs: Math.round(driftMs * 10) / 10, stable: driftMs < 20 && rmsMs < 18 };
}

// ---------- beat-synchronous features ----------
function beatFeatures(bands, phase, period, nBeats, fps) {
  const { low, mid, high, nFrames } = bands;
  const F = [];
  const span = Math.max(3, Math.round(0.09 * fps)); // ~90 ms before / after the beat
  const rise = (arr, s) => {
    let a = 0, b = 0;
    for (let f = Math.max(0, s - span); f < s; f++) a += arr[f];
    for (let f = s; f < Math.min(nFrames, s + span); f++) b += arr[f];
    const d = Math.log(1e-7 + b / span) - Math.log(1e-7 + a / span);
    return d > 0 ? d : 0;
  };
  for (let k = 0; k < nBeats; k++) {
    const s = Math.max(0, Math.round(phase + k * period)), e = Math.min(nFrames, Math.round(phase + (k + 1) * period));
    let l = 0, m = 0, h = 0;
    for (let f = s; f < e; f++) { l += low[f]; m += mid[f]; h += high[f]; }
    const n = Math.max(1, e - s);
    // kick accent: rise of low-band energy right at the beat
    let acc = 0;
    for (let f = Math.max(2, s - 2); f <= Math.min(nFrames - 1, s + 3); f++) {
      const d = Math.log(1e-7 + low[f]) - Math.log(1e-7 + low[f - 2]);
      if (d > acc) acc = d;
    }
    // sustained energy rise at the beat: elements entering (bass, pads, crash, drums back in)
    const pos = rise(low, s) + rise(mid, s) + 0.7 * rise(high, s);
    F.push({ l: Math.log(1e-7 + l / n), m: Math.log(1e-7 + m / n), h: Math.log(1e-7 + h / n), e: (l + m) / n, acc, pos });
  }
  return F;
}

// Section changes (intro → drop, breakdowns, new 8-bar phrases…) land on bar starts.
// Score each of the 4 possible bar phases by how much change happens on its beats.
function detectDownbeat(F) {
  const n = F.length;
  if (n < 24) return { first: 0, confidence: 0 };
  const W = 4;
  const D = new Float64Array(n);
  for (let k = W; k <= n - W; k++) {
    let d = 0;
    for (const key of ['l', 'm', 'h']) {
      let before = 0, after = 0;
      for (let j = 1; j <= W; j++) before += F[k - j][key];
      for (let j = 0; j < W; j++) after += F[k + j][key];
      d += Math.abs(after - before) / W;
    }
    D[k] = d;
  }
  const score = [0, 0, 0, 0], acc = [0, 0, 0, 0], cnt = [0, 0, 0, 0], pos = [0, 0, 0, 0];
  let totD = 0, totP = 0;
  for (let k = 0; k < n; k++) {
    const p = k % 4;
    score[p] += D[k] ** 3; // cube: big structural changes dominate small fluctuations
    totD += D[k] ** 3;
    pos[p] += F[k].pos ** 2;
    totP += F[k].pos ** 2;
    acc[p] += F[k].acc; cnt[p]++;
  }
  const accMean = acc.map((v, i) => v / Math.max(1, cnt[i]));
  const accTot = accMean.reduce((s, v) => s + v, 0) || 1;
  // window novelty is smeared by tails (crash, reverb) after the boundary; the attack-level rise is sharp
  const total = score.map((s, p) => 0.5 * (totD ? s / totD : 0.25) + (totP ? pos[p] / totP : 0.25) + 0.35 * (accMean[p] / accTot));
  const order = [0, 1, 2, 3].sort((x, y) => total[y] - total[x]);
  return {
    first: order[0],
    confidence: Math.round(Math.max(0, (total[order[0]] - total[order[1]]) / total[order[0]]) * 100) / 100,
  };
}

// Bar-level energy changes → drops (big rise of low+mid energy) and breakdowns (big fall).
function detectSections(F, firstDownbeat) {
  const bars = [];
  for (let k = firstDownbeat; k + 4 <= F.length; k += 4) {
    let e = 0, l = 0;
    for (let j = 0; j < 4; j++) { e += F[k + j].e; l += Math.exp(F[k + j].l); }
    bars.push({ beat: k, e: Math.log(1e-9 + e / 4), low: Math.log(1e-9 + l / 4) });
  }
  const nb = bars.length;
  if (nb < 12) return [];
  const sortedE = bars.map((b) => b.e).sort((x, y) => x - y);
  const loud = sortedE[Math.floor(nb * 0.6)];
  const W = 4;
  const nov = new Float64Array(nb);
  for (let j = W; j <= nb - W; j++) {
    let before = 0, after = 0, lb = 0, la = 0;
    for (let i = 1; i <= W; i++) { before += bars[j - i].e; lb += bars[j - i].low; }
    for (let i = 0; i < W; i++) { after += bars[j + i].e; la += bars[j + i].low; }
    nov[j] = 0.5 * (after - before) / W + 0.5 * (la - lb) / W;
  }
  const out = [];
  for (let j = W; j <= nb - W; j++) {
    const v = nov[j];
    if (Math.abs(v) < 0.45) continue;
    if (Math.abs(v) < Math.abs(nov[j - 1]) || Math.abs(v) < Math.abs(nov[j + 1] || 0)) continue; // local extremum
    if (v > 0) {
      // a drop must land in one of the louder parts of the track
      let after = 0;
      for (let i = 0; i < W; i++) after += bars[j + i].e;
      if (after / W < loud) continue;
      out.push({ bar: j, beat: bars[j].beat, type: 'drop', strength: v });
    } else {
      out.push({ bar: j, beat: bars[j].beat, type: 'break', strength: -v });
    }
  }
  // keep events at least 8 bars apart, strongest first
  out.sort((x, y) => y.strength - x.strength);
  const kept = [];
  for (const s of out) if (kept.every((o) => Math.abs(o.bar - s.bar) >= 8)) kept.push(s);
  return kept.slice(0, 8).sort((x, y) => x.bar - y.bar);
}

function analyzeGrid(env, bands, fps, bpmEstimate, phaseEstimate) {
  const fit = fitGrid(env, (fps * 60) / bpmEstimate, phaseEstimate);
  const snapped = snapTempo(fit, fps);
  const { period } = snapped;
  // first beat inside the track (phase can be anywhere after the regression)
  // first beat at or after the (latency-corrected) start of the track
  const latF = LATENCY_S * fps;
  let phase = snapped.phase % period;
  if (phase < 0) phase += period;
  if (phase - latF < 0) phase += period;
  const shift = Math.round((snapped.phase - phase) / period); // beat index offset of the fit
  const nBeats = Math.floor((bands.nFrames - phase) / period);
  const F = beatFeatures(bands, phase, period, nBeats, fps);
  const db = detectDownbeat(F);
  const sections = detectSections(F, db.first);
  const st = stability(fit.pts.map((p) => ({ ...p, k: p.k + shift })), phase, period, fps);
  const toSec = (frames) => Math.max(0, frames / fps - LATENCY_S);
  const beatTime = (k) => toSec(phase + k * period);
  const mainDrop = sections.filter((s) => s.type === 'drop').sort((x, y) => y.strength - x.strength)[0];
  // pivot for manual BPM edits: a bar start at the main drop, else the bar start nearest mid-track
  const anchorBeat = mainDrop ? mainDrop.beat : db.first + 4 * Math.round((nBeats / 2 - db.first) / 4);
  return {
    anchor: Math.round(beatTime(anchorBeat) * 10000) / 10000,
    bpm: Math.round(snapped.bpm * 100) / 100,
    beatOffset: Math.round(beatTime(0) * 10000) / 10000,
    downbeat: Math.round(beatTime(db.first) * 10000) / 10000,
    downbeatConfidence: db.confidence,
    tempoStable: st.stable,
    gridRmsMs: st.rmsMs,
    gridDriftMs: st.driftMs,
    sections: sections.map((s) => ({ t: Math.round(beatTime(s.beat) * 1000) / 1000, bar: s.bar + 1, type: s.type })),
    mainDrop: mainDrop ? Math.round(beatTime(mainDrop.beat) * 1000) / 1000 : null,
  };
}

module.exports = { analyzeGrid, LATENCY_S };
