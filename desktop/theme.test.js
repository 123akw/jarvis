const assert = require('node:assert/strict')
const { test } = require('node:test')
const { KEY, normalizePref, resolveTheme, createThemeController } = require('./theme.js')

function fakeClassList() {
  const set = new Set()
  return { toggle: (c, on) => { if (on) set.add(c); else set.delete(c) }, has: c => set.has(c) }
}
function fakeStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, data }
}
function fakeMedia(matches) {
  const listeners = []
  const mq = { matches, addEventListener: (_t, fn) => listeners.push(fn) }
  return { matchMedia: () => mq, flip(v) { mq.matches = v; listeners.forEach(fn => fn()) } }
}

test('偏好归一：未知值一律按深色（与网页端暗色为默认一致）', () => {
  assert.equal(normalizePref('light'), 'light')
  assert.equal(normalizePref('system'), 'system')
  for (const v of [null, undefined, '', 'auto', 'LIGHT']) assert.equal(normalizePref(v), 'dark')
})

test('resolveTheme：跟随系统看系统外观，手动偏好压过系统', () => {
  assert.equal(resolveTheme('system', true), 'light')
  assert.equal(resolveTheme('system', false), 'dark')
  assert.equal(resolveTheme('dark', true), 'dark')
  assert.equal(resolveTheme('light', false), 'light')
})

test('默认深色，不受系统浅色影响', () => {
  const classList = fakeClassList()
  const media = fakeMedia(true)
  const theme = createThemeController({ storage: fakeStorage(), matchMedia: media.matchMedia, classList })
  assert.equal(theme.pref(), 'dark')
  assert.equal(classList.has('light'), false)
})

test('选「跟随系统」后，系统外观切换即时生效', () => {
  const classList = fakeClassList()
  const media = fakeMedia(false)
  const theme = createThemeController({ storage: fakeStorage(), matchMedia: media.matchMedia, classList })
  assert.equal(theme.set('system'), 'dark')
  media.flip(true)
  assert.equal(classList.has('light'), true, '系统换浅色，body.light 立即挂上')
  media.flip(false)
  assert.equal(classList.has('light'), false)
})

test('手动固定浅色后不再跟随系统；存储坏了也不抛', () => {
  const classList = fakeClassList()
  const media = fakeMedia(false)
  const storage = fakeStorage()
  const theme = createThemeController({ storage, matchMedia: media.matchMedia, classList })
  assert.equal(theme.set('light'), 'light')
  assert.equal(storage.data[KEY], 'light')
  assert.equal(classList.has('light'), true)
  media.flip(false)
  assert.equal(classList.has('light'), true)
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const t2 = createThemeController({ storage: broken, matchMedia: () => null, classList: fakeClassList() })
  assert.equal(t2.pref(), 'dark')
  assert.equal(t2.set('light'), 'dark', '存不下就回落默认深色')
})
