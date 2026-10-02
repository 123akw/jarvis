// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cnNumber, formatWhen, parseQuickAdd } from './quickAdd.js'

const NOW = new Date(2026, 9, 2, 10, 0)   // 2026-10-02 周五 10:00
const at = (text, now = NOW) => parseQuickAdd(text, now)

function expectSchedule(text, when, title, now = NOW) {
  const r = at(text, now)
  expect(r, text).toMatchObject({ kind: 'schedule', when, title })
  return r
}
function expectTodo(text, now = NOW) {
  expect(at(text, now), text).toEqual({ kind: 'todo', title: text })
}

describe('速记解析：提案验收表（now = 10/02 周五 10:00）', () => {
  it.each([
    ['明天下午3点 项目复盘', '2026-10-03 15:00', '项目复盘'],
    ['3点开会', '2026-10-02 15:00', '开会'],
    ['9点 晨跑', '2026-10-03 09:00', '晨跑'],                       // 今天 9 点已过 → 明天
    ['下周一 10:30 面试', '2026-10-05 10:30', '面试'],
    ['周三交电费', '2026-10-07 09:00', '交电费'],                   // 只有日期 → 09:00
    ['周五 6点 聚餐', '2026-10-02 18:00', '聚餐'],
    ['10月8号 交周报', '2026-10-08 09:00', '交周报'],
    ['提醒我晚上8点半给妈妈打电话', '2026-10-02 20:30', '给妈妈打电话'],
    ['明早7点一刻 出发', '2026-10-03 07:15', '出发'],
    ['后天 14:00 牙医', '2026-10-04 14:00', '牙医'],
    ['凌晨2点 看比赛', '2026-10-03 02:00', '看比赛'],
    ['两点 打电话', '2026-10-02 14:00', '打电话'],
  ])('%s → %s「%s」', (text, when, title) => {
    expectSchedule(text, when, title)
  })

  it('今天 + 已过 09:00 的纯日期按待办（原文不动）', () => expectTodo('今天 交电费'))
  it('没有时间词就是待办', () => expectTodo('整理会议材料'))
  it('数字后面不是「点」不算时间', () => expectTodo('买 3 本书'))
})

describe('速记解析：任务书里的三个例句', () => {
  it('明天下午3点 复盘', () => {
    const r = expectSchedule('明天下午3点 复盘', '2026-10-03 15:00', '复盘')
    expect(r.label).toBe('10月3日 周六 15:00')
    expect(r.rel).toBe('明天')
  })
  it('周五 交周报：周三写是本周五 09:00；周五上午写（09:00 已过）照旧是待办', () => {
    expectSchedule('周五 交周报', '2026-10-02 09:00', '交周报', new Date(2026, 8, 30, 10, 0))
    expectTodo('周五 交周报')
  })
  it('10月8日 9:30 体检', () => {
    expectSchedule('10月8日 9:30 体检', '2026-10-08 09:30', '体检')
  })
})

describe('速记解析：今天 / 明天 / 后天 / 周X / 下周X', () => {
  it('今晚、明晚、今早只写时段时取该时段的默认钟点', () => {
    expectSchedule('今晚 看电影', '2026-10-02 20:00', '看电影')
    expectSchedule('明晚 聚餐', '2026-10-03 20:00', '聚餐')
    expectSchedule('明天中午 饭局', '2026-10-03 12:00', '饭局')
  })
  it('大后天、星期X、礼拜X、周日', () => {
    expectSchedule('大后天 体检', '2026-10-05 09:00', '体检')
    expectSchedule('星期二下午4点 评审', '2026-10-06 16:00', '评审')
    expectSchedule('礼拜天 爬山', '2026-10-04 09:00', '爬山')
  })
  it('今天就是周五：周五 9 点已过取下周五，这周一已过标 past', () => {
    expectSchedule('周五 9点 晨会', '2026-10-09 09:00', '晨会')
    const r = expectSchedule('这周一 开会', '2026-09-28 09:00', '开会')
    expect(r.past).toBe(true)
  })
  it('下周X、下下周X 按自然周（周一为一周之始）', () => {
    expectSchedule('下周五 6点 聚餐', '2026-10-09 18:00', '聚餐')
    expectSchedule('下下周三 交方案', '2026-10-14 09:00', '交方案')
    // 周日写「下周一」= 明天
    expectSchedule('下周一 例会', '2026-10-05 09:00', '例会', new Date(2026, 9, 4, 20, 0))
  })
})

describe('速记解析：上午 / 下午 / 晚上 / 中午 与各种钟点写法', () => {
  it.each([
    ['中午12点 午饭', '2026-10-02 12:00', '午饭'],
    ['中午1点 午休', '2026-10-02 13:00', '午休'],
    ['上午11点 对稿', '2026-10-02 11:00', '对稿'],
    ['下午3:30 评审', '2026-10-02 15:30', '评审'],
    ['晚上9点 健身', '2026-10-02 21:00', '健身'],
    ['十点半 站会', '2026-10-02 10:30', '站会'],
    ['十一点 开会', '2026-10-02 11:00', '开会'],
    ['3点15 开会', '2026-10-02 15:15', '开会'],
    ['三点二十分 电话会', '2026-10-02 15:20', '电话会'],
    ['下午四点三刻 接孩子', '2026-10-02 16:45', '接孩子'],
    ['16:00 发版', '2026-10-02 16:00', '发版'],
    ['明天下午3点的会', '2026-10-03 15:00', '会'],
  ])('%s → %s「%s」', (text, when, title) => {
    expectSchedule(text, when, title)
  })

  it('晚上 12 点是次日 0 点', () => {
    const r = expectSchedule('晚上12点 抢票', '2026-10-03 00:00', '抢票')
    expect(r.rel).toBe('明天')
  })
  it('时间段只取开始时刻，结束时刻不进标题', () => {
    expectSchedule('明天 9:30-10:30 周会', '2026-10-03 09:30', '周会')
  })
  it('没写时段时的推断写进 assumed', () => {
    expect(at('3点开会').assumed).toBe('pm')
    expect(at('9点 晨跑').assumed).toBe('am')
    expect(at('下午3点 开会').assumed).toBe(null)
  })
})

describe('速记解析：X月X日、跨月、跨年', () => {
  it('M/D、YYYY-MM-DD、YYYY年M月D日、中文月日', () => {
    expectSchedule('10/8 体检', '2026-10-08 09:00', '体检')
    expectSchedule('2026-10-20 交房租', '2026-10-20 09:00', '交房租')
    expectSchedule('2027年3月1日 续费', '2027-03-01 09:00', '续费')
    expectSchedule('十月二十日 交房租', '2026-10-20 09:00', '交房租')
  })
  it('X号：本月已过取下月', () => {
    expectSchedule('1号 交房租', '2026-11-01 09:00', '交房租')
    expectSchedule('31号 对账', '2026-10-31 09:00', '对账')
  })
  it('X月X日已过取次年', () => {
    expectSchedule('1月3日 年会', '2027-01-03 09:00', '年会')
    expectSchedule('12月31日 跨年', '2026-12-31 09:00', '跨年')
  })
  it('年末：明天、下周一、3号都滚到下一年', () => {
    const eve = new Date(2026, 11, 31, 20, 0)   // 周四
    const r = expectSchedule('明天10点 拜年', '2027-01-01 10:00', '拜年', eve)
    expect(r.label).toBe('2027年1月1日 周五 10:00')
    expectSchedule('下周一 开工', '2027-01-04 09:00', '开工', eve)
    expectSchedule('3号 交房租', '2027-01-03 09:00', '交房租', eve)
  })
  it('月末：明天跨到下个月', () => {
    expectSchedule('明天 交月报', '2026-11-01 09:00', '交月报', new Date(2026, 9, 31, 18, 0))
  })
})

describe('速记解析：歧义输入一律保守', () => {
  it('日期不存在、钟点越界 → 待办', () => {
    expectTodo('2月30日 体检')
    expectTodo('25点 开会')
  })
  it('「提3点建议」「这两点」「3号楼」不是时间', () => {
    expectTodo('提3点建议')
    expectTodo('把这两点写进方案')
    expectTodo('去3号楼开会')
    expectTodo('坐2号线回家')
  })
  it('「早一点」「快一点」「下午茶」不是时间', () => {
    expectTodo('早一点出发')
    expectTodo('写快一点')
    expectTodo('下午茶 聊天')
  })
  it('只写了时间没写事：empty，不提交', () => {
    expect(at('明天下午3点')).toMatchObject({ kind: 'empty', when: '2026-10-03 15:00' })
    expect(at('   ')).toEqual({ kind: 'empty' })
  })
  it('「明天前台」的「前」不被当成截止词吞掉', () => {
    expectSchedule('明天前台取快递', '2026-10-03 09:00', '前台取快递')
    expectSchedule('周四前 交周报', '2026-10-08 09:00', '交周报')
  })
  it('「一点」紧跟时段或日期时才算 1 点', () => {
    expectSchedule('下午一点 开会', '2026-10-02 13:00', '开会')
    expectSchedule('明天一点 开会', '2026-10-03 13:00', '开会')
  })
})

describe('辅助函数', () => {
  it('中文数字', () => {
    expect([cnNumber('十'), cnNumber('十一'), cnNumber('二十'), cnNumber('二十五'), cnNumber('两'), cnNumber('7')])
      .toEqual([10, 11, 20, 25, 2, 7])
    expect(cnNumber('二三')).toBeNaN()
  })
  it('跨年标签带年份', () => {
    expect(formatWhen(new Date(2027, 0, 3, 9, 0), NOW)).toBe('2027年1月3日 周日 09:00')
    expect(formatWhen(new Date(2026, 9, 3, 15, 0), NOW)).toBe('10月3日 周六 15:00')
  })
})
