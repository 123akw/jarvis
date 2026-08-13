'use strict'

function createEventApi(ipcRenderer) {
  function subscribe(channel, listener) {
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
  return {
    onForceExpand(callback) {
      return subscribe('force-expand', () => callback())
    },
    onSetExpanded(callback) {
      return subscribe('set-expanded', (_event, value) => {
        if (typeof value === 'boolean') callback(value)
      })
    },
    onHandoffAuthenticated(callback) {
      // 网页端接管换票成功：主进程已持有令牌，渲染层只收到「重新探活」信号
      return subscribe('handoff-authenticated', () => callback())
    },
    onWakeNotice(callback) {
      return subscribe('wake-server-notice', (_event, text) => {
        if (typeof text === 'string' && text) callback(text.slice(0, 500))
      })
    },
  }
}

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

module.exports = { createEventApi, createPreloadApi }
