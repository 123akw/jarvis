'use strict'

const { assertTrustedSender } = require('./security.js')

function createApiHandlers({ gateway, getWindow, indexUrl }) {
  const streams = new Map()
  const trusted = event => assertTrustedSender(event, getWindow(), indexUrl)
  const streamId = id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new Error('invalid stream id')
    return id
  }
  return {
    async login(event, credentials) {
      trusted(event)
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('invalid credential body')
      const keys = Object.keys(credentials)
      if (keys.length !== 2 || !keys.includes('username') || !keys.includes('password')) throw new Error('invalid credential field')
      if (typeof credentials.username !== 'string' || !credentials.username.trim() || credentials.username.length > 128) throw new Error('invalid username')
      if (typeof credentials.password !== 'string' || !credentials.password || credentials.password.length > 1024) throw new Error('invalid password')
      return gateway.login(credentials.username, credentials.password)
    },
    async request(event, operation, body) { trusted(event); return gateway.request(operation, body) },
    async start(event, id, operation, body) {
      trusted(event); streamId(id)
      if (streams.has(id)) throw new Error('stream already exists')
      const controller = new AbortController()
      const owner = event.sender
      streams.set(id, { controller, owner })
      try {
        return await gateway.stream(operation, body, {
          signal: controller.signal,
          onEvent: item => owner.send('api-stream-event', { id, event: item }),
        })
      } finally { streams.delete(id) }
    },
    async cancel(event, id) {
      trusted(event); streamId(id)
      const active = streams.get(id)
      if (!active || active.owner !== event.sender) return { cancelled: false }
      active.controller.abort()
      return { cancelled: true }
    },
  }
}

module.exports = { createApiHandlers }
