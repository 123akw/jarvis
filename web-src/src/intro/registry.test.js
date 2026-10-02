import { describe, expect, it } from 'vitest'
import { DEFAULT_INTRO, INTROS, pickIntro } from './registry.js'

describe('pickIntro', () => {
  it('每次打开都播默认方案：不再「同一会话只播一次」', () => {
    expect(pickIntro()).toBe('awaken')
    expect(pickIntro()).toBe('awaken')
    expect(pickIntro({ fallback: 'awaken' })).toBe('awaken')
  })

  it('?intro=<name> 强制预览；?intro=off 不播；未知方案名不算强制预览，按默认规则走', () => {
    expect(pickIntro({ search: '?intro=awaken', fallback: null })).toBe('awaken')
    expect(pickIntro({ search: '?intro=off', fallback: 'awaken' })).toBeNull()
    expect(pickIntro({ search: '?intro=nope', fallback: null })).toBeNull()
    expect(pickIntro({ search: '?intro=nope' })).toBe('awaken')
  })

  it('默认方案为空或未登记时不播', () => {
    expect(pickIntro({ fallback: null })).toBeNull()
    expect(pickIntro({ fallback: 'nope' })).toBeNull()
  })

  it('只登记最终版 awaken，且设为默认（懒加载函数）', () => {
    expect(Object.keys(INTROS)).toEqual(['awaken'])
    expect(DEFAULT_INTRO).toBe('awaken')
    expect(typeof INTROS.awaken).toBe('function')
  })
})
