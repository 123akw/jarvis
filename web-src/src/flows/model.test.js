import { describe, expect, it } from 'vitest'
import {
  abortRun, applyEvent, cancelRun, fmtMs, groupByRole, inputLabel, insertIndex, insertStep, linkState, makeStep, MAX_STEPS,
  moveStep, optionSummary, pickBlocker, removeStep, runBlockers, startRun, stepPlugins, templateGroups, unavailableReason, validate,
} from './model.js'

const P = (id, role, extra = {}) => ({ id, name: id, icon: '·', kind: 'step', available: true, step: { role, options: [] }, ...extra })
const catalog = {
  plugins: [
    P('input_text', 'input'),
    P('ai_extract', 'process', { name: 'AI 提炼', step: { role: 'process', options: [
      { key: 'task', label: '提炼什么', type: 'select', default: '要点', choices: ['要点', '待办'] },
      { key: 'instruction', label: '补充要求', type: 'text' },
    ] } }),
    P('web_page', 'output', { name: '生成网页与二维码' }),
    P('feishu_send', 'output', { name: '发到飞书', available: false, requires: ['feishu_bound'] }),
    { id: 'schedule', name: '日程', kind: 'tool', step: null },
    { id: 'search', name: '联网搜索', kind: 'tool', step: { role: 'process', options: [] } },
  ],
  professions: [
    { id: 'teacher', name: '老师', flows: [{ id: 't1', name: '课件', steps: [] }] },
    { id: 'pm', name: '项目经理', flows: [{ id: 'p1', name: '归档', steps: [] }] },
    { id: 'none', name: '空', flows: [] },
  ],
}
const { list, byId } = stepPlugins(catalog)
const st = (plugin, id = plugin) => ({ id, plugin, options: {} })

describe('积木清单', () => {
  it('只要 kind=step 的积木（对话技能带了 step 也不算），按角色分组、不可用的排后面', () => {
    expect(list.map(p => p.id)).toEqual(['input_text', 'ai_extract', 'web_page', 'feishu_send'])
    const groups = groupByRole(list)
    expect(groups.map(g => g.label)).toEqual(['输入', '处理', '输出'])
    expect(groups[2].items.map(p => p.id)).toEqual(['web_page', 'feishu_send'])
  })
  it('不可用的说明原因', () => {
    expect(unavailableReason(byId.feishu_send)).toMatch('绑定飞书')
    expect(unavailableReason(byId.web_page)).toBe('')
  })
  it('面板里加不了的积木：不可用 / 已有输入 / 已有结果网页；输入总是放第一步', () => {
    const has = [st('input_text'), st('web_page')]
    expect(pickBlocker(byId.feishu_send, [], byId)).toMatch('绑定飞书')
    expect(pickBlocker(byId.input_text, has, byId)).toBe('已经有输入了，一个流程只要一个输入')
    expect(pickBlocker(byId.web_page, has, byId)).toBe('一个流程只要一个结果网页')
    expect(pickBlocker(byId.ai_extract, has, byId)).toBe('')
    expect(insertIndex(byId.input_text, 3)).toBe(0)
    expect(insertIndex(byId.ai_extract, 3)).toBe(3)
  })
  it('模板：当前职业排前面，没有模板的职业不列', () => {
    expect(templateGroups(catalog, 'pm').map(g => [g.id, !!g.mine])).toEqual([['pm', true], ['teacher', false]])
    expect(templateGroups(catalog, null).map(g => g.id)).toEqual(['teacher', 'pm'])
  })
  it('新步骤带默认配置，摘要显示选项名', () => {
    const s = makeStep(byId.ai_extract)
    expect(s.options).toEqual({ task: '要点' })
    expect(optionSummary({ ...s, options: { task: '待办', instruction: '只要本周的事情，按负责人分组排好' } }, byId.ai_extract))
      .toBe('待办 · 只要本周的事情，按负责人分组…')
    expect(optionSummary(st('web_page'), { ...byId.web_page, summary: '扫码就能看' })).toBe('扫码就能看')
  })
})

describe('增删移动', () => {
  const a = st('input_text', 'a'); const b = st('ai_extract', 'b'); const c = st('web_page', 'c')
  it('插入 / 删除 / 上下移动，越界不动', () => {
    expect(insertStep([a, c], 1, b).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(removeStep([a, b, c], 'b').map(s => s.id)).toEqual(['a', 'c'])
    expect(moveStep([a, b, c], 'c', -1).map(s => s.id)).toEqual(['a', 'c', 'b'])
    expect(moveStep([a, b, c], 'a', -1).map(s => s.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('校验说人话', () => {
  it('空流程、第一步不是输入、输入不在第一步、没有输出、两个结果网页、超过 8 步', () => {
    expect(validate('x', [], byId)).toEqual(['先加一个积木，从「输入」开始'])
    expect(validate('x', [st('ai_extract'), st('web_page')], byId)).toContain('第一步要是输入，比如「文字输入」或「资料上传」')
    expect(validate('x', [st('input_text'), st('ai_extract')], byId)).toContain('还差一个输出，比如「生成网页与二维码」')
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => st(i === 0 ? 'input_text' : 'web_page', `s${i}`))
    expect(validate('x', many, byId)).toContain('最多 8 步，先删掉 1 步')
    expect(validate('x', [st('input_text', 'a'), st('input_text', 'b'), st('web_page')], byId)).toEqual(['输入只能放在第一步'])
    expect(validate('x', [st('input_text'), st('web_page', 'a'), st('web_page', 'b')], byId)).toEqual(['「生成网页与二维码」一个流程只要一个'])
    expect(validate(' ', [st('input_text'), st('web_page')], byId)).toEqual([])   // 名字空着服务端会起名
  })
  it('不可用的积木能保存但跑不了；已下架的不能保存', () => {
    expect(validate('x', [st('input_text'), st('feishu_send')], byId)).toEqual([])
    expect(runBlockers([st('input_text'), st('feishu_send')], byId)).toEqual(['「发到飞书」现在用不了：先在设置里绑定飞书才能用'])
    expect(validate('x', [st('input_text'), st('gone'), st('web_page')], byId)).toContain('有个积木已经下架了，删掉它再保存')
  })
  it('耗时与输入说明', () => {
    expect(fmtMs(820)).toBe('820 毫秒')
    expect(fmtMs(1234)).toBe('1.2 秒')
    expect(fmtMs(65000)).toBe('1 分 5 秒')
    expect(fmtMs(undefined)).toBe('')
    expect(inputLabel({ kind: 'file', name: '周报.pdf', bytes: 3 })).toBe('周报.pdf')
    expect(inputLabel({ kind: 'text', chars: 120 })).toBe('120 字')
  })
})

describe('运行事件 → 节点状态', () => {
  const steps = [st('input_text', 'a'), st('ai_extract', 'b'), st('web_page', 'c')]
  it('逐步亮起，连线随之流动 / 点亮', () => {
    let r = startRun(steps)
    expect(Object.values(r.nodes).map(n => n.state)).toEqual(['pending', 'pending', 'pending'])
    r = applyEvent(r, { type: 'run_start', run_id: 'r1' })
    r = applyEvent(r, { type: 'step_start', step_id: 'a' })
    expect(r.nodes.a.state).toBe('running')
    r = applyEvent(r, { type: 'step_done', step_id: 'a', summary: '读入 300 字', preview: '…' })
    expect(r.nodes.a).toMatchObject({ state: 'done', summary: '读入 300 字' })
    expect(linkState(r, 0)).toBe('flowing')
    r = applyEvent(r, { type: 'step_start', step_id: 'b' })
    expect(linkState(r, 0)).toBe('flowing')
    r = applyEvent(r, { type: 'step_done', step_id: 'b', summary: '6 条' })
    expect(linkState(r, 0)).toBe('lit')
    r = applyEvent(r, { type: 'step_start', step_id: 'c' })
    r = applyEvent(r, { type: 'step_done', step_id: 'c' })
    r = applyEvent(r, { type: 'run_done', status: 'ok', output: { url: '/r/x', title: 'T' } })
    expect(r).toMatchObject({ status: 'ok', runId: 'r1', output: { url: '/r/x' } })
    expect(linkState(r, 1)).toBe('lit')
  })
  it('step_id 对不上时按先后顺序落到节点', () => {
    let r = startRun(steps)
    r = applyEvent(r, { type: 'step_start', step_id: 'srv-1' })
    r = applyEvent(r, { type: 'step_done', step_id: 'srv-1', summary: 'ok' })
    r = applyEvent(r, { type: 'step_start', step_id: 'srv-2' })
    expect([r.nodes.a.state, r.nodes.b.state]).toEqual(['done', 'running'])
  })
  it('中途失败：失败节点标红，后面的不再运行', () => {
    let r = startRun(steps)
    r = applyEvent(r, { type: 'step_start', step_id: 'a' })
    r = applyEvent(r, { type: 'step_done', step_id: 'a' })
    r = applyEvent(r, { type: 'step_start', step_id: 'b' })
    r = applyEvent(r, { type: 'step_error', step_id: 'b', message: '模型没响应' })
    expect(r.status).toBe('error')
    expect(r.nodes.b).toMatchObject({ state: 'error', message: '模型没响应' })
    expect(r.nodes.c.state).toBe('skipped')
    r = applyEvent(r, { type: 'run_done', status: 'error', output: null })
    expect(r.error).toBe('模型没响应')
  })
  it('运行开始时就查出积木不可用：没有 step_start，直接 step_error', () => {
    let r = applyEvent(startRun(steps), { type: 'run_start', run_id: 'r2' })
    r = applyEvent(r, { type: 'step_error', step_id: 'c', message: '先绑定飞书', ms: 0 })
    r = applyEvent(r, { type: 'run_done', status: 'error', output: null })
    expect(Object.values(r.nodes).map(n => n.state)).toEqual(['skipped', 'skipped', 'error'])
    expect(r).toMatchObject({ status: 'error', error: '先绑定飞书' })
  })
  it('取消 / 断流', () => {
    let r = applyEvent(startRun(steps), { type: 'step_start', step_id: 'a' })
    expect(Object.values(cancelRun(r).nodes).map(n => n.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(abortRun(r, '连接断了')).toMatchObject({ status: 'error', error: '连接断了' })
    expect(cancelRun({ ...r, status: 'ok' }).status).toBe('ok')
  })
})
