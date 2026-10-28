'use strict';
// rekordbox XML export (format spec: https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf).
// Carries BPM, beat grid (incl. bar position), key, genre / style / label and drops / breaks as memory cues.
const { pathToFileURL } = require('url');

// formats rekordbox can import, mapped to its "Kind" strings
const KIND = { mp3: 'MP3 File', wav: 'WAV File', aif: 'AIFF File', aiff: 'AIFF File', flac: 'FLAC File', m4a: 'M4A File', aac: 'M4A File', mp4: 'M4A File', alac: 'M4A File' };

const xml = (v) => String(v == null ? '' : v)
  // characters XML 1.0 forbids, then entities (the spec asks for all five)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const attrs = (o) => Object.entries(o).map(([k, v]) => `${k}="${xml(v)}"`).join(' ');
const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : (0).toFixed(d)); // locale independent

// "file://localhost/Users/…" or "file://localhost/C:/Users/…", percent-encoded
const location = (p) => pathToFileURL(p).href.replace(/^file:\/\/\//, 'file://localhost/');

// tracks: [{ path, ext, size, name, tags, parsed, online, probe, analysis (with manual edits applied) }]
function buildXml(tracks, { playlistName = 'CrateScope', today = new Date() } = {}) {
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
    const marks = (a.sections || []).map((s) => `      <POSITION_MARK ${attrs({ Name: s.type === 'drop' ? 'DROP' : 'BREAK', Type: 0, Start: num(s.t, 3), Num: -1 })}/>`);
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
      <TEMPO ${attrs({ Inizio: num(a.beatOffset, 3), Bpm: num(a.bpm, 2), Metro: '4/4', Battito: battito })}/>
${marks.join('\n')}${marks.length ? '\n' : ''}    </TRACK>`,
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

module.exports = { buildXml };
