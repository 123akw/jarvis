import { describe, expect, it } from 'vitest'
import { introAllowed, parseRoute } from './routes.js'

describe('parseRoute', () => {
  it('识别市场、流程与平台入口，其余归主应用', () => {
    expect(parseRoute('/market')).toEqual({ name: 'market', params: {} })
    expect(parseRoute('/market/')).toEqual({ name: 'market', params: {} })
    expect(parseRoute('/flows')).toEqual({ name: 'flows', params: {} })
    expect(parseRoute('/p/ab12cd34')).toEqual({ name: 'platform', params: { slug: 'ab12cd34' } })
    expect(parseRoute('/p/x')).toEqual({ name: 'app', params: {} })
    expect(parseRoute('/')).toEqual({ name: 'app', params: {} })
    expect(parseRoute('/whatever')).toEqual({ name: 'app', params: {} })
  })
  it('进场动画只在主应用与市场播', () => {
    expect(introAllowed('/')).toBe(true)
    expect(introAllowed('/market')).toBe(true)
    expect(introAllowed('/p/ab12cd34')).toBe(false)
    expect(introAllowed('/flows')).toBe(false)
  })
})
