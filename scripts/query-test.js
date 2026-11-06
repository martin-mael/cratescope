'use strict';
// Search syntax tests (src/shared/query.js). node scripts/query-test.js
const query = require('../src/shared/query');

const mk = (o) => ({
  id: o.id, name: o.name || `${o.id}.${o.ext || 'mp3'}`, ext: o.ext || 'mp3', parsed: { title: o.id, artist: '' },
  probe: { tags: { title: o.title, artist: o.artist, genre: o.genre }, bitrate: o.kbps || 320, duration: o.dur || 300, sampleRate: 44100, codec: o.ext === 'flac' ? 'flac' : 'mp3' },
  online: { styles: o.styles || [], year: o.year },
  analysis: { bpm: o.bpm, camelot: o.cam, key: 'x', lufs: o.lufs, duration: o.dur || 300 },
  meta: o.meta || null, quality: o.quality || null,
});
const T = [
  mk({ id: 'a', title: 'Acid Rain', artist: 'Lóne', genre: 'House', styles: ['Acid House'], bpm: 124, cam: '8A', lufs: -9, year: '1996', meta: { rating: 5, comment: 'grosse intro' } }),
  mk({ id: 'b', title: 'Jungle Fever', artist: 'DJ Hype', genre: 'Jungle', styles: ['Drum n Bass'], bpm: 170, cam: '9A', lufs: -7, year: '1994', ext: 'flac', quality: { v: 1, cutoff: 16850, lossless: true } }),
  mk({ id: 'c', title: 'Trance Dream', artist: 'Someone', genre: 'Trance', bpm: 138, cam: '3B', lufs: -6, year: '2004', kbps: 192, dur: 420, meta: { rating: 2 } }),
];
const ctx = { dups: new Set(['a']), played: new Set(['c']), listed: new Set(['a', 'b']) };
const run = (q) => T.filter((t) => query.matches(t, query.parse(q), ctx)).map((t) => t.id).join('');

const cases = [
  ['', 'abc'], ['acid', 'a'], ['lone', 'a'], ['bpm:120-130', 'a'], ['bpm:>140', 'b'], ['bpm:124', 'a'], ['bpm:124.4', 'a'],
  ['key:8A', 'a'], ['key:~8A', 'ab'], ['key:Am', 'a'], ['genre:jungle', 'b'], ['-genre:trance', 'ab'], ['style:"acid house"', 'a'],
  ['year:1990-1999', 'ab'], ['rating:>=4', 'a'], ['rating:0', 'b'], ['lufs:>-8', 'bc'], ['kbps:<256', 'c'], ['time:>6', 'c'],
  ['fmt:flac', 'b'], ['fmt:lossless', 'b'], ['quality:bad', 'b'], ['quality:warn', 'c'], ['quality:issue', 'bc'], ['dup:yes', 'a'], ['played:no', 'ab'],
  ['pl:no', 'c'], ['comment:intro', 'a'], ['"jungle fever"', 'b'], ['-acid', 'bc'], ['foo:bar', ''], ['bpm:abc', ''],
  ['acid bpm:120-130 key:~9A', 'a'], ['artiste:hype', 'b'],
];
let fail = 0;
for (const [q, want] of cases) {
  const got = run(q);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(q).padEnd(28)} → ${got || '∅'}${ok ? '' : `  (attendu ${want || '∅'})`}`);
}
process.exit(fail ? 1 : 0);
