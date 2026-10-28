'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SR } = require('./dsp');

// Order: explicit env (set by main for the binaries bundled in the Windows build), Homebrew, PATH.
function findBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    process.env[`CRATESCOPE_${name.toUpperCase()}`],
    path.join(__dirname, '..', '..', 'vendor', `${process.platform}-${process.arch}`, 'ffmpeg', exe),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const p = execFileSync(cmd, [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (p) return p;
  } catch {}
  return name;
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

function run(bin, args, { maxBuffer = 64 * 1024 * 1024, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let outLen = 0;
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen > maxBuffer) { p.kill('SIGKILL'); return; }
      out.push(d);
    });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(-100000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

const TAG_MAP = {
  title: 'title', artist: 'artist', album: 'album', album_artist: 'albumArtist',
  genre: 'genre', date: 'year', year: 'year', tdrc: 'year', publisher: 'label', label: 'label',
  organization: 'label', tbpm: 'tagBpm', bpm: 'tagBpm', tkey: 'tagKey', initialkey: 'tagKey',
  key: 'tagKey', comment: 'comment', track: 'trackNo', grouping: 'grouping', composer: 'composer',
  isrc: 'isrc', tsrc: 'isrc',
};

function cleanTags(raw) {
  const tags = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (typeof v !== 'string' || v.length > 300) continue; // skip binary blobs (Traktor PRIV etc.)
    const key = TAG_MAP[k.toLowerCase()];
    if (key && !tags[key]) tags[key] = v.trim();
  }
  if (tags.year) tags.year = (tags.year.match(/\d{4}/) || [''])[0];
  return tags;
}

async function probe(file) {
  const { code, stdout } = await run(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { timeout: 30000 });
  if (code !== 0) throw new Error('ffprobe failed');
  const j = JSON.parse(stdout.toString('utf8'));
  const audio = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!audio) throw new Error('no audio stream');
  const hasCover = (j.streams || []).some((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
  const tags = { ...cleanTags(audio.tags), ...cleanTags(j.format && j.format.tags) };
  return {
    duration: parseFloat(j.format.duration) || parseFloat(audio.duration) || 0,
    bitrate: Math.round((parseInt(j.format.bit_rate, 10) || parseInt(audio.bit_rate, 10) || 0) / 1000),
    sampleRate: parseInt(audio.sample_rate, 10) || 0,
    channels: audio.channels || 0,
    codec: audio.codec_name,
    bitDepth: audio.bits_per_raw_sample ? parseInt(audio.bits_per_raw_sample, 10) : (audio.bits_per_sample || null),
    hasCover,
    tags,
  };
}

// Decode to mono float32 @ SR and measure EBU R128 loudness in the same pass.
async function decode(file) {
  const { code, stdout, stderr } = await run(FFMPEG, [
    '-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-i', file,
    '-filter_complex',
    `[0:a:0]asplit=2[a][b];[a]aresample=${SR},aformat=sample_fmts=flt:channel_layouts=mono[o];[b]ebur128=framelog=quiet,anullsink`,
    '-map', '[o]', '-f', 'f32le', 'pipe:1',
  ], { maxBuffer: SR * 4 * 60 * 90, timeout: 300000 }); // up to 90 min
  if (code !== 0 && stdout.length === 0) throw new Error('ffmpeg decode failed: ' + stderr.split('\n').slice(-3).join(' '));
  // copy into an aligned buffer
  const ab = new ArrayBuffer(stdout.length - (stdout.length % 4));
  new Uint8Array(ab).set(stdout.subarray(0, ab.byteLength));
  const pcm = new Float32Array(ab);
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = sum.match(/I:\s+(-?[\d.]+) LUFS/);
  const LRA = sum.match(/LRA:\s+([\d.]+) LU/);
  return {
    pcm,
    lufs: I ? parseFloat(I[1]) : null,
    lra: LRA ? parseFloat(LRA[1]) : null,
  };
}

async function extractCover(file, outFile) {
  const { code, stdout } = await run(FFMPEG, [
    '-nostdin', '-v', 'error', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=400:400:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ], { timeout: 20000 });
  if (code !== 0 || stdout.length === 0) return null;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, stdout);
  return outFile;
}

// For formats Chromium can't play (AIFF, ALAC, WMA…): transcode to FLAC once.
async function transcodeForPlayback(file, outFile) {
  if (fs.existsSync(outFile)) return outFile;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.part';
  const { code } = await run(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-c:a', 'flac', '-compression_level', '0', '-f', 'flac', tmp], { timeout: 300000 });
  if (code !== 0) throw new Error('transcode failed');
  fs.renameSync(tmp, outFile);
  return outFile;
}

// seconds ffmpeg skips at the start of the audio stream (MP3 encoder + decoder delay, AAC priming…)
async function audioStartTime(file) {
  const { code, stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file], { timeout: 15000 });
  const v = parseFloat(stdout.toString());
  return code === 0 && Number.isFinite(v) && v > 0 ? v : 0;
}

module.exports = { probe, decode, audioStartTime, extractCover, transcodeForPlayback, FFMPEG, FFPROBE };
