const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jws', {
  toggle: () => ipcRenderer.invoke('toggle'),
  collapse: () => ipcRenderer.invoke('collapse'),
  clipboardText: () => ipcRenderer.invoke('clipboard-text'),
  codingStatus: () => ipcRenderer.invoke('coding-status'),
  dragStart: (mx, my) => ipcRenderer.send('ball-drag-start', { mx, my }),
  dragMove: (mx, my) => ipcRenderer.send('ball-drag-move', { mx, my }),
  dragEnd: () => ipcRenderer.send('ball-drag-end'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: patch => ipcRenderer.invoke('set-settings', patch),
  onForceExpand: cb => ipcRenderer.on('force-expand', cb),
  onSetExpanded: cb => ipcRenderer.on('set-expanded', (_e, v) => cb(v)),
})
