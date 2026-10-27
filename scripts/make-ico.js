'use strict';
// Builds build/icon.ico (PNG-compressed entries) from build/icon.png using macOS `sips`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const src = path.join(__dirname, '..', 'build', 'icon.png');
const out = path.join(__dirname, '..', 'build', 'icon.ico');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-'));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => {
  const f = path.join(tmp, `${s}.png`);
  execFileSync('sips', ['-z', String(s), String(s), src, '--out', f], { stdio: 'ignore' });
  return fs.readFileSync(f);
});
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...pngs]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', out);
