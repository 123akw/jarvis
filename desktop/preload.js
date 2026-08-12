const { contextBridge, ipcRenderer } = require('electron')
const { randomUUID } = require('crypto')
const { createEventApi, createPreloadApi } = require('./preload-api.js')

// Remove the former renderer token before any renderer script can read it.
try { window.localStorage.removeItem('jws_token') } catch {}

const eventApi = createEventApi(ipcRenderer)

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
  showLogin: () => ipcRenderer.invoke('show-login'),
  openProviderLink: url => ipcRenderer.invoke('open-provider-link', url),
  onForceExpand: eventApi.onForceExpand,
  onSetExpanded: eventApi.onSetExpanded,
  api: createPreloadApi(ipcRenderer, randomUUID),
})
