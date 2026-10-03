import { useCallback, useId, useMemo } from 'react'
import Icon from '../../Icon.jsx'
import { MARKET_PATH } from '../../routes.js'
import {
  canConnect, choiceList, conditionHandles, FIELD_TYPES, handleLabel, MAX_FIELDS, MAX_TEXT, nodeById, nodeTitle,
  OPS, START_ID, topoOrder, UNARY_OPS, varLabel, varOptions,
} from '../graph.js'
import { itemOf, needsPlugin, unavailableReason } from './catalog.js'
import Glyph, { NodeIcon } from './glyphs.jsx'
import VarInput from './VarInput.jsx'

/* 右侧配置面板（手机上放进底部弹层）：标题改名、按类型的表单、问题提示、连线、删除。
 * 所有文字输入都能插变量（VarInput）。 */

function Field({ label, hint, required, children, htmlFor, id }) {
  return (
    <div className="fc-field">
      <label className="fc-field-label" htmlFor={htmlFor} id={id}>{label}{required ? <em>必填</em> : null}</label>
      {children}
      {hint ? <p className="fc-field-hint">{hint}</p> : null}
    </div>
  )
}

function Unavailable({ item, what = '插件' }) {
  const why = unavailableReason(item)
  if (!why) return null
  return (
    <div className="fc-cfg-warn" role="note">
      <Glyph name="warn" size={15} />
      <p>{why}{needsPlugin(item) ? <> <a href={MARKET_PATH} target="_blank" rel="noopener noreferrer">去加{what}</a></> : null}</p>
    </div>
  )
}

/* ---------- 开始：输入项 ---------- */

const KEY_BASE = { text: 'text', paragraph: 'text', file: 'file', number: 'number', select: 'choice' }
export function newFieldKey(fields, type) {
  const base = KEY_BASE[type] || 'field'
  const used = new Set(fields.map(f => f.key))
  if (!used.has(base)) return base
  for (let i = 2; i < 100; i += 1) if (!used.has(`${base}${i}`)) return `${base}${i}`
  return `f${Date.now() % 100000}`
}

function StartForm({ node, patch, locked }) {
  const fields = Array.isArray(node.data.fields) ? node.data.fields : []
  const uid = useId()
  const set = (i, p) => patch(d => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) }), `${node.id}.f${i}`)
  const move = (i, dir) => patch(d => {
    const next = d.fields.slice()
    const j = i + dir
    if (j < 0 || j >= next.length) return d
    ;[next[i], next[j]] = [next[j], next[i]]
    return { ...d, fields: next }
  })
  return (
    <div className="fc-cfg-sec">
      <h4 className="fc-cfg-h">运行时要填的内容</h4>
      <p className="fc-field-hint">运行时会按这里生成表单；后面的节点用「变量」引用填进来的内容。</p>
      <ol className="fc-fields">
        {fields.map((f, i) => (
          <li key={f.key} className="fc-fieldcard">
            <div className="fc-row">
              <input className="fc-input" value={f.label || ''} maxLength={20} placeholder="比如：会议记录" disabled={locked}
                aria-label={`第 ${i + 1} 个输入项的名字`} onChange={e => set(i, { label: e.target.value })} />
              <select className="fc-select fc-select--sm" value={f.type || 'text'} disabled={locked} aria-label={`第 ${i + 1} 个输入项的类型`}
                onChange={e => set(i, { type: e.target.value })}>
                {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            {f.type === 'select' ? (
              <textarea className="fc-input fc-textarea" rows={3} disabled={locked} aria-label={`「${f.label || `第 ${i + 1} 个输入项`}」的选项，每行一个`}
                placeholder={'每行一个选项，比如：\n日报\n周报'} value={(f.options || []).join('\n')}
                onChange={e => set(i, { options: e.target.value.split('\n').map(s => s.slice(0, 30)).slice(0, 20) })} />
            ) : f.type === 'file' ? (
              <p className="fc-field-hint">运行时上传一个文件（10MB 以内）；后面的节点拿到的是文件里的文字。</p>
            ) : (
              <input className="fc-input" value={f.placeholder || ''} maxLength={40} disabled={locked} placeholder="输入框里的提示（可不填）"
                aria-label={`「${f.label || `第 ${i + 1} 个输入项`}」的提示语`} onChange={e => set(i, { placeholder: e.target.value })} />
            )}
            <div className="fc-row fc-row--end">
              <label className="fc-check">
                <input type="checkbox" checked={!!f.required} disabled={locked} onChange={e => set(i, { required: e.target.checked })} />必填
              </label>
              <span className="fc-grow" />
              <button type="button" className="jv-icon-btn fc-mini" disabled={locked || i === 0} onClick={() => move(i, -1)} aria-label={`把「${f.label || '这一项'}」往上挪`}>
                <Glyph name="up" size={15} />
              </button>
              <button type="button" className="jv-icon-btn fc-mini" disabled={locked || i === fields.length - 1} onClick={() => move(i, 1)} aria-label={`把「${f.label || '这一项'}」往下挪`}>
                <Glyph name="down" size={15} />
              </button>
              <button type="button" className="jv-icon-btn fc-mini" disabled={locked} aria-label={`删掉输入项「${f.label || `第 ${i + 1} 个`}」`}
                onClick={() => patch(d => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))}>
                <Icon name="trash" size={15} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      {!fields.length ? <p className="fc-field-hint" id={`${uid}-none`}>还没有输入项：运行时不用填东西，适合定时跑的流程。</p> : null}
      <button type="button" className="jv-btn jv-btn--sm fc-add" disabled={locked || fields.length >= MAX_FIELDS}
        onClick={() => patch(d => {
          const list = Array.isArray(d.fields) ? d.fields : []
          return { ...d, fields: [...list, { key: newFieldKey(list, 'text'), label: '', type: 'text', required: false }] }
        })}>
        <Icon name="plus" size={14} />加一个输入项{fields.length >= MAX_FIELDS ? `（最多 ${MAX_FIELDS} 个）` : ''}
      </button>
    </div>
  )
}

/* ---------- 积木选项（沿用 step_catalog 的选项声明） ---------- */

function OptionField({ opt, value, disabled, onChange }) {
  const label = opt.label || '设置'
  const id = useId()
  if (opt.type === 'select') {
    return (
      <Field label={label} htmlFor={id}>
        <select id={id} className="fc-select" value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
          {choiceList(opt).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Field>
    )
  }
  if (opt.type === 'number') {
    return (
      <Field label={label} htmlFor={id}>
        <input id={id} className="fc-input" type="number" inputMode="numeric" value={value ?? ''} min={opt.min} max={opt.max} disabled={disabled}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      </Field>
    )
  }
  return (
    <Field label={label} htmlFor={id}>
      <input id={id} className="fc-input" value={value ?? ''} maxLength={opt.max_length || 200} disabled={disabled} placeholder={opt.placeholder || ''}
        onChange={e => onChange(e.target.value)} />
    </Field>
  )
}

/* ---------- 条件 ---------- */

function newCaseId(cases) {
  let max = 0
  for (const c of cases) { const m = /^c(\d+)$/.exec(c.id); if (m) max = Math.max(max, Number(m[1])) }
  return `c${max + 1}`
}

function ConditionForm({ node, patch, locked, groups, vi }) {
  const cases = Array.isArray(node.data.cases) ? node.data.cases : []
  const setCase = (i, fn, group) => patch(d => ({ ...d, cases: d.cases.map((c, j) => (j === i ? fn(c) : c)) }), group)
  const setRule = (i, k, p, group) => setCase(i, c => ({ ...c, rules: c.rules.map((r, j) => (j === k ? { ...r, ...p } : r)) }), group)
  const varChoices = groups.filter(g => g.type !== 'item')
  return (
    <div className="fc-cfg-sec">
      <h4 className="fc-cfg-h">分支</h4>
      <p className="fc-field-hint">从上往下看，第一个满足的分支往下走；都不满足时走「否则」。</p>
      <ol className="fc-cases-edit">
        {cases.map((c, i) => {
          const rules = Array.isArray(c.rules) ? c.rules : []
          const name = String(c.label || '').trim() || `分支 ${i + 1}`
          return (
            <li key={c.id} className="fc-casecard">
              <div className="fc-row">
                <span className="fc-case-if">{i === 0 ? '如果' : '否则如果'}</span>
                <input className="fc-input" value={c.label || ''} maxLength={16} placeholder={`分支 ${i + 1}`} disabled={locked}
                  aria-label={`第 ${i + 1} 个分支的名字`} onChange={e => setCase(i, x => ({ ...x, label: e.target.value }), `${node.id}.case${i}`)} />
                <button type="button" className="jv-icon-btn fc-mini" disabled={locked || cases.length <= 1} aria-label={`删掉分支「${name}」`}
                  onClick={() => patch(d => ({ ...d, cases: d.cases.filter((_, j) => j !== i) }))}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
              {rules.length > 1 ? (
                <div className="fc-seg" role="radiogroup" aria-label={`「${name}」的条件怎么算`}>
                  {[['and', '全部满足'], ['or', '满足一条就行']].map(([v, l]) => (
                    <button key={v} type="button" role="radio" aria-checked={(c.logic || 'and') === v} disabled={locked}
                      className={(c.logic || 'and') === v ? 'is-on' : ''} onClick={() => setCase(i, x => ({ ...x, logic: v }))}>{l}</button>
                  ))}
                </div>
              ) : null}
              <ul className="fc-rules">
                {rules.map((r, k) => (
                  <li key={k} className="fc-rule">
                    <div className="fc-row">
                      <select className="fc-select" value={r.var || ''} disabled={locked} aria-label={`「${name}」第 ${k + 1} 条：比较什么`}
                        onChange={e => setRule(i, k, { var: e.target.value })}>
                        <option value="">选要比较的内容…</option>
                        {varChoices.map(g => (
                          <optgroup key={g.id} label={g.title}>
                            {g.vars.map(v => <option key={v.token} value={`${v.ref}.${v.field}`}>{v.label}</option>)}
                          </optgroup>
                        ))}
                        {r.var && !varChoices.some(g => g.vars.some(v => `${v.ref}.${v.field}` === r.var))
                          ? <option value={r.var}>{vi.labelOf(...r.var.split('.')).label}（不在前面了）</option> : null}
                      </select>
                      <button type="button" className="jv-icon-btn fc-mini" disabled={locked || rules.length <= 1} aria-label={`删掉「${name}」第 ${k + 1} 条条件`}
                        onClick={() => setCase(i, x => ({ ...x, rules: x.rules.filter((_, j) => j !== k) }))}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <div className="fc-row">
                      <select className="fc-select fc-select--op" value={r.op || 'contains'} disabled={locked} aria-label={`「${name}」第 ${k + 1} 条：怎么比`}
                        onChange={e => setRule(i, k, { op: e.target.value })}>
                        {OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {!UNARY_OPS.has(r.op) ? (
                        <div className="fc-grow">
                          <VarInput {...vi} multiline={false} value={r.value || ''} placeholder="比较的值" label={`「${name}」第 ${k + 1} 条：比较的值`}
                            onChange={v => setRule(i, k, { value: v }, `${node.id}.c${i}r${k}`)} />
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" className="fc-link" disabled={locked}
                onClick={() => setCase(i, x => ({ ...x, rules: [...(x.rules || []), { var: '', op: 'contains', value: '' }] }))}>
                <Icon name="plus" size={13} />加一条条件
              </button>
            </li>
          )
        })}
      </ol>
      <div className="fc-else"><span>否则</span>上面都不满足时走这里</div>
      <button type="button" className="jv-btn jv-btn--sm fc-add" disabled={locked || cases.length >= 8}
        onClick={() => patch(d => {
          const list = Array.isArray(d.cases) ? d.cases : []
          return { ...d, cases: [...list, { id: newCaseId(list), label: `分支 ${list.length + 1}`, logic: 'and', rules: [{ var: '', op: 'contains', value: '' }] }] }
        })}>
        <Icon name="plus" size={14} />加一个分支
      </button>
    </div>
  )
}

/* ---------- 连线 ---------- */

function Connections({ node, graph, locked, onConnect, onDisconnect, onSelectNode }) {
  const ins = graph.edges.filter(e => e.target === node.id)
  const handles = node.type === 'condition' ? conditionHandles(node) : node.type === 'end' ? [] : [null]
  const order = topoOrder(graph)
  const srcName = e => {
    const s = nodeById(graph, e.source)
    const h = handleLabel(s, e.sourceHandle)
    return h ? `${nodeTitle(s)} · ${h}` : nodeTitle(s)
  }
  return (
    <div className="fc-cfg-sec">
      <h4 className="fc-cfg-h">连线</h4>
      {node.id !== START_ID ? (
        <div className="fc-conn">
          <span className="fc-conn-k">前面接着</span>
          <ul className="fc-conn-list">
            {ins.map(e => (
              <li key={e.id} className="fc-conn-chip">
                <button type="button" className="fc-conn-go" onClick={() => onSelectNode(e.source)}>{srcName(e)}</button>
                <button type="button" className="fc-conn-x" disabled={locked} aria-label={`断开与「${srcName(e)}」的连线`} onClick={() => onDisconnect(e.id)}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
            {!ins.length ? <li className="fc-conn-none">还没连上</li> : null}
          </ul>
        </div>
      ) : null}
      {handles.map(h => {
        const outs = graph.edges.filter(e => e.source === node.id && (e.sourceHandle ?? null) === h)
        const options = order.filter(id => id !== node.id && !canConnect(graph, { source: node.id, target: id, sourceHandle: h }))
        const hl = handleLabel(node, h)
        return (
          <div key={h ?? '_'} className="fc-conn">
            <span className="fc-conn-k">{hl ? `「${hl}」后面接` : '后面接'}</span>
            <ul className="fc-conn-list">
              {outs.map(e => (
                <li key={e.id} className="fc-conn-chip">
                  <button type="button" className="fc-conn-go" onClick={() => onSelectNode(e.target)}>{nodeTitle(nodeById(graph, e.target))}</button>
                  <button type="button" className="fc-conn-x" disabled={locked} aria-label={`断开连到「${nodeTitle(nodeById(graph, e.target))}」的线`} onClick={() => onDisconnect(e.id)}>
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
              {options.length && !locked ? (
                <li>
                  <select className="fc-select fc-select--conn" value="" aria-label={hl ? `「${hl}」连到哪个节点` : '连到哪个节点'}
                    onChange={e => { if (e.target.value) onConnect({ source: node.id, target: e.target.value, sourceHandle: h }) }}>
                    <option value="">连到…</option>
                    {options.map(id => <option key={id} value={id}>{nodeTitle(nodeById(graph, id))}</option>)}
                  </select>
                </li>
              ) : null}
              {!outs.length && !options.length ? <li className="fc-conn-none">没有能连的节点</li> : null}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- 主体 ---------- */

export function ConfigBody({ node, graph, index, sys, issues = [], locked, onPatch, onDelete, onConnect, onDisconnect, onSelectNode }) {
  const item = itemOf(index, node)
  const labelOf = useCallback((ref, field) => varLabel(graph, ref, field, { sys }), [graph, sys])
  const groups = useMemo(() => varOptions(graph, node.id, { sys, itemOf: n => itemOf(index, n) }), [graph, node.id, sys, index])
  const vi = { groups, labelOf, disabled: locked }
  const d = node.data || {}
  const patch = (p, group) => onPatch(node.id, p, group)
  const g = key => `${node.id}.${key}`
  const ids = { prompt: useId(), out: useId() }

  let form = null
  if (node.type === 'start') form = <StartForm node={node} patch={patch} locked={locked} />
  else if (node.type === 'llm') {
    form = (
      <div className="fc-cfg-sec">
        {index.skills.length ? (
          <Field label="用一个技能（可不选）" htmlFor={`${ids.prompt}-skill`} hint={d.skill ? '技能会把它的说明书交给 AI，下面写这次具体要做的事。' : '技能是带说明书的 AI，比如写周报、改简历。'}>
            <select id={`${ids.prompt}-skill`} className="fc-select" value={d.skill || ''} disabled={locked}
              onChange={e => {
                const sk = index.skills.find(s => s.data.skill === e.target.value)
                patch(x => ({ ...x, skill: e.target.value || undefined, prompt: x.prompt || sk?.data?.prompt || '' }))
              }}>
              <option value="">不用技能</option>
              {index.skills.map(s => <option key={s.key} value={s.data.skill} disabled={s.available === false}>{s.title}{s.available === false ? '（用不了）' : ''}</option>)}
              {d.skill && !index.skills.some(s => s.data.skill === d.skill) ? <option value={d.skill}>已经不在的技能</option> : null}
            </select>
          </Field>
        ) : null}
        {item ? <Unavailable item={item} what="技能" /> : null}
        <Field label="要 AI 做什么" required htmlFor={ids.prompt}>
          <VarInput {...vi} id={ids.prompt} tour rows={6} value={d.prompt || ''} maxLength={MAX_TEXT} label="要 AI 做什么"
            placeholder="比如：把会议记录整理成三条要点，每条一句话。点「变量」插入前面节点的结果" onChange={v => patch({ prompt: v }, g('prompt'))} />
        </Field>
        <Field label="结果是" id={ids.out}>
          <div className="fc-seg" role="radiogroup" aria-labelledby={ids.out}>
            {[['text', '一段文字'], ['list', '一条条列表']].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={(d.output || 'text') === v} disabled={locked}
                className={(d.output || 'text') === v ? 'is-on' : ''} onClick={() => patch({ output: v })}>{l}</button>
            ))}
          </div>
        </Field>
      </div>
    )
  } else if (node.type === 'tool') {
    const args = item?.args || []
    form = (
      <div className="fc-cfg-sec">
        {item === null ? <div className="fc-cfg-warn" role="note"><Glyph name="warn" size={15} /><p>这个插件工具已经不在了，删掉换一个。</p></div> : null}
        {item ? <Unavailable item={item} /> : null}
        {item?.summary ? <p className="fc-field-hint">{item.plugin_name ? `来自「${item.plugin_name}」：` : ''}{item.summary}</p> : null}
        {args.map((a, i) => {
          const val = d.args?.[a.name] ?? ''
          const set = v => patch(x => ({ ...x, args: { ...(x.args || {}), [a.name]: v } }), g(`arg.${a.name}`))
          const fid = `${ids.prompt}-a${i}`
          return (
            <Field key={a.name} label={a.label || '参数'} required={a.required} hint={a.description} htmlFor={fid}>
              {Array.isArray(a.enum) && a.enum.length ? (
                <select id={fid} className="fc-select" value={val} disabled={locked} onChange={e => set(e.target.value)}>
                  <option value="">{a.required ? '请选择…' : '不选'}</option>
                  {a.enum.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                </select>
              ) : (
                <VarInput {...vi} id={fid} tour={i === 0} multiline={a.type === 'text'} rows={2} value={String(val)} label={a.label || '参数'}
                  placeholder={a.type === 'number' || a.type === 'integer' ? '填数字，或插入变量' : '直接填，或插入变量'} onChange={set} />
              )}
            </Field>
          )
        })}
        {item && !args.length ? <p className="fc-field-hint">这个工具不用填参数。</p> : null}
      </div>
    )
  } else if (node.type === 'condition') {
    form = <ConditionForm node={node} patch={patch} locked={locked} groups={groups} vi={vi} />
  } else if (node.type === 'template') {
    form = (
      <div className="fc-cfg-sec">
        <Field label="拼成什么样" required htmlFor={ids.prompt} hint="直接写字，需要前面结果的地方点「变量」插进去。">
          <VarInput {...vi} id={ids.prompt} tour rows={6} value={d.template || ''} maxLength={MAX_TEXT} label="拼成什么样"
            placeholder="比如：今天的天气：（插入变量）；今天的待办：（插入变量）" onChange={v => patch({ template: v }, g('template'))} />
        </Field>
      </div>
    )
  } else if (node.type === 'step') {
    form = (
      <div className="fc-cfg-sec">
        {item === null ? <div className="fc-cfg-warn" role="note"><Glyph name="warn" size={15} /><p>这个积木已经下架了，删掉换一个。</p></div> : null}
        {item ? <Unavailable item={item} what="插件" /> : null}
        {item?.summary ? <p className="fc-field-hint">{item.summary}</p> : null}
        {(item?.options || []).map(opt => (
          <OptionField key={opt.key} opt={opt} value={d.options?.[opt.key]} disabled={locked}
            onChange={v => patch(x => ({ ...x, options: { ...(x.options || {}), [opt.key]: v } }), g(`opt.${opt.key}`))} />
        ))}
        <Field label="交给它的内容" htmlFor={ids.prompt} hint="不填就用上一步的文字。">
          <VarInput {...vi} id={ids.prompt} tour rows={3} value={d.input || ''} maxLength={MAX_TEXT} label="交给它的内容"
            placeholder="不填就用上一步的文字" onChange={v => patch({ input: v }, g('input'))} />
        </Field>
      </div>
    )
  } else if (node.type === 'end') {
    form = (
      <div className="fc-cfg-sec">
        <Field label="最终结果" htmlFor={ids.prompt} hint="运行完显示给你的内容；不填就用上一步的文字。">
          <VarInput {...vi} id={ids.prompt} tour rows={5} value={d.output || ''} maxLength={MAX_TEXT} label="最终结果"
            placeholder="不填就用上一步的文字" onChange={v => patch({ output: v }, g('output'))} />
        </Field>
        <label className="fc-check fc-check--card">
          <input type="checkbox" checked={!!d.page} disabled={locked} onChange={e => patch({ page: e.target.checked })} />
          <span><b>生成结果网页</b><small>得到一个能分享的链接和二维码</small></span>
        </label>
      </div>
    )
  }

  return (
    <>
      {issues.length ? (
        <ul className="fc-cfg-issues" aria-label="这个节点还差这些">
          {issues.map(i => <li key={i.key} className={`is-${i.level}`}><Glyph name="warn" size={13} />{i.message}</li>)}
        </ul>
      ) : null}
      {form}
      <Connections node={node} graph={graph} locked={locked} onConnect={onConnect} onDisconnect={onDisconnect} onSelectNode={onSelectNode} />
      {node.id !== START_ID ? (
        <div className="fc-cfg-foot">
          <button type="button" className="jv-btn jv-btn--sm jv-btn--danger" disabled={locked} onClick={onDelete}>
            <Icon name="trash" size={14} />删除这个节点
          </button>
          <span className="fc-field-hint">删错了可以撤销（⌘Z）</span>
        </div>
      ) : null}
    </>
  )
}

/** 节点类型的人话：插件工具带插件名，技能节点叫「技能」 */
export function typeLabelOf(node, item) {
  if (node.type === 'tool') return item?.plugin_name ? `插件工具 · ${item.plugin_name}` : '插件工具'
  if (node.type === 'llm' && node.data?.skill) return '技能'
  if (node.type === 'step') return item?.role === 'output' ? '积木 · 输出' : '积木'
  return { start: '开始', llm: 'AI 处理', condition: '条件分支', template: '文本拼接', end: '结束' }[node.type] || '节点'
}

/** 桌面：右侧浮在画布上的面板 */
export default function ConfigPanel({ node, index, onPatch, onClose, locked, ...rest }) {
  const item = itemOf(index, node)
  const title = node.data?.title ?? ''
  return (
    <section className="fc-config" aria-label={`节点设置：${nodeTitle(node)}`} data-tour="flow-config">
      <header className="fc-config-head">
        <NodeIcon type={node.type} emoji={item?.icon || ''} size={18} />
        <div className="fc-config-titles">
          <input className="fc-config-title" value={title} maxLength={30} disabled={locked} aria-label="节点名称"
            placeholder={typeLabelOf(node, item)} onChange={e => onPatch(node.id, { title: e.target.value }, `${node.id}.title`)} />
          <small>{typeLabelOf(node, item)}</small>
        </div>
        <button type="button" className="jv-modal-close" onClick={onClose} aria-label="收起设置">
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="fc-config-body">
        <ConfigBody node={node} index={index} onPatch={onPatch} locked={locked} {...rest} />
      </div>
    </section>
  )
}

