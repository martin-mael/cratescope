'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { Library } = require('./library');
const { buildXml } = require('./rekordbox');
const { extractCover, transcodeForPlayback } = require('../analysis/ffmpeg');

const isMac = process.platform === 'darwin';

// Packaged builds ship ffmpeg/ffprobe in resources/ffmpeg; workers inherit these env vars.
if (app.isPackaged) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg', tool + exe);
    const key = `CRATESCOPE_${tool.toUpperCase()}`;
    if (!process.env[key] && fs.existsSync(bundled)) process.env[key] = bundled;
  }
}

const DEFAULTS = {
  minBpm: 88,
  maxBpm: 180,
  concurrency: Math.max(2, Math.min(8, os.cpus().length - 2)),
  autoOnline: true,
  useMusicBrainz: true,
  useDiscogs: true,
  discogsToken: '',
  discogsKey: '',
  discogsSecret: '',
  lastRoot: null,
};

let win;
let library;
let settings;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; }
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0e0f12',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { color: '#15171c', symbolColor: '#e7e9ee', height: 48 } }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // external links open in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.CRATESCOPE_SMOKE && !app.isPackaged) require('./smoke')(win, process.env.CRATESCOPE_SMOKE);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  loadSettings();
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  library = new Library(app.getPath('userData'), () => settings);
  library.on('update', (u) => send('library:update', u));
  library.on('removed', (id) => send('library:removed', id));
  library.on('rescanned', () => send('library:snapshot', library.snapshot()));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (library) library.close(); });

// ---------- IPC ----------
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  const rangeChanged = (patch.minBpm != null && patch.minBpm !== settings.minBpm) || (patch.maxBpm != null && patch.maxBpm !== settings.maxBpm);
  const dgKey = (s) => [s.useDiscogs, s.discogsToken, s.discogsKey, s.discogsSecret].join('|');
  const discogsChanged = dgKey({ ...settings, ...patch }) !== dgKey(settings);
  settings = { ...settings, ...patch };
  saveSettings();
  if (discogsChanged && settings.useDiscogs !== false) library.refetchMissingDiscogs();
  if (rangeChanged) for (const t of library.tracks.values()) {
    if (t.analysis) { t.staleRange = t.analysis.minBpm !== settings.minBpm || t.analysis.maxBpm !== settings.maxBpm; library.dirty.add(t.id); }
  }
  return settings;
});

ipcMain.handle('library:choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.lastRoot = r.filePaths[0];
  saveSettings();
  return library.open(r.filePaths[0]);
});

// `npm start -- /path/to/music` opens that folder, otherwise the last one
ipcMain.handle('library:openLast', async () => {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isDirectory());
  const root = arg ? path.resolve(arg) : settings.lastRoot;
  if (!root || !fs.existsSync(root)) return null;
  if (arg) { settings.lastRoot = root; saveSettings(); }
  return library.open(root);
});

ipcMain.on('library:focus', (_e, { dir, recursive }) => library.focus(dir, recursive));
ipcMain.on('library:reanalyze', (_e, ids) => library.reanalyze(ids));
ipcMain.on('library:reanalyzeStale', () => library.reanalyzeStale());
ipcMain.on('library:refetch', (_e, ids) => library.refetchOnline(ids));
ipcMain.on('library:bpm', (_e, { ids, factor }) => library.setBpm(ids, factor));
ipcMain.on('library:grid', (_e, { id, patch }) => library.setGrid(id, patch));

ipcMain.handle('track:waves', (_e, id) => library.readWaves(id));

ipcMain.handle('track:cover', async (_e, id) => {
  const t = library.get(id);
  if (!t) return null;
  const out = path.join(library.coversDir, id + '.jpg');
  if (fs.existsSync(out)) return pathToFileURL(out).href;
  if (t.probe && t.probe.hasCover) {
    const f = await extractCover(t.path, out).catch(() => null);
    if (f) return pathToFileURL(f).href;
  }
  return (t.online && t.online.coverUrl) || null;
});

// Chromium can't play AIFF/ALAC/WMA… → transcode to a cached FLAC on demand.
ipcMain.handle('track:playable', async (_e, id) => {
  const t = library.get(id);
  if (!t) return null;
  const out = path.join(library.playDir, id + '.flac');
  await transcodeForPlayback(t.path, out);
  return pathToFileURL(out).href;
});

const dragIcon = () => nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'drag.png'));
ipcMain.on('track:drag', (e, ids) => {
  const files = ids.map((id) => library.get(id)).filter(Boolean).map((t) => t.path);
  if (!files.length) return;
  e.sender.startDrag(files.length === 1 ? { file: files[0], icon: dragIcon() } : { files, icon: dragIcon() });
});

ipcMain.on('track:context', (e, ids) => {
  const tracks = ids.map((id) => library.get(id)).filter(Boolean);
  if (!tracks.length) return;
  const one = tracks[0];
  Menu.buildFromTemplate([
    { label: isMac ? 'Afficher dans le Finder' : "Afficher dans l'Explorateur", click: () => shell.showItemInFolder(one.path) },
    { label: 'Copier le chemin', click: () => clipboard.writeText(tracks.map((t) => t.path).join('\n')) },
    { type: 'separator' },
    { label: tracks.length > 1 ? `Ré-analyser (${tracks.length})` : 'Ré-analyser', click: () => library.reanalyze(tracks.map((t) => t.id)) },
    { label: 'BPM ×2   ( * )', click: () => library.setBpm(tracks.map((t) => t.id), 2) },
    { label: 'BPM ÷2   ( / )', click: () => library.setBpm(tracks.map((t) => t.id), 0.5) },
    { label: 'Grille automatique (annuler BPM et calage manuels)', enabled: tracks.some((t) => t.edit), click: () => tracks.forEach((t) => library.setGrid(t.id, { reset: true })) },
    { type: 'separator' },
    { label: 'Re-chercher les métadonnées en ligne', click: () => library.refetchOnline(tracks.map((t) => t.id)) },
    { type: 'separator' },
    { label: 'Ouvrir sur Discogs', enabled: !!(one.online && one.online.discogsUrl), click: () => shell.openExternal(one.online.discogsUrl) },
    { label: 'Ouvrir sur MusicBrainz', enabled: !!(one.online && one.online.mbUrl), click: () => shell.openExternal(one.online.mbUrl) },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

ipcMain.handle('export', async (_e, { format, ids, name }) => {
  const tracks = ids.map((id) => library.get(id)).filter(Boolean);
  if (format === 'rekordbox') {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'cratescope-rekordbox.xml', filters: [{ name: 'rekordbox XML', extensions: ['xml'] }] });
    if (r.canceled || !r.filePath) return null;
    const res = buildXml(tracks.map((t) => ({ ...t, analysis: library.effectiveAnalysis(t) })), { playlistName: name || 'CrateScope' });
    fs.writeFileSync(r.filePath, res.xml);
    shell.showItemInFolder(r.filePath);
    return { count: res.count, skipped: res.skipped.map((t) => t.name) };
  }
  const r = await dialog.showSaveDialog(win, {
    defaultPath: format === 'csv' ? 'cratescope.csv' : 'cratescope.m3u8',
    filters: format === 'csv' ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'Playlist', extensions: ['m3u8'] }],
  });
  if (r.canceled || !r.filePath) return false;
  if (format === 'csv') {
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['Path', 'Artist', 'Title', 'BPM', 'Key', 'Camelot', 'LUFS', 'Duration', 'Genre', 'Style', 'Year', 'Label'];
    const rows = tracks.map((t) => {
      const tg = (t.probe && t.probe.tags) || {}, a = library.effectiveAnalysis(t) || {}, o = t.online || {};
      return [t.path, tg.artist || t.parsed.artist, tg.title || t.parsed.title, a.bpm, a.key, a.camelot, a.lufs,
        a.duration ? a.duration.toFixed(1) : '', [tg.genre, ...(o.genres || [])].filter(Boolean).join('; '),
        (o.styles || []).join('; '), tg.year || o.year, tg.label || o.label].map(q).join(',');
    });
    fs.writeFileSync(r.filePath, [head.join(','), ...rows].join('\n'));
  } else {
    const lines = ['#EXTM3U', ...tracks.flatMap((t) => {
      const tg = (t.probe && t.probe.tags) || {};
      const dur = Math.round((t.analysis && t.analysis.duration) || (t.probe && t.probe.duration) || -1);
      return [`#EXTINF:${dur},${tg.artist || t.parsed.artist} - ${tg.title || t.parsed.title}`, t.path];
    })];
    fs.writeFileSync(r.filePath, lines.join('\n'));
  }
  shell.showItemInFolder(r.filePath);
  return true;
});

ipcMain.on('open:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
