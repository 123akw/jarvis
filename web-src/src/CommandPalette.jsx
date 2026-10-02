import { useEffect, useMemo, useRef, useState } from 'react'
import { searchHistory as defaultSearchHistory } from './api.js'
import Icon from './Icon.jsx'
import { useDialogFocus, useEscape } from './Modal.jsx'
import { parseQuickAdd } from './quickAdd.js'
import './CommandPalette.css'

const HISTORY_MIN_CHARS = 2      // 一个字搜历史太泛，两个字起查
const HISTORY_DEBOUNCE_MS = 180
const HISTORY_LIMIT = 6

/** 「吩咐」组的直达项：能解析成日程就「加到日程」（写明 24 小时制时间），否则「加到待办」；
 *  只写了时间、没写要做什么时不给直达项（不能写半截日程）。 */
function directAdd(text, onAdd) {
  const plan = parseQuickAdd(text, new Date())
  if (plan.kind === 'schedule') {
    const [md, wk, hm] = plan.label.split(' ')
    return {
      key: 'a:add', group: '吩咐', icon: 'today', label: `加到日程：${plan.title}`,
      hint: `${plan.rel || md} ${wk} ${hm}${plan.past ? ' · 已过' : ''}`, run: () => onAdd(plan, text),
    }
  }
  if (plan.kind === 'todo') {
    return { key: 'a:add', group: '吩咐', icon: 'list', label: `加到待办：${plan.title}`, run: () => onAdd(plan, text) }
  }
  return null
}

function hitDate(at) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/** 片段 + 服务端给的高亮区间 → 文本与 <mark> 交替（区间越界、重叠时跳过，不拼出错位的字） */
function Marked({ text, marks }) {
  const out = []
  let at = 0
  for (const [a, b] of Array.isArray(marks) ? marks : []) {
    if (!(a >= at && b > a && b <= text.length)) continue
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={a}>{text.slice(a, b)}</mark>)
    at = b
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** ⌘K 命令面板：命令、会话跳转、直接吩咐与翻旧账。键盘 ↑↓ 选择、Enter 执行、Esc 关闭。
 *  commands: [{ id, label, hint?, icon, run }]；threads: [{ id, title }]
 *  输入了内容时：
 *    吩咐      「让贾维斯去办：…」（onAsk，发进对话）+ 能解析时「加到日程 / 加到待办」（onAdd(plan, text)，不走模型）
 *    历史对话  正文命中的旧消息（防抖检索、过期请求取消），回车跳到那个会话：onPickThread(id, { pos, q })
 *  没有命令或会话匹配时「吩咐」排第一；有匹配时匹配项在前，吩咐垫底（回车不会误发）。
 *  选中项按 key 记，历史结果异步到达时不会把光标挤到别的项上。 */
export default function CommandPalette({
  commands, threads = [], onPickThread, onAsk, onAdd, onClose, onExpired,
  searchHistory = defaultSearchHistory,
}) {
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState('')
  const [hits, setHits] = useState([])
  const listRef = useRef(null)
  const boxRef = useRef(null)
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  useEscape(onClose)
  useDialogFocus(boxRef)   // 焦点进搜索框；关闭后还给打开前的控件

  useEffect(() => {  // 翻旧账：停手 180ms 再查；输入一变就取消上一个请求。查询期间保留上一批结果，免得列表一闪一闪
    const q = query.trim()
    if (!searchHistory || [...q].length < HISTORY_MIN_CHARS) {
      setHits(h => (h.length ? [] : h))
      return undefined
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      searchHistory(q, HISTORY_LIMIT, ctrl.signal)
        .then(r => { if (!ctrl.signal.aborted) setHits(Array.isArray(r?.items) ? r.items : []) })
        .catch(e => { if (e?.message === '401') expiredRef.current?.() })   // 取消、离线：静默，保留上一批
    }, HISTORY_DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [query, searchHistory])

  const items = useMemo(() => {
    const text = query.trim()
    const q = text.toLowerCase()
    const hit = value => !q || String(value || '').toLowerCase().includes(q)
    const cmds = commands
      .filter(c => hit(c.label) || hit(c.hint) || hit(c.keywords))
      .map(c => ({ ...c, key: `c:${c.id}`, group: '操作' }))
    const convs = threads
      .filter(t => q && hit(t.title))
      .slice(0, 6)
      .map(t => ({ key: `t:${t.id}`, id: t.id, label: t.title, icon: 'bubble', group: '对话', run: () => onPickThread(t.id) }))
    if (!text) {   // 没输入时把最近的几条会话也列出来，方便直接跳
      const recent = threads.slice(0, 4).map(t => ({
        key: `t:${t.id}`, id: t.id, label: t.title, icon: 'bubble', group: '最近对话', run: () => onPickThread(t.id),
      }))
      return [...cmds, ...recent]
    }
    const ask = onAsk ? [{ key: 'a:ask', group: '吩咐', icon: 'sparkles', label: `让贾维斯去办：${text}`, run: () => onAsk(text) }] : []
    const add = onAdd && !cmds.length ? [directAdd(text, onAdd)].filter(Boolean) : []
    const history = hits.map(h => ({
      key: `h:${h.thread_id}:${h.pos}`, group: '历史对话', icon: 'bubble', hit: h,
      label: h.snippet, run: () => onPickThread(h.thread_id, { pos: h.pos, q: text }),
    }))
    return cmds.length || convs.length
      ? [...cmds, ...convs, ...history, ...ask, ...add]
      : [...ask, ...add, ...history]
  }, [query, commands, threads, hits, onPickThread, onAsk, onAdd])

  const found = items.findIndex(item => item.key === activeKey)
  const active = found >= 0 ? found : 0
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  function run(item) {
    if (!item) return
    onClose()
    item.run()
  }

  function move(step) {
    if (!items.length) return
    setActiveKey(items[(active + step + items.length) % items.length].key)
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && !e.isComposing && !e.nativeEvent?.isComposing) { e.preventDefault(); run(items[active]) }
  }

  let lastGroup = ''
  return (
    <div className="jv-palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="jv-palette" role="dialog" aria-modal="true" aria-label="命令面板" ref={boxRef} tabIndex={-1}>
        <div className="jv-palette-search">
          <Icon name="search" size={18} />
          <input data-autofocus value={query} onKeyDown={onKey}
            onChange={e => { setQuery(e.target.value); setActiveKey('') }}
            placeholder="搜索对话，或输入要做的事…" aria-label="搜索命令" role="combobox"
            aria-expanded="true" aria-controls="jv-palette-list" enterKeyHint="go"
            aria-activedescendant={items[active] ? `pal-${items[active].key}` : undefined} />
          <kbd>esc</kbd>
        </div>
        <ul className="jv-palette-list" id="jv-palette-list" role="listbox" aria-label="命令" ref={listRef}>
          {items.length === 0 && <li className="jv-palette-empty">没有匹配的命令或对话</li>}
          {items.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : ''
            lastGroup = item.group
            const cls = `jv-palette-item${i === active ? ' on' : ''}${item.danger ? ' danger' : ''}${item.hit ? ' is-hit' : ''}`
            return (
              <li key={item.key} role="presentation">
                {head ? <div className="jv-palette-group" role="presentation">{head}</div> : null}
                <div id={`pal-${item.key}`} role="option" aria-selected={i === active} className={cls}
                  onMouseMove={() => { if (i !== active) setActiveKey(item.key) }}
                  onClick={() => run(item)}>
                  <span className="pi-icon"><Icon name={item.icon} size={17} /></span>
                  {item.hit ? (
                    <span className="pi-body">
                      <span className="pi-snippet"><Marked text={item.hit.snippet || ''} marks={item.hit.marks} /></span>
                      <span className="pi-meta">
                        {[item.hit.title, hitDate(item.hit.at), item.hit.role === 'user' ? '你说' : '贾维斯说'].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  ) : <span className="pi-label">{item.label}</span>}
                  {item.hint ? <span className="pi-hint">{item.hint}</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
