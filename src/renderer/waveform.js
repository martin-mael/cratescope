'use strict';
// 3-band waveform drawing (low = blue, mid = amber, high = white), Rekordbox style.
(function () {
  const COLORS = { low: '#1f6fff', mid: '#ff9a1f', high: '#f4f6ff' };

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { ctx: canvas.getContext('2d'), w, h, dpr };
  }

  // per-band maxima so each band uses its full range (bass otherwise hides behind mids)
  const maxCache = new WeakMap();
  function bandMax(data) {
    let m = maxCache.get(data);
    if (m) return m;
    m = [1, 1, 1, 1];
    for (let i = 0; i < data.length; i += 4) for (let c = 1; c < 4; c++) if (data[i + c] > m[c]) m[c] = data[i + c];
    maxCache.set(data, m);
    return m;
  }

  // data: Uint8Array [peak, low, mid, high] * n ; draws bins [from, to) across the canvas width
  function drawBands(ctx, data, x0, w, h, from, to, opts = {}) {
    const n = data.length / 4;
    const mid = h / 2;
    const span = to - from;
    const scale = (opts.gain || 0.96) * mid;
    const mx = bandMax(data);
    const layers = [['low', 1], ['mid', 2], ['high', 3]];
    for (const [name, c] of layers) {
      ctx.fillStyle = COLORS[name];
      ctx.globalAlpha = name === 'high' ? 0.9 : 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const a = from + (x / w) * span, b = from + ((x + 1) / w) * span;
        let i0 = Math.floor(a), i1 = Math.max(i0 + 1, Math.floor(b));
        if (i1 <= 0 || i0 >= n) continue;
        i0 = Math.max(0, i0); i1 = Math.min(n, i1);
        let v = 0;
        for (let i = i0; i < i1; i++) if (data[i * 4 + c] > v) v = data[i * 4 + c];
        // layer heights: low gets the full envelope, mid/high are progressively narrower, like Rekordbox 3-band
        const k = name === 'low' ? 1 : name === 'mid' ? 0.62 : 0.38;
        const y = (v / mx[c]) * scale * k;
        if (y < 0.5) continue;
        ctx.rect(x0 + x, mid - y, 1, y * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawMini(canvas, data) {
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    drawBands(ctx, data, 0, w, h, 0, data.length / 4, { gain: 1 });
  }

  const SECTION_COLORS = { drop: '#ff9a1f', break: '#2fb5ff' };

  function drawOverview(canvas, data, progress, opts = {}) {
    const { ctx, w, h, dpr } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    drawBands(ctx, data, 0, w, h, 0, data.length / 4);
    const px = Math.round(progress * w);
    ctx.fillStyle = 'rgba(8,9,11,0.55)';
    ctx.fillRect(0, 0, px, h); // played part dimmed
    // sections: small flags on top
    const a = opts.analysis, dur = opts.duration;
    if (a && a.sections && dur) {
      for (const s of a.sections) {
        const x = Math.round((s.t / dur) * w);
        ctx.fillStyle = SECTION_COLORS[s.type] || '#fff';
        ctx.beginPath(); ctx.moveTo(x - 4 * dpr, 0); ctx.lineTo(x + 4 * dpr, 0); ctx.lineTo(x, 6 * dpr); ctx.fill();
        ctx.globalAlpha = 0.35; ctx.fillRect(x, 0, dpr, h); ctx.globalAlpha = 1;
      }
    }
    if (opts.window) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(opts.window[0] * w) + 0.5, 0.5, Math.max(2, (opts.window[1] - opts.window[0]) * w), h - 1);
    }
    ctx.fillStyle = '#ff3b4d';
    ctx.fillRect(px - 1, 0, 2, h);
  }

  // detail: 50 bins / s. Centered playhead, scrolling. Grid = anchor + k * beat, bars from `downbeat`,
  // phrase lines every 16 bars from the anchor (the main drop when one was found).
  function drawZoom(canvas, data, time, secondsVisible, a) {
    const { ctx, w, h, dpr } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    const rate = 50;
    const t0 = time - secondsVisible / 2, t1 = time + secondsVisible / 2;
    const xOf = (t) => Math.round(((t - t0) / secondsVisible) * w);
    if (a && a.bpm) {
      const beat = 60 / a.bpm;
      const pxPerBeat = (beat / secondsVisible) * w;
      ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
      for (let k = Math.ceil((t0 - a.beatOffset) / beat); ; k++) {
        const bt = a.beatOffset + k * beat;
        if (bt > t1) break;
        if (bt < 0) continue;
        const x = xOf(bt);
        const n = Math.round((bt - a.downbeat) / beat);
        const bar = ((n % 4) + 4) % 4 === 0;
        const phrase = bar && ((Math.round((bt - a.anchor) / beat) % 64) + 64) % 64 === 0;
        if (bar) {
          ctx.fillStyle = phrase ? 'rgba(255,214,0,0.85)' : 'rgba(255,59,77,0.6)';
          ctx.fillRect(x - (phrase ? dpr : 0), 0, (phrase ? 3 : 2) * dpr, h);
          if (pxPerBeat * 4 > 34 * dpr) {
            ctx.fillStyle = phrase ? '#ffd600' : 'rgba(255,120,130,0.9)';
            ctx.fillText(String(n / 4 + 1), x + 3 * dpr, h - 4 * dpr);
          }
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ctx.fillRect(x, 0, dpr, h * 0.12);
          ctx.fillRect(x, h - h * 0.12, dpr, h * 0.12);
        }
      }
    }
    drawBands(ctx, data, 0, w, h, t0 * rate, t1 * rate);
    if (a && a.sections) {
      ctx.font = `bold ${10 * dpr}px -apple-system, sans-serif`;
      for (const s of a.sections) {
        if (s.t < t0 - 1 || s.t > t1) continue;
        const x = xOf(s.t);
        const label = s.type === 'drop' ? 'DROP' : 'BREAK';
        ctx.fillStyle = SECTION_COLORS[s.type];
        const tw = ctx.measureText(label).width + 8 * dpr;
        ctx.fillRect(x, 0, tw, 14 * dpr);
        ctx.fillStyle = '#111';
        ctx.fillText(label, x + 4 * dpr, 11 * dpr);
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(w / 2) - dpr, 0, 2 * dpr, h);
  }

  window.waveform = { drawMini, drawOverview, drawZoom };
})();
