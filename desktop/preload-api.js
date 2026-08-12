'use strict'

function createPreloadApi(ipcRenderer, randomId) {
  const streams = new Map()
  return {
    login: (username, password) => ipcRenderer.invoke('api-login', { username, password }),
    request: (operation, body) => ipcRenderer.invoke('api-request', operation, body),
    startStream(operation, body, onEvent) {
      const id = randomId()
      const listener = (_event, message) => {
        if (message && message.id === id && message.event) onEvent(message.event)
      }
      ipcRenderer.on('api-stream-event', listener)
      const done = ipcRenderer.invoke('api-stream-start', id, operation, body)
      streams.set(id, { done, listener })
      return id
    },
    async streamDone(id) {
      const active = streams.get(id)
      if (!active) throw new Error('unknown stream')
      try { return await active.done }
      finally { ipcRenderer.removeListener('api-stream-event', active.listener); streams.delete(id) }
    },
    cancelStream: id => ipcRenderer.invoke('api-stream-cancel', id),
  }
}

module.exports = { createPreloadApi }
