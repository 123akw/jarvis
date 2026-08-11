/* 可测试的桌面微信设置状态与轮询控制器；浏览器和 Node 共用。 */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JarvisWeChatUI = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  function viewFor(state = {}) {
    if (state.state === 'connected') {
      return {
        kind: 'connected',
        status: '✓ 微信已连接。在微信里给这个号发消息，贾维斯就会回你。',
        statusClass: 's-hint ok',
      }
    }
    if (state.state === 'waiting') {
      return {
        kind: 'waiting',
        qrUri: state.qr_uri || '',
        status: '用微信「扫一扫」扫描上方二维码，手机确认登录（建议用专用小号）',
        statusClass: 's-hint wait',
      }
    }
    if (state.state === 'loading') {
      return {
        kind: 'loading',
        status: '正在取二维码…',
        statusClass: 's-hint wait',
      }
    }
    return {
      kind: 'idle',
      status: state.error || '扫一次码，即可在微信里直接和贾维斯对话（建议用专用小号）',
      statusClass: state.error ? 's-hint wait' : 's-hint',
    }
  }

  function createController({
    request,
    render,
    reauthenticate = async () => false,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    let timer = null

    async function fetchState(path, options) {
      let response = await request(path, options)
      if (response.status === 401 && await reauthenticate()) {
        response = await request(path, options)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function poll() {
      try {
        render(await fetchState('/api/wechat/status'))
      } catch {
        render({ state: 'error', error: '连不上服务器，请稍后重试' })
      }
    }

    async function connect() {
      render({ state: 'loading' })
      try {
        render(await fetchState('/api/wechat/connect', { method: 'POST' }))
      } catch {
        render({ state: 'error', error: '连不上服务器，请稍后重试' })
      }
    }

    async function disconnect() {
      try {
        render(await fetchState('/api/wechat/disconnect', { method: 'POST' }))
      } catch {
        render({ state: 'error', error: '断开失败，请稍后重试' })
      }
    }

    function stop() {
      if (timer !== null) {
        clearIntervalFn(timer)
        timer = null
      }
    }

    function start() {
      stop()
      const initial = poll()
      timer = setIntervalFn(poll, 2000)
      return initial
    }

    return { start, stop, poll, connect, disconnect }
  }

  return { viewFor, createController }
})
