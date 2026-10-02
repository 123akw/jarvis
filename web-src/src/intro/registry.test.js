import { describe, expect, it } from 'vitest'
import { INTROS, SEEN_KEY, markSeen, pickIntro } from './registry.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, data }
}

describe('pickIntro', () => {
  it('?intro=<name> 强制预览，即使看过或 reduced-motion', () => {
    const storage = memoryStorage({ [SEEN_KEY]: '1' })
    expect(pickIntro({ search: '?intro=orb', storage, reducedMotion: true })).toBe('orb')
  })

  it('?intro=off 与未知方案名都不播', () => {
    expect(pickIntro({ search: '?intro=off', fallback: 'orb' })).toBeNull()
    expect(pickIntro({ search: '?intro=nope' })).toBeNull()
  })

  it('默认方案为空时不播', () => {
    expect(pickIntro({ fallback: null })).toBeNull()
  })

  it('有默认方案时同一会话只播一次', () => {
    const storage = memoryStorage()
    expect(pickIntro({ storage, fallback: 'light' })).toBe('light')
    markSeen(storage)
    expect(pickIntro({ storage, fallback: 'light' })).toBeNull()
  })

  it('reduced-motion 时不自动播', () => {
    expect(pickIntro({ fallback: 'light', reducedMotion: true })).toBeNull()
  })

  it('存储抛错不影响选择', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(pickIntro({ storage: broken, fallback: 'rings' })).toBe('rings')
    expect(() => markSeen(broken)).not.toThrow()
  })

  it('三个方案都已登记且是懒加载函数', () => {
    expect(Object.keys(INTROS).sort()).toEqual(['light', 'orb', 'rings'])
    Object.values(INTROS).forEach(load => expect(typeof load).toBe('function'))
  })
})
