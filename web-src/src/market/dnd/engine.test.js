import { describe, expect, it } from 'vitest'
import { inRect, moveItem, resolveAdd, say, shiftFor, slotOffset, sortTarget, toneOf } from './engine.js'

describe('拖拽纯逻辑', () => {
  it('放置判定：在矩形内 / 外，pad 放宽', () => {
    const r = { left: 0, top: 700, right: 400, bottom: 780 }
    expect(inRect(200, 740, r)).toBe(true)
    expect(inRect(200, 690, r)).toBe(false)
    expect(inRect(200, 690, r, 14)).toBe(true)     // 磁吸：外沿 14px 内也算
    expect(inRect(410, 740, r, 14)).toBe(true)
    expect(inRect(420, 740, r, 14)).toBe(false)
    expect(inRect(1, 1, null)).toBe(false)
  })

  it('原因的语气：已在工具箱是灰，其他是红', () => {
    expect(toneOf('')).toBe('ok')
    expect(toneOf('已在工具箱')).toBe('same')
    expect(toneOf('需要管理员配置')).toBe('deny')
    expect(toneOf('缺少 Python 包：openpyxl')).toBe('deny')
  })

  it('resolveAdd：单个能加 / 不能加；套装只加能加的；全都加不了给原因', () => {
    const picked = new Set(['todo'])
    const canAdd = id => (picked.has(id) ? '已在工具箱' : id === 'amap' ? '需要管理员配置' : '')
    expect(resolveAdd(['weather'], canAdd)).toEqual({ ids: ['weather'], reason: '', tone: 'ok' })
    expect(resolveAdd(['amap'], canAdd)).toEqual({ ids: [], reason: '需要管理员配置', tone: 'deny' })
    expect(resolveAdd(['todo'], canAdd)).toEqual({ ids: [], reason: '已在工具箱', tone: 'same' })
    expect(resolveAdd(['memo', 'todo', 'weather', 'amap', 'memo'], canAdd, 'bundle')).toEqual({ ids: ['memo', 'weather'], reason: '', tone: 'ok' })
    expect(resolveAdd(['todo', 'amap'], canAdd, 'bundle')).toEqual({ ids: [], reason: '这一套都已在工具箱里', tone: 'same' })
    expect(resolveAdd(['amap'], canAdd, 'bundle')).toEqual({ ids: [], reason: '需要管理员配置', tone: 'deny' })
    expect(resolveAdd(['a', 'b'])).toEqual({ ids: ['a', 'b'], reason: '', tone: 'ok' })       // 没给 canAdd：都能加
    expect(resolveAdd([], canAdd).tone).toBe('deny')
    expect(resolveAdd(['x'], () => { throw new Error('boom') }).ids).toEqual(['x'])     // canAdd 出错不拦
  })

  it('排序：目标下标、让位、空位偏移、挪动', () => {
    const rows = [0, 1, 2, 3].map(i => ({ top: i * 50, height: 44 }))   // 行高 44，间距 6
    expect(sortTarget(rows, 0, 22)).toBe(0)
    expect(sortTarget(rows, 0, 80)).toBe(1)         // 越过第 2 行中线（72）
    expect(sortTarget(rows, 0, 175)).toBe(3)
    expect(sortTarget(rows, 3, 10)).toBe(0)
    expect(sortTarget(rows, 2, 60)).toBe(1)
    expect([0, 1, 2, 3].map(i => shiftFor(i, 0, 2, 50))).toEqual([0, -50, -50, 0])
    expect([0, 1, 2, 3].map(i => shiftFor(i, 3, 1, 50))).toEqual([0, 50, 50, 0])
    expect([0, 1, 2, 3].map(i => shiftFor(i, 1, null, 50))).toEqual([0, 0, -50, -50])   // 拖出：后面的补位
    expect(slotOffset(rows, 0, 2)).toBe(100)
    expect(slotOffset(rows, 3, 1)).toBe(-100)
    expect(slotOffset(rows, 1, 1)).toBe(0)
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
  })

  it('播报文案', () => {
    expect(say.picked('日程提醒')).toBe('已拿起「日程提醒」。拖到底部工具箱松手即可加入，按 Esc 取消。')
    expect(say.overOk()).toBe('在工具箱上方，松手加入。')
    expect(say.overReject('需要管理员配置')).toBe('不能加入：需要管理员配置。')
    expect(say.added('查天气', 7)).toBe('已加入「查天气」，工具箱共 7 个。')
    expect(say.addedMany(3, 7)).toBe('已加入 3 个插件，工具箱共 7 个。')
    expect(say.rejected('高德地图', '需要管理员配置')).toBe('「高德地图」需要管理员配置，不能加入，已放回原处。')
    expect(say.rejected('查天气', '已在工具箱', 'same')).toBe('「查天气」已在工具箱，已放回原处。')
    expect(say.cancelled('日程提醒')).toBe('已取消，「日程提醒」放回原处。')
    expect(say.removed('随手记')).toBe('已移除「随手记」，5 秒内可以撤销。')
    expect(say.restored('随手记', 2)).toBe('已撤销，「随手记」回到第 2 位。')
    expect(say.moved('待办清单', 2)).toBe('「待办清单」移到第 2 位')
  })
})
