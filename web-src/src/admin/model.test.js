import { describe, expect, it } from 'vitest'
import {
  alertKind, dayLong, dayShort, failRate, fmtCompact, fmtInt, fmtPct, fmtYuan, kindRows, meterTone,
  quotaLimit, quotaMode, quotaValue, rangeText, relTime, sortAccounts, UNLIMITED,
} from './model.js'

const NOW = new Date(2026, 9, 3, 15, 0, 0)   // 2026-10-03 周六 15:00（本地时间）

describe('admin/model 数字与时间', () => {
  it('数字、缩写、金额、百分比', () => {
    expect(fmtInt(12345.4)).toBe('12,345')
    expect(fmtCompact(9999)).toBe('9,999')
    expect(fmtCompact(12000)).toBe('1.2 万')
    expect(fmtCompact(10000)).toBe('1 万')
    expect(fmtCompact(3456789)).toBe('346 万')
    expect(fmtCompact(123456789)).toBe('1.23 亿')
    expect(fmtYuan(0)).toBe('¥0')
    expect(fmtYuan(0.004)).toBe('<¥0.01')
    expect(fmtYuan(12.3)).toBe('¥12.30')
    expect(fmtYuan(12345.6)).toBe('¥12,346')
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(0)).toBe('0%')
    expect(fmtPct(0.0423)).toBe('4.2%')
    expect(fmtPct(0.0004)).toBe('<0.1%')
    expect(failRate(0, 0)).toBeNull()
    expect(failRate(20, 3)).toBeCloseTo(0.15)
  })

  it('日期按本地解析：坐标轴短日期、提示框长日期、范围副标题', () => {
    expect(dayShort('2026-10-03', NOW)).toBe('今天')
    expect(dayShort('2026-09-28', NOW)).toBe('9/28')
    expect(dayLong('2026-10-02', NOW)).toBe('10月2日 周五')
    expect(dayLong('2026-10-03', NOW)).toBe('10月3日 周六（今天）')
    expect(rangeText(1, NOW)).toBe('今天 · 10月3日')
    expect(rangeText(7, NOW)).toBe('9月27日 – 10月3日')
  })

  it('相对时间', () => {
    const ago = s => new Date(NOW.getTime() - s * 1000).toISOString()
    expect(relTime(null, NOW)).toBe('还没用过')
    expect(relTime(ago(20), NOW)).toBe('刚刚')
    expect(relTime(ago(5 * 60), NOW)).toBe('5 分钟前')
    expect(relTime(ago(3 * 3600), NOW)).toBe('3 小时前')
    expect(relTime(new Date(2026, 9, 2, 9, 5).toISOString(), NOW)).toBe('昨天 09:05')
    expect(relTime(ago(3 * 86400), NOW)).toBe('3 天前')
    expect(relTime(new Date(2026, 7, 12).toISOString(), NOW)).toBe('8月12日')
    expect(relTime(new Date(2025, 7, 12).toISOString(), NOW)).toBe('2025年8月12日')
  })
})

describe('admin/model 类别、配额、排序、告警', () => {
  it('类别固定五类，认不出的并进「其他」，带占比', () => {
    const rows = kindRows([
      { kind: 'flow', label: '流程', calls: 30 }, { kind: 'chat', calls: 60, cost_yuan: 1 },
      { kind: 'mystery', calls: 6 }, { kind: 'other', calls: 4 },
    ])
    expect(rows.map(r => r.label)).toEqual(['对话', '流程', '一句话生成', '语音', '其他'])
    expect(rows.map(r => r.calls)).toEqual([60, 30, 0, 0, 10])
    expect(rows[0].share).toBeCloseTo(0.6)
    expect(kindRows([]).every(r => r.share === 0)).toBe(true)
  })

  it('配额模式：Owner 永远不限；逐项 sources 优先；否则看整体 source', () => {
    const owner = { role: 'Owner' }
    expect(quotaMode({ source: 'custom', daily_model_calls: 5 }, 'daily_model_calls', owner)).toBe('unlimited')
    expect(quotaMode({ source: 'default', daily_model_calls: 300 }, 'daily_model_calls')).toBe('default')
    expect(quotaMode({ source: 'custom', daily_model_calls: 50 }, 'daily_model_calls')).toBe('custom')
    expect(quotaMode({ source: 'custom', daily_model_calls: null }, 'daily_model_calls')).toBe('default')
    expect(quotaMode({ source: 'custom', daily_model_calls: -1 }, 'daily_model_calls')).toBe('unlimited')
    expect(quotaMode({ source: 'unlimited' }, 'daily_flow_runs')).toBe('unlimited')
    const mixed = { source: 'custom', daily_model_calls: 50, daily_flow_runs: 100, sources: { daily_model_calls: 'custom', daily_flow_runs: 'default' } }
    expect(quotaMode(mixed, 'daily_flow_runs')).toBe('default')
  })

  it('上限：不限是 null；没给数字时用默认', () => {
    const defaults = { daily_model_calls: 300, daily_flow_runs: 100 }
    expect(quotaLimit({ source: 'custom', daily_model_calls: 50 }, 'daily_model_calls', null, defaults)).toBe(50)
    expect(quotaLimit({ source: 'default', daily_model_calls: null }, 'daily_model_calls', null, defaults)).toBe(300)
    expect(quotaLimit({ source: 'unlimited' }, 'daily_model_calls', null, defaults)).toBeNull()
    expect(quotaLimit({}, 'daily_flow_runs', { role: 'Owner' }, defaults)).toBeNull()
  })

  it('弹层选择 → PUT 的值', () => {
    expect(quotaValue({ mode: 'unlimited' })).toBe(UNLIMITED)
    expect(quotaValue({ mode: 'default', value: '12' })).toBeNull()
    expect(quotaValue({ mode: 'custom', value: ' 120 ' })).toBe(120)
    expect(quotaValue({ mode: 'custom', value: '0' })).toBeUndefined()
    expect(quotaValue({ mode: 'custom', value: '1.5' })).toBeUndefined()
    expect(quotaValue({ mode: 'custom', value: '200000' })).toBeUndefined()
    expect(quotaValue({ mode: 'custom', value: '' })).toBeUndefined()
  })

  it('进度条语气', () => {
    expect(meterTone(5, null)).toBe('free')
    expect(meterTone(10, 100)).toBe('ok')
    expect(meterTone(85, 100)).toBe('warn')
    expect(meterTone(100, 100)).toBe('full')
  })

  it('账号搜索（账号名或智能体名）与排序', () => {
    const A = [
      { username: 'amy', platform: { name: '花店助理' }, calls: 10, tokens: 1, cost_yuan: 5, flow_runs: 3, flow_failures: 0, last_active_at: '2026-10-01T00:00:00Z' },
      { username: 'bob', platform: null, calls: 50, tokens: 1, cost_yuan: 1, flow_runs: 9, flow_failures: 4, last_active_at: null },
      { username: 'cat', platform: null, calls: 50, tokens: 9, cost_yuan: 9, flow_runs: 1, flow_failures: 1, last_active_at: '2026-10-03T00:00:00Z' },
    ]
    expect(sortAccounts(A, { sort: 'usage' }).map(a => a.username)).toEqual(['cat', 'bob', 'amy'])
    expect(sortAccounts(A, { sort: 'cost' }).map(a => a.username)).toEqual(['cat', 'amy', 'bob'])
    expect(sortAccounts(A, { sort: 'failures' }).map(a => a.username)).toEqual(['bob', 'cat', 'amy'])
    expect(sortAccounts(A, { sort: 'recent' }).map(a => a.username)).toEqual(['cat', 'amy', 'bob'])
    expect(sortAccounts(A, { query: '花店' }).map(a => a.username)).toEqual(['amy'])
    expect(sortAccounts(A, { query: 'BO' }).map(a => a.username)).toEqual(['bob'])
  })

  it('告警类别', () => {
    expect(alertKind('schedule_paused').label).toBe('定时流程')
    expect(alertKind('channel_down').icon).toBe('bubble')
    expect(alertKind('quota_exhausted').label).toBe('配额')
    expect(alertKind('flow_failures').label).toBe('流程失败')
    expect(alertKind('').label).toBe('提醒')
  })
})
