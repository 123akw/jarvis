/* Renderer-side orchestration over the fixed preload streaming bridge. */
;(function expose(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.JWSChatStream = api
})(typeof globalThis === 'undefined' ? this : globalThis, function createApi() {
  function startChatStream(api, body, { onEvent, onUnauthorized = () => {} }) {
    const id = api.startStream('chat', body, onEvent)
    const done = api.streamDone(id).then(result => {
      if (result.status === 401) onUnauthorized()
      return result
    })
    return { done, cancel: () => api.cancelStream(id) }
  }
  return { startChatStream }
})
