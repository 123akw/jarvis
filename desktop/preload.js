const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jws', {
  toggle: () => ipcRenderer.invoke('toggle'),
  collapse: () => ipcRenderer.invoke('collapse'),
  onForceExpand: cb => ipcRenderer.on('force-expand', cb),
})
