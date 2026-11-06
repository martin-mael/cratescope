'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

window.addEventListener('DOMContentLoaded', () => document.body.classList.add(`platform-${process.platform}`));

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('library:choose'),
  openLast: () => ipcRenderer.invoke('library:openLast'),
  focus: (dir, recursive) => ipcRenderer.send('library:focus', { dir, recursive }),
  reanalyze: (ids) => ipcRenderer.send('library:reanalyze', ids),
  reanalyzeStale: () => ipcRenderer.send('library:reanalyzeStale'),
  refetch: (ids) => ipcRenderer.send('library:refetch', ids),
  setBpm: (ids, factor) => ipcRenderer.send('library:bpm', { ids, factor }),
  setGrid: (id, patch) => ipcRenderer.send('library:grid', { id, patch }),
  setMeta: (ids, patch) => ipcRenderer.send('library:meta', { ids, patch }),
  waves: (id) => ipcRenderer.invoke('track:waves', id),
  cover: (id) => ipcRenderer.invoke('track:cover', id),
  playable: (id) => ipcRenderer.invoke('track:playable', id),
  startDrag: (ids, image) => ipcRenderer.send('track:drag', { ids, image }),
  contextMenu: (ids, playlist) => ipcRenderer.send('track:context', { ids, playlist }),
  exportList: (format, ids, name) => ipcRenderer.invoke('export', { format, ids, name }),
  exportPlaylists: (format, ids) => ipcRenderer.invoke('export:playlists', { format, ids }),
  playlists: () => ipcRenderer.invoke('playlists:get'),
  createPlaylist: (name, ids, query) => ipcRenderer.invoke('playlists:create', { name, ids, query }),
  setPlaylistQuery: (id, query) => ipcRenderer.send('playlists:setQuery', { id, query }),
  movePlaylistTracks: (id, ids, to) => ipcRenderer.send('playlists:move', { id, ids, to }),
  addToPlaylist: (id, ids) => ipcRenderer.send('playlists:add', { id, ids }),
  addFilesToPlaylist: (id, files) => ipcRenderer.invoke('playlists:addFiles', { id, files }),
  removeFromPlaylist: (id, ids) => ipcRenderer.send('playlists:removeTracks', { id, ids }),
  renamePlaylist: (id, name) => ipcRenderer.send('playlists:rename', { id, name }),
  deletePlaylist: (id) => ipcRenderer.send('playlists:delete', id),
  playlistMenu: (id) => ipcRenderer.send('playlists:context', id),
  newPlaylistMenu: (search) => ipcRenderer.send('playlists:newMenu', search),
  pathForFile: (file) => webUtils.getPathForFile(file),
  columnsMenu: (items) => ipcRenderer.send('columns:menu', items),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  onUpdate: on('library:update'),
  onRemoved: on('library:removed'),
  onSnapshot: on('library:snapshot'),
  onPlaylists: on('playlists:update'),
  onNewPlaylist: on('playlists:new'),
  onRenamePlaylist: on('playlists:rename'),
  onEditPlaylistQuery: on('playlists:editQuery'),
  onNewSmartPlaylist: on('playlists:newSmart'),
  onExportDone: on('export:done'),
  onUpdateState: on('update:state'),
  onColumnToggle: on('columns:toggle'),
  onEditInfo: on('meta:edit'),
});
