'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('library:choose'),
  openLast: () => ipcRenderer.invoke('library:openLast'),
  focus: (dir, recursive) => ipcRenderer.send('library:focus', { dir, recursive }),
  reanalyze: (ids) => ipcRenderer.send('library:reanalyze', ids),
  reanalyzeStale: () => ipcRenderer.send('library:reanalyzeStale'),
  refetch: (ids) => ipcRenderer.send('library:refetch', ids),
  waves: (id) => ipcRenderer.invoke('track:waves', id),
  cover: (id) => ipcRenderer.invoke('track:cover', id),
  playable: (id) => ipcRenderer.invoke('track:playable', id),
  startDrag: (ids) => ipcRenderer.send('track:drag', ids),
  contextMenu: (ids) => ipcRenderer.send('track:context', ids),
  exportList: (format, ids) => ipcRenderer.invoke('export', { format, ids }),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  onUpdate: on('library:update'),
  onRemoved: on('library:removed'),
  onSnapshot: on('library:snapshot'),
});
