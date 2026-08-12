/* Renderer login state without credentials or network ownership. */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSLoginController = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  function authenticationRequired() {
    const error = new Error('登录已失效，请重新登录')
    error.code = 'AUTH_REQUIRED'
    return error
  }
  function createAuthenticatedApi(api, { onUnauthorized = async () => {} } = {}) {
    return {
      async request(operation, body) {
        const result = await api.request(operation, body)
        if (result.status !== 401) return result
        await onUnauthorized()
        throw authenticationRequired()
      },
    }
  }
  function isAuthenticationRequired(error) { return Boolean(error && error.code === 'AUTH_REQUIRED') }
  function createLoginController({ api, getSettings = async () => ({}), setSettings = async () => ({}),
    showLogin = async () => {}, setLoginVisible = () => {}, clearPassword = () => {}, onAuthenticated = async () => {} }) {
    async function requireLogin() {
      await showLogin()
      setLoginVisible(true)
    }
    async function init() {
      const settings = await getSettings()
      const probe = await api.request('session')
      if (probe.ok && probe.data && probe.data.authed) {
        setLoginVisible(false)
        await onAuthenticated()
        return { authenticated: true, server: settings.server || '' }
      }
      await requireLogin()
      return { authenticated: false, server: settings.server || '' }
    }
    async function login(username, password) {
      try {
        const result = await api.login(username, password)
        if (result.ok) { setLoginVisible(false); await onAuthenticated() }
        return result
      } finally { clearPassword() }
    }
    async function saveServer(server) { return setSettings({ server: server.trim().replace(/\/+$/, '') }) }
    return { init, login, requireLogin, saveServer }
  }
  return { createAuthenticatedApi, createLoginController, isAuthenticationRequired }
})
