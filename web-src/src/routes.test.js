import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  APP_PATH, introAllowed, LOGIN_PATH, loginHref, MARKET_PATH, navigate, pageTitle, parseRoute, redirectFor, safeNext, useRoute,
} from './routes.js'

describe('parseRoute', () => {
  it('/ 市场、/login 登录、/app 主应用；流程与平台入口不变', () => {
    expect(parseRoute('/')).toEqual({ name: 'market', params: {} })
    expect(parseRoute('')).toEqual({ name: 'market', params: {} })
    expect(parseRoute('/login')).toEqual({ name: 'login', params: {} })
    expect(parseRoute('/login/')).toEqual({ name: 'login', params: {} })
    expect(parseRoute('/app')).toEqual({ name: 'app', params: {} })
    expect(parseRoute('/app/')).toEqual({ name: 'app', params: {} })
    expect(parseRoute('/flows')).toEqual({ name: 'flows', params: {} })
    expect(parseRoute('/p/ab12cd34')).toEqual({ name: 'platform', params: { slug: 'ab12cd34' } })
  })
  it('/market 是旧链接；其它路径不认识', () => {
    expect(parseRoute('/market').name).toBe('legacy-market')
    expect(parseRoute('/market/').name).toBe('legacy-market')
    expect(parseRoute('/p/x').name).toBe('notfound')
    expect(parseRoute('/whatever').name).toBe('notfound')
    expect(parseRoute('/app/extra').name).toBe('notfound')
  })
})

describe('redirectFor：旧链接兼容', () => {
  it('/market → /，查询参数保留', () => {
    expect(redirectFor('/market')).toBe('/')
    expect(redirectFor('/market', '?tab=official&q=x')).toBe('/?tab=official&q=x')
  })
  it('根路径带 ?u= 的旧二维码 / 分享 → /login?u=…（其余参数一起带上）', () => {
    expect(redirectFor('/', '?u=jvabc123')).toBe('/login?u=jvabc123')
    expect(redirectFor('/', '?u=%E9%99%88&intro=off')).toBe('/login?u=%E9%99%88&intro=off')
    expect(redirectFor('/market', '?u=jvabc123')).toBe('/login?u=jvabc123')
  })
  it('未知路径回首页；正常页面不跳', () => {
    expect(redirectFor('/whatever', '?a=1')).toBe('/')
    expect(redirectFor('/p/x')).toBe('/')
    for (const p of ['/', '/login', '/app', '/flows', '/p/ab12cd34']) expect(redirectFor(p, '?intro=off')).toBe('')
    expect(redirectFor('/login', '?u=jvabc123')).toBe('')
    expect(redirectFor('/p/ab12cd34', '?u=jvabc123')).toBe('')   // 平台入口自己处理 ?u=
  })
})

describe('safeNext：登录后只回本站', () => {
  it('接受站内路径（含查询与 hash）', () => {
    expect(safeNext('/app')).toBe('/app')
    expect(safeNext('/flows?x=1#a')).toBe('/flows?x=1#a')
    expect(safeNext('/')).toBe('/')
    expect(safeNext('/p/ab12cd34')).toBe('/p/ab12cd34')
  })
  it('拒绝站外地址、协议相对地址、反斜杠绕过、伪协议、控制字符', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)',
      'evil.example/app', '/\tevil', ' //evil.example', '', null, undefined]) {
      expect(safeNext(bad)).toBe('')
    }
  })
  it('不回登录页自己（避免绕圈）', () => {
    expect(safeNext('/login')).toBe('')
    expect(safeNext('/login?next=/app')).toBe('')
  })
})

describe('第十五轮路径约定', () => {
  it('loginHref 预填账号、只接受站内 next', () => {
    expect([MARKET_PATH, LOGIN_PATH, APP_PATH]).toEqual(['/', '/login', '/app'])
    expect(loginHref()).toBe('/login')
    expect(loginHref('jvabc123')).toBe('/login?u=jvabc123')
    expect(loginHref('jvabc123', '/flows')).toBe('/login?u=jvabc123&next=%2Fflows')
    expect(loginHref('', '//evil.example')).toBe('/login')
    expect(loginHref('', 'https://evil.example')).toBe('/login')
    expect(loginHref('', '/\\evil.example')).toBe('/login')
    expect(loginHref('', '/login')).toBe('/login')
  })
  it('页面标题：市场、登录页各自的；主应用沿用原标题；流程页与平台入口自己管', () => {
    expect(pageTitle('market')).toBe('贾维斯 · 智能体市场')
    expect(pageTitle('login')).toBe('登录 · 贾维斯')
    expect(pageTitle('app')).toBe('J.A.R.V.I.S. · 私人管家')
    expect(pageTitle('flows')).toBe('')
    expect(pageTitle('platform')).toBe('')
  })
})

describe('进场动画', () => {
  it('每次打开都播：市场、登录页、主应用、流程页都播；只有品牌智能体入口不播', () => {
    expect(introAllowed('/')).toBe(true)
    expect(introAllowed('/market')).toBe(true)          // 旧链接，跳到 / 后播
    expect(introAllowed('/login')).toBe(true)
    expect(introAllowed('/app')).toBe(true)
    expect(introAllowed('/flows')).toBe(true)
    expect(introAllowed('/', '?u=jvabc123')).toBe(true)   // 旧二维码会落到登录页
    expect(introAllowed('/p/ab12cd34')).toBe(false)
  })
})

describe('useRoute', () => {
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('打开旧链接：地址栏原地换成新地址（hash 保留、不多一条历史），再解析', () => {
    window.history.replaceState({}, '', '/?u=jvabc123#top')
    const before = window.history.length
    const { result } = renderHook(() => useRoute())
    expect(result.current.name).toBe('login')
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/login?u=jvabc123#top')
    expect(window.history.length).toBe(before)
  })

  it('站内跳到 /market 也会落到 /；未知路径回首页', () => {
    window.history.replaceState({}, '', '/app')
    const { result } = renderHook(() => useRoute())
    expect(result.current.name).toBe('app')
    act(() => navigate('/market?tab=official'))
    expect(result.current.name).toBe('market')
    expect(window.location.pathname + window.location.search).toBe('/?tab=official')
    act(() => navigate('/nope'))
    expect(result.current.name).toBe('market')
    expect(window.location.pathname).toBe('/')
  })
})

describe('流程画布路由（第十八轮）', () => {
  it('/flows/<id> 仍是 flows 页面并带上 id；非法 id 回首页', async () => {
    const { flowHref } = await import('./routes.js')
    expect(parseRoute('/flows')).toEqual({ name: 'flows', params: {} })
    expect(parseRoute('/flows/abc_123')).toEqual({ name: 'flows', params: { id: 'abc_123' } })
    expect(parseRoute('/flows/new/')).toEqual({ name: 'flows', params: { id: 'new' } })
    expect(parseRoute('/flows/a/b').name).toBe('notfound')
    expect(flowHref()).toBe('/flows')
    expect(flowHref('new')).toBe('/flows/new')
    expect(redirectFor('/flows/abc')).toBe('')
  })
})

describe('第二十轮路由', () => {
  it('/admin 与 /approve/<id>', () => {
    expect(parseRoute('/admin')).toEqual({ name: 'admin', params: {} })
    expect(parseRoute('/approve/abc12345')).toEqual({ name: 'approve', params: { id: 'abc12345' } })
    expect(parseRoute('/approve/x').name).toBe('notfound')
    expect(pageTitle('admin')).toBe('管理后台 · 贾维斯')
  })
})
