'use strict';
// Analysis worker thread: one job at a time (ffprobe / ffmpeg decode + DSP).
const { parentPort } = require('worker_threads');
const { probe, decode } = require('../analysis/ffmpeg');
const { analyze } = require('../analysis/dsp');

parentPort.on('message', async (job) => {
  const t0 = Date.now();
  try {
    if (job.kind === 'probe') {
      const info = await probe(job.path);
      parentPort.postMessage({ id: job.id, kind: job.kind, ok: true, probe: info });
      return;
    }
    const info = job.needProbe ? await probe(job.path) : null;
    const { pcm, lufs, lra } = await decode(job.path);
    if (pcm.length < 11025) throw new Error('audio too short or undecodable');
    const tDec = Date.now();
    const { waves, ...res } = analyze(pcm, { minBpm: job.minBpm, maxBpm: job.maxBpm, lufs });
    const analysis = { ...res, lufs, lra, analyzedAt: Date.now(), decodeMs: tDec - t0, dspMs: Date.now() - tDec };
    parentPort.postMessage(
      { id: job.id, kind: job.kind, ok: true, probe: info, analysis, waves },
      [waves.overview.buffer, waves.detail.buffer, waves.mini.buffer],
    );
  } catch (e) {
    parentPort.postMessage({ id: job.id, kind: job.kind, ok: false, error: String(e && e.message || e) });
  }
});
