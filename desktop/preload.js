const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jws', {
  toggle: () => ipcRenderer.invoke('toggle'),
  collapse: () => ipcRenderer.invoke('collapse'),
  codingStatus: () => ipcRenderer.invoke('coding-status'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: patch => ipcRenderer.invoke('set-settings', patch),
  onForceExpand: cb => ipcRenderer.on('force-expand', cb),
  onSetExpanded: cb => ipcRenderer.on('set-expanded', (_e, v) => cb(v)),
})
