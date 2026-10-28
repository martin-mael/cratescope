'use strict';
// rekordbox XML export (format spec: https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf).
// Carries BPM, beat grid (incl. bar position), key and genre / style / label. No cue points: the
// drop / break detection isn't reliable enough to land in a DJ's library.
const fs = require('fs');
const { pathToFileURL } = require('url');
const { audioStartTime } = require('../analysis/ffmpeg');

// formats rekordbox can import, mapped to its "Kind" strings
const KIND = { mp3: 'MP3 File', wav: 'WAV File', aif: 'AIFF File', aiff: 'AIFF File', flac: 'FLAC File', m4a: 'M4A File', aac: 'M4A File', mp4: 'M4A File', alac: 'M4A File' };

const xml = (v) => String(v == null ? '' : v)
  // characters XML 1.0 forbids, then entities (the spec asks for all five)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const attrs = (o) => Object.entries(o).map(([k, v]) => `${k}="${xml(v)}"`).join(' ');
const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : (0).toFixed(d)); // locale independent

// MP3 timeline offset between ffmpeg (CrateScope) and rekordbox, in seconds.
// ffmpeg skips the Xing/Info header frame and trims the encoder + decoder delay (gapless playback);
// rekordbox plays the header frame as silence and keeps the delay, so its timeline runs later
// (51.2 ms for a typical LAME file at 44.1 kHz). The delay comes from ffprobe (exactly what ffmpeg trims).
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3HeaderFrame(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    let pos = 0;
    if (head.toString('latin1', 0, 3) === 'ID3') {
      pos = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
      if (head[5] & 0x10) pos += 10; // footer
    }
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    let i = 0;
    while (i + 4 < n && !(buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0)) i++;
    if (i + 4 >= n) return 0;
    const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const rate = (MPEG_RATES[version] || [])[(buf[i + 2] >> 2) & 3];
    if (!rate) return 0;
    const side = version === 3 ? (((buf[i + 3] >> 6) & 3) === 3 ? 17 : 32) : (((buf[i + 3] >> 6) & 3) === 3 ? 9 : 17);
    const tag = buf.toString('latin1', i + 4 + side, i + 8 + side);
    return tag === 'Xing' || tag === 'Info' ? (version === 3 ? 1152 : 576) / rate : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function mp3Offset(file) {
  return mp3HeaderFrame(file) + (await audioStartTime(file));
}

// offsets for every MP3 of the list, a few ffprobe at a time
async function mp3Offsets(tracks) {
  const files = tracks.filter((t) => t.ext === 'mp3').map((t) => t.path);
  const out = new Map();
  for (let k = 0; k < files.length; k += 8) {
    const chunk = files.slice(k, k + 8);
    const vals = await Promise.all(chunk.map(mp3Offset));
    chunk.forEach((f, n) => out.set(f, vals[n]));
  }
  return out;
}

// "file://localhost/Users/…" or "file://localhost/C:/Users/…", percent-encoded
const location = (p) => pathToFileURL(p).href.replace(/^file:\/\/\//, 'file://localhost/');

// tracks: [{ path, ext, size, name, tags, parsed, online, probe, analysis (with manual edits applied) }]
// offsets: Map path -> seconds to add to the grid (see mp3Offsets)
function buildXml(tracks, { playlistName = 'CrateScope', today = new Date(), offsets = new Map() } = {}) {
  const date = today.toISOString().slice(0, 10);
  const entries = [];
  const skipped = [];
  for (const t of tracks) {
    const a = t.analysis;
    const kind = KIND[t.ext];
    if (!kind || !a || !a.bpm) { skipped.push(t); continue; }
    const tg = (t.probe && t.probe.tags) || {};
    const o = t.online || {};
    const genres = [...new Set([...(tg.genre ? tg.genre.split(/[;/,]\s*/) : []), ...(o.genres || [])].filter(Boolean))];
    const beat = 60 / a.bpm;
    // beat number in the bar (1-4) of the first grid beat
    const battito = ((Math.round((a.beatOffset - a.downbeat) / beat) % 4) + 4) % 4 + 1;
    const id = entries.length + 1;
    entries.push({
      id,
      xml: `    <TRACK ${attrs({
        TrackID: id,
        Name: tg.title || t.parsed.title || t.name,
        Artist: tg.artist || t.parsed.artist || '',
        Composer: tg.composer || '',
        Album: tg.album || o.album || '',
        Grouping: tg.grouping || '',
        Genre: genres.join(', '),
        Kind: kind,
        Size: t.size,
        TotalTime: Math.round(a.duration || (t.probe && t.probe.duration) || 0),
        DiscNumber: 0,
        TrackNumber: parseInt(tg.trackNo, 10) || 0,
        Year: parseInt(tg.year || o.year, 10) || 0,
        AverageBpm: num(a.bpm, 2),
        DateAdded: date,
        BitRate: (t.probe && t.probe.bitrate) || 0,
        SampleRate: (t.probe && t.probe.sampleRate) || 44100,
        // Camelot first: sortable in rekordbox's Comments column, styles after
        Comments: [a.camelot, ...(o.styles || [])].filter(Boolean).join(' · '),
        PlayCount: 0,
        Rating: 0,
        Location: location(t.path),
        Remixer: '',
        Tonality: a.key || '',
        Label: tg.label || o.label || '',
        Mix: '',
      })}>
      <TEMPO ${attrs({ Inizio: num(a.beatOffset + (offsets.get(t.path) || 0), 3), Bpm: num(a.bpm, 2), Metro: '4/4', Battito: battito })}/>
    </TRACK>`,
    });
  }
  const out = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="CrateScope" Version="${xml(require('../../package.json').version)}" Company="CrateScope"/>
  <COLLECTION Entries="${entries.length}">
${entries.map((e) => e.xml).join('\n')}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE ${attrs({ Name: playlistName, Type: 1, KeyType: 0, Entries: entries.length })}>
${entries.map((e) => `        <TRACK Key="${e.id}"/>`).join('\n')}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
  return { xml: out, count: entries.length, skipped };
}

module.exports = { buildXml, mp3Offsets, mp3Offset };
