'use strict';
// In-app updates from GitHub releases. The app is only ad-hoc signed, so Electron's autoUpdater
// (Squirrel) can't be used: we download the release zip, check its SHA-256 against the digest GitHub
// publishes, unpack it next to the user data, and a small detached script swaps the old app for the
// new one once this process has exited (then relaunches it).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const REPO = 'martin-mael/cratescope';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const CHECK_EVERY = 6 * 3600 * 1000;

// "v0.4.2-build.13" -> { version: [0, 4, 2], build: 13 }
function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-build\.(\d+))?$/.exec(tag || '');
  return m ? { version: [+m[1], +m[2], +m[3]], build: m[4] ? +m[4] : 0 } : null;
}

// release newer than the running app? Same version: the CI build number decides (0 = local build, never older)
function isNewer(latest, current) {
  for (let i = 0; i < 3; i++) if (latest.version[i] !== current.version[i]) return latest.version[i] > current.version[i];
  return current.build > 0 && latest.build > current.build;
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
});

class Updater extends EventEmitter {
  // opts: { app, fetch, dataDir, getSettings, current?: "0.4.2", build?: 13, target?: install path }
  // (current / build / target are only overridden by dev tests)
  constructor(opts) {
    super();
    this.app = opts.app;
    this.fetch = opts.fetch;
    this.getSettings = opts.getSettings;
    this.dir = path.join(opts.dataDir, 'updates');
    this.packaged = this.app.isPackaged || !!opts.target;
    this.current = { version: (opts.current || this.app.getVersion()).split('.').map(Number), build: opts.build != null ? opts.build : readBuild() };
    this.target = opts.target || installPath();
    this.state = { status: 'idle', current: this.label(this.current), latest: null, progress: 0, error: null, url: null };
    this.release = null; // { tag, asset }
    this.staged = null;  // unpacked new app, ready to swap in
    this.timer = null;
  }

  label(v) { return v.version.join('.') + (v.build ? ` (build ${v.build})` : ''); }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  // background checks: soon after launch, then every few hours
  start() {
    if (!this.packaged) return;
    this.cleanup();
    const tick = () => { if (this.getSettings().autoUpdate !== false) this.check().catch(() => {}); };
    setTimeout(tick, 8000);
    this.timer = setInterval(tick, CHECK_EVERY);
  }

  assetName() {
    const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null;
    return os ? new RegExp(`-${os}-${process.arch}\\.zip$`) : null;
  }

  async check({ manual = false } = {}) {
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    if (this.state.status === 'ready') return this.state;
    this.set({ status: 'checking', error: null });
    try {
      const res = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CrateScope-updater' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
      const rel = await res.json();
      const latest = parseTag(rel.tag_name);
      if (!latest) throw new Error(`version inconnue : ${rel.tag_name}`);
      const re = this.assetName();
      const asset = re && (rel.assets || []).find((a) => re.test(a.name));
      const info = { latest: this.label(latest), url: rel.html_url };
      if (!isNewer(latest, this.current)) { this.set({ status: 'uptodate', ...info }); return this.state; }
      if (!asset) throw new Error(`pas de fichier pour ${process.platform}-${process.arch} dans ${rel.tag_name}`);
      this.release = { tag: rel.tag_name, asset };
      this.set({ status: 'available', ...info });
      if (!this.packaged) return this.state; // dev run: nothing to replace
      if (this.getSettings().autoUpdate !== false || manual) await this.download();
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.state;
  }

  async download() {
    if (!this.release || !this.packaged || this.state.status === 'downloading') return this.state;
    const { tag, asset } = this.release;
    try {
      if (!asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) throw new Error('adresse de téléchargement inattendue');
      const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '');
      if (!digest) throw new Error("GitHub n'a pas publié d'empreinte SHA-256 pour ce fichier");
      this.set({ status: 'downloading', progress: 0, error: null });
      await fsp.rm(this.dir, { recursive: true, force: true });
      await fsp.mkdir(this.dir, { recursive: true });
      const zip = path.join(this.dir, asset.name);
      // network hiccups (Wi-Fi change, sleep…) get a few retries; a bad checksum doesn't
      for (let attempt = 1; ; attempt++) {
        try {
          await this.fetchTo(asset, zip, digest[1]);
          break;
        } catch (e) {
          await fsp.rm(zip, { force: true });
          if (e.corrupt || attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
      }

      this.checkWritable();
      const unpack = this.unpackDir();
      await fsp.rm(unpack, { recursive: true, force: true });
      await fsp.mkdir(unpack);
      if (process.platform === 'darwin') await run('ditto', ['-x', '-k', zip, unpack]);
      else await run('tar', ['-xf', zip, '-C', unpack]);
      await fsp.rm(zip, { force: true });
      const staged = process.platform === 'darwin' ? path.join(unpack, 'CrateScope.app') : path.join(unpack, `CrateScope-win32-${process.arch}`);
      const exe = process.platform === 'darwin' ? path.join(staged, 'Contents', 'MacOS', 'CrateScope') : path.join(staged, 'CrateScope.exe');
      if (!fs.existsSync(exe)) throw new Error("l'archive ne contient pas l'application attendue");
      this.staged = staged;
      this.set({ status: 'ready', progress: 1, tag });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.state;
  }

  async fetchTo(asset, file, sha256) {
    const res = await this.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'CrateScope-updater' } });
    if (!res.ok) throw new Error(`téléchargement : HTTP ${res.status}`);
    const total = +res.headers.get('content-length') || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0, lastEmit = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        if (total && Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.set({ progress: got / total }); }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (hash.digest('hex') !== sha256) throw Object.assign(new Error('fichier corrompu (empreinte SHA-256 différente)'), { corrupt: true });
  }

  // Windows can't move a folder across drives: unpack next to the app instead of in the user data
  unpackDir() {
    return process.platform === 'win32' ? path.join(path.dirname(this.target), '.CrateScope-update') : path.join(this.dir, 'new');
  }

  // leftovers of an interrupted update
  cleanup() {
    if (!this.packaged) return;
    for (const d of [this.unpackDir(), this.target + '.update-old']) fs.rm(d, { recursive: true, force: true }, () => {});
  }

  // the folder holding the app must be writable to swap it (not the case for a translocated or admin-only install)
  checkWritable() {
    try {
      fs.accessSync(path.dirname(this.target), fs.constants.W_OK);
      fs.accessSync(this.target, fs.constants.W_OK);
    } catch {
      throw new Error(`impossible d'écrire dans ${path.dirname(this.target)} : installe la mise à jour à la main`);
    }
  }

  // swaps the app once we have exited; relaunch = start the new version afterwards
  install({ relaunch = true } = {}) {
    if (!this.staged || this.state.status === 'installing') return false;
    this.set({ status: 'installing' });
    const args = [String(process.pid), this.target, this.staged, relaunch ? '1' : '0'];
    const log = path.join(this.dir, 'install.log');
    if (process.platform === 'darwin') {
      const script = path.join(this.dir, 'install.sh');
      fs.writeFileSync(script, MAC_SCRIPT);
      spawn('/bin/sh', [script, ...args, log], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const script = path.join(this.dir, 'install.ps1');
      fs.writeFileSync(script, WIN_SCRIPT);
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args, log],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    this.staged = null;
    return true;
  }

  stop() { clearInterval(this.timer); }
}

// running app: CrateScope.app bundle on macOS, the unzipped folder on Windows
function installPath() {
  if (process.platform === 'darwin') return path.resolve(process.execPath, '..', '..', '..');
  return path.dirname(process.execPath);
}

function readBuild() {
  try { return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'build.json'), 'utf8')).build || 0; } catch { return 0; }
}

// args: pid target staged relaunch log. Keeps the old app aside until the new one is in place.
const MAC_SCRIPT = `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"; LOG="$5"
exec >"$LOG" 2>&1
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
BAK="$OLD.update-old"
rm -rf "$BAK"
if mv "$OLD" "$BAK" && mv "$NEW" "$OLD"; then
  rm -rf "$BAK"
  echo "updated"
else
  echo "swap failed, restoring"
  [ -d "$OLD" ] || mv "$BAK" "$OLD"
fi
if [ "$RELAUNCH" = "1" ]; then open "$OLD"; fi
`;

const WIN_SCRIPT = `param($WaitPid, $Old, $New, $Relaunch, $Log)
Start-Transcript -Path $Log -Force | Out-Null
try { Wait-Process -Id $WaitPid -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 800
$Bak = "$Old.update-old"
if (Test-Path -LiteralPath $Bak) { Remove-Item -LiteralPath $Bak -Recurse -Force }
$moved = $false
for ($i = 0; $i -lt 20 -and -not $moved; $i++) {
  try { Move-Item -LiteralPath $Old -Destination $Bak -ErrorAction Stop; $moved = $true } catch { Start-Sleep -Milliseconds 500 }
}
if ($moved) {
  try {
    Move-Item -LiteralPath $New -Destination $Old -ErrorAction Stop
    Remove-Item -LiteralPath $Bak -Recurse -Force -ErrorAction SilentlyContinue
    "updated"
  } catch {
    "swap failed, restoring"
    if (-not (Test-Path -LiteralPath $Old)) { Move-Item -LiteralPath $Bak -Destination $Old }
  }
} else { "old version still in use, update skipped" }
if ($Relaunch -eq "1") { Start-Process -FilePath (Join-Path $Old "CrateScope.exe") }
Stop-Transcript | Out-Null
`;

module.exports = { Updater, parseTag, isNewer, MAC_SCRIPT, WIN_SCRIPT };
