import { describe, expect, it } from 'vitest'
import { DEFAULT_INTRO, INTROS, SEEN_KEY, markSeen, pickIntro } from './registry.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, data }
}

describe('pickIntro', () => {
  it('?intro=<name> 强制预览，即使看过或 reduced-motion', () => {
    const storage = memoryStorage({ [SEEN_KEY]: '1' })
    expect(pickIntro({ search: '?intro=awaken', storage, reducedMotion: true })).toBe('awaken')
  })

  it('?intro=off 不播；未知方案名不算强制预览，按默认规则走', () => {
    expect(pickIntro({ search: '?intro=off', fallback: 'awaken' })).toBeNull()
    expect(pickIntro({ search: '?intro=nope', fallback: null })).toBeNull()
    expect(pickIntro({ search: '?intro=nope', storage: memoryStorage({ [SEEN_KEY]: '1' }) })).toBeNull()
  })

  it('默认方案为空时不播', () => {
    expect(pickIntro({ fallback: null })).toBeNull()
  })

  it('有默认方案时同一会话只播一次', () => {
    const storage = memoryStorage()
    expect(pickIntro({ storage, fallback: 'awaken' })).toBe('awaken')
    markSeen(storage)
    expect(pickIntro({ storage, fallback: 'awaken' })).toBeNull()
  })

  it('reduced-motion 时不自动播', () => {
    expect(pickIntro({ fallback: 'awaken', reducedMotion: true })).toBeNull()
  })

  it('存储抛错不影响选择', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(pickIntro({ storage: broken, fallback: 'awaken' })).toBe('awaken')
    expect(() => markSeen(broken)).not.toThrow()
  })

  it('只登记最终版 awaken，且设为默认（懒加载函数）', () => {
    expect(Object.keys(INTROS)).toEqual(['awaken'])
    expect(DEFAULT_INTRO).toBe('awaken')
    expect(typeof INTROS.awaken).toBe('function')
  })

  it('默认规则：首次播 awaken，?intro=off 关闭，?intro=awaken 强制预览，reduced-motion 不自动播', () => {
    const storage = memoryStorage()
    expect(pickIntro({ storage })).toBe('awaken')
    expect(pickIntro({ search: '?intro=off', storage })).toBeNull()
    expect(pickIntro({ reducedMotion: true })).toBeNull()
    markSeen(storage)
    expect(pickIntro({ storage })).toBeNull()
    expect(pickIntro({ search: '?intro=awaken', storage, reducedMotion: true })).toBe('awaken')
  })
})
