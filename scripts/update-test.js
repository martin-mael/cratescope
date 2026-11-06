'use strict';
// Runs the updater's swap script on a dummy app: waits for a process to exit, replaces the old
// folder by the new one, keeps nothing behind. node scripts/update-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { MAC_SCRIPT, WIN_SCRIPT } = require('../src/main/updater');

const win = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cratescope-update-'));
const old = path.join(tmp, 'Apps', win ? 'CrateScope-win32-x64' : 'CrateScope.app');
const staged = path.join(tmp, 'staged', path.basename(old));
for (const [dir, v] of [[old, 'old'], [staged, 'new']]) {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'version.txt'), v);
  fs.writeFileSync(path.join(dir, 'sub', `${v}-only.txt`), v);
}

// stands in for the running app: the swap must wait until it has exited
const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
const t0 = Date.now();
const log = path.join(tmp, 'install.log');
const script = path.join(tmp, win ? 'install.ps1' : 'install.sh');
fs.writeFileSync(script, win ? WIN_SCRIPT : MAC_SCRIPT);
const args = [String(app.pid), old, staged, '0', log];
// async on purpose: the event loop must reap the dummy app, or it stays a zombie that `kill -0` still sees
const child = win
  ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args])
  : spawn('/bin/sh', [script, ...args]);
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const timeout = setTimeout(() => { console.log('FAIL timeout'); child.kill(); }, 30000);
child.on('exit', (status) => { clearTimeout(timeout); report(status, Date.now() - t0, stderr); });

function report(status, waited, stderr) {
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
const checks = {
  'script exit 0': status === 0,
  'waited for the app to exit': waited >= 1200,
  'new version in place': read(path.join(old, 'version.txt')) === 'new',
  'new files present': fs.existsSync(path.join(old, 'sub', 'new-only.txt')),
  'old files gone': !fs.existsSync(path.join(old, 'sub', 'old-only.txt')),
  'no backup left': !fs.existsSync(old + '.update-old'),
  'staged folder consumed': !fs.existsSync(staged),
  'log says updated': /updated/.test(read(log) || ''),
};
let ok = true;
for (const [name, pass] of Object.entries(checks)) { console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`); ok = ok && pass; }
if (!ok) console.log('--- log\n' + read(log) + '\n--- stderr\n' + stderr);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
}
