/* Desktop-only API session bootstrap; token lifetime stays in renderer memory. */
(function (root, factory) {
  const api = factory()
  root.JWSDesktopAuth = api
  if (typeof module !== 'undefined') module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createDesktopAuthenticator({ request, username, password }) {
    let token = ''

    function headers() {
      return token ? { 'X-JWS-Token': token } : {}
    }

    async function ensureLogin() {
      try {
        const session = await request('/api/session', { headers: headers() })
        if (session.ok && (await session.json()).authed) return true
      } catch { /* proceed to explicit desktop login */ }
      const response = await request('/api/desktop/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) return false
      const issued = await response.json()
      token = issued.access_token || ''
      return Boolean(token)
    }

    return { ensureLogin, headers }
  }

  return { createDesktopAuthenticator }
})
