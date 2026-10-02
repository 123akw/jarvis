import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import Icon from '../Icon.jsx'
import Modal, { ModalHead } from '../Modal.jsx'
import { useDndActions, useDockDrop, useSortableList } from './dnd/index.jsx'
import { say } from './dnd/engine.js'
import { KIND_LABEL, kindCounts } from './model.js'

/** 类型分布的一行字：「3 工具 · 1 技能 · 1 MCP」 */
export const mixText = plugins => kindCounts(plugins).map(k => `${k.n} ${k.label}`).join(' · ')

const UNDO_MS = 5000
const TIP_MS = 2600

/** 读屏播报：同一句话连说两次也会再读（换 key 重新挂载） */
function useNews() {
  const [news, setNews] = useState({ text: '', n: 0 })
  const announce = useCallback(text => setNews(v => ({ text, n: v.n + 1 })), [])
  const region = <p className="sr-only" aria-live="polite" aria-atomic="true"><span key={news.n}>{news.text}</span></p>
  return [announce, region]
}

const Grip = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" focusable="false">
    <g fill="currentColor"><circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" /><circle cx="2.5" cy="8" r="1.4" />
      <circle cx="7.5" cy="8" r="1.4" /><circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" /></g>
  </svg>
)

/** 「已移除『xx』· 撤销」：5 秒后自动消失；撤销按钮可以 Tab 到 */
function UndoBar({ undo, onUndo, className = '' }) {
  if (!undo) return null
  return (
    <div className={`jvd-undo ${className}`.trim()} key={undo.n}>
      <span>已移除「{undo.name}」</span>
      <button type="button" className="jvd-undo-btn" onClick={onUndo}>撤销</button>
    </div>
  )
}

/** 工具箱抽屉：已选插件可拖动排序（或上下按钮）、拖出 / 拖到删除区移除（或移除按钮）、点名字看详情；顶部是类型分布 */
function Drawer({ plugins, onClose, onMove, onClear, onOpen, action, reorder, remove, undo, onUndo, announce, region }) {
  const n = plugins.length
  const [sure, setSure] = useState(false)   // 「全部清空」点两次才生效
  const sort = useSortableList({
    items: plugins.map(p => ({ id: p.id, name: p.name, icon: p.icon, sub: KIND_LABEL[p.kind] || '' })),
    onReorder: (from, to, item) => { reorder(from, to); announce(say.moved(item.name, to + 1)) },
    onRemove: (id, from, item) => { remove(id, from); announce(say.removed(item.name)) },
  })
  const listRef = sort.listRef
  const focusRow = (id, pick) => requestAnimationFrame(() => {
    const row = listRef.current?.querySelector(`[data-id=${JSON.stringify(id)}]`)
    const el = row && pick(row)
    el?.focus()
  })
  // 移动后焦点跟着那一行的同一个按钮走（移到头 / 尾时换到还能按的那个）
  const move = (p, i, dir) => {
    onMove(p.id, dir)
    announce(say.moved(p.name, i + dir + 1))
    const key = dir < 0 ? 'up' : 'down'
    focusRow(p.id, row => row.querySelector(`[data-dir="${key}"]:not(:disabled)`) || row.querySelector('[data-dir]:not(:disabled)'))
  }
  // 移除后焦点落到下一行（没有就上一行）的移除按钮，不掉回页面开头
  const removeAt = (p, i) => {
    const next = plugins[i + 1] || plugins[i - 1]
    remove(p.id, i)
    announce(say.removed(p.name))
    if (next) focusRow(next.id, row => row.querySelector('.jvm-box-remove'))
  }
  const sorting = !!sort.active
  return (
    <Modal label="我的工具箱" size="sm" onClose={onClose} className="jvm-sheet jvm-box">
      <ModalHead title="我的工具箱" subtitle={n ? `已选 ${n} 个 · ${mixText(plugins)}` : '还没选插件'} onClose={onClose} />
      <div className="jv-modal-body">
        {region}
        {n ? (
          <>
            <p className="jvm-box-tip">生成时按这个顺序装进智能体；排在前面的，介绍自己时先说。按住一行拖动可以调整顺序，拖出抽屉就是移除。</p>
            <ol className={`jvm-box-list${sorting ? ' is-sorting' : ''}`} ref={listRef}>
              {plugins.map((p, i) => (
                <li key={p.id} data-id={p.id} {...sort.rowProps(p.id)}>
                  <span className="jvd-grip" aria-hidden="true" title="拖动排序" {...sort.handleProps(p.id)}><Grip /></span>
                  <span className="jvm-rec-icon" aria-hidden="true">{p.icon}</span>
                  <button type="button" className="jvm-box-name" onClick={() => onOpen(p.id)} aria-label={`查看详情：${p.name}`}>
                    <span>{p.name}</span><small>{KIND_LABEL[p.kind]}</small>
                  </button>
                  <span className="jvm-box-order" data-dnd-ignore="">
                    <button type="button" data-dir="up" onClick={() => move(p, i, -1)} disabled={i === 0} aria-label={`上移 ${p.name}`}>
                      <Icon name="up" size={15} />
                    </button>
                    <button type="button" data-dir="down" onClick={() => move(p, i, 1)} disabled={i === n - 1} aria-label={`下移 ${p.name}`}>
                      <Icon name="up" size={15} className="is-down" />
                    </button>
                  </span>
                  <button type="button" className="jvm-box-remove" data-dnd-ignore="" onClick={() => removeAt(p, i)} aria-label={`移除 ${p.name}`}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="jvm-none is-tight">
            <span className="jvm-none-icon" aria-hidden="true">🧰</span>
            <p className="jvm-none-title">工具箱还是空的</p>
            <p className="jvm-none-sub">在市场里点「+」，或者把插件卡片拖到底部的工具箱。</p>
            <button type="button" className="jvm-btn jvm-btn--block" data-autofocus onClick={onClose}>去挑插件</button>
          </div>
        )}
        <UndoBar undo={undo} onUndo={onUndo} className="is-inline" />
        {n ? (
          <div className={`jvd-box-foot${sorting ? ' is-sorting' : ''}`}>
            <div className="jvm-box-actions" aria-hidden={sorting || undefined}>
              <button type="button" className={`jvm-link${sure ? ' is-danger' : ''}`} onClick={() => (sure ? onClear() : setSure(true))}
                onBlur={() => setSure(false)}>
                {sure ? '再点一次，全部清空' : '全部清空'}
              </button>
              {action ? (
                <button type="button" className="jvm-btn" onClick={() => { onClose(); action.onClick() }} disabled={action.disabled}>{action.label}</button>
              ) : null}
            </div>
            {sorting ? (
              <div className="jvd-trash" ref={sort.trashRef} data-over={sort.active.removing ? '' : undefined} aria-hidden="true">
                <Icon name="trash" size={17} />
                <span>{sort.active.removing ? '松手移除' : '拖到这里移除'}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

const NARROW = '(max-width: 719px)'

/** 手机上往下滚时 Dock 收成小条（少挡内容），往上滚、滚到底或回到顶部时展开（Safari 工具栏的做法） */
function useDockMini() {
  const [mini, setMini] = useState(false)
  useEffect(() => {
    let mq = null
    try { mq = window.matchMedia?.(NARROW) } catch { mq = null }
    if (!mq) return undefined
    const last = new WeakMap()
    const onScroll = e => {
      const t = e.target === document ? document.scrollingElement : e.target
      if (!mq.matches) { setMini(false); return }
      if (!t || t.nodeType !== 1 || t.closest?.('[role="dialog"],.jvm-dock')) return
      const y = t.scrollTop
      if (!last.has(t)) { last.set(t, y); return }
      const prev = last.get(t)
      if (y === prev) return                 // 横向滚动（精选货架）不算
      const end = y + t.clientHeight >= t.scrollHeight - 80
      if (y < 24 || end) { last.set(t, y); setMini(false); return }
      if (Math.abs(y - prev) < 8) return     // 小抖动攒着，不来回切
      last.set(t, y)
      setMini(y > prev)
    }
    const onChange = () => { if (!mq.matches) setMini(false) }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    mq.addEventListener?.('change', onChange)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      mq.removeEventListener?.('change', onChange)
    }
  }, [])
  return [mini, setMini]
}

/** 拖动中 Dock 文字区的提示：拖到这里加入 / 松手加入 · 将有 N 个 / ⦸ 原因 */
function cueOf(dragging, isOver, n) {
  if (!dragging) return null
  const adding = dragging.ids.length
  if (dragging.tone === 'ok') {
    return {
      tone: 'ok',
      title: isOver ? `松手加入 · 将有 ${n + adding} 个` : '拖到这里加入',
      sub: dragging.kind === 'bundle' ? `「${dragging.label}」新加 ${adding} 个` : dragging.label,
    }
  }
  return { tone: dragging.tone, title: dragging.reason, sub: `「${dragging.label}」松手会放回原处` }
}

/** 底部常驻工具箱条（Dock）：已选数量 + 类型分布 + 小图标（点开抽屉）+ 当前步骤的主按钮；
 *  拖插件卡过来时进入接收态（越过时撑开空位 / 不能加入时给原因），点「+」时图标飞进来、计数跳一下。
 *  onReorder(from, to) / onAdd(ids, meta) 可选：没有包 DndRoot 时，排序退回用 onMove 一步步挪，撤销移除要有 onAdd。 */
export default function Toolbox({ plugins, onRemove, onMove, onReorder, onAdd, onClear, onOpen, action, hint }) {
  const [open, setOpen] = useState(false)
  const { dropProps, isOver, dragging, landing, tip } = useDockDrop()
  const dnd = useDndActions()
  const [mini, setMini] = useDockMini()
  const [announce, region] = useNews()              // Dock 上的播报（加入）
  const [tell, drawerRegion] = useNews()            // 抽屉里的播报（抽屉是模态框，读屏只读框内的）
  const [undo, setUndo] = useState(null)
  const [tipOn, setTipOn] = useState(null)
  const n = plugins.length
  const latest = useRef(plugins)
  latest.current = plugins
  const quiet = useRef(new Set())   // 撤销加回来的不再播「已加入」

  // 新加进来的插件播一句「已加入 X，工具箱共 N 个。」（拖入、点「+」、整套加入都走这里）
  const prevIds = useRef(null)
  useEffect(() => {
    const ids = plugins.map(p => p.id)
    const prev = prevIds.current
    prevIds.current = ids
    if (!prev) return
    const fresh = plugins.filter(p => !prev.includes(p.id) && !quiet.current.has(p.id))
    quiet.current.clear()
    if (fresh.length === 1) announce(say.added(fresh[0].name, ids.length))
    else if (fresh.length > 1) announce(say.addedMany(fresh.length, ids.length))
  }, [plugins, announce])

  // Dock 上方的短提示（拒绝原因 / 第一次的用法提示）：2.6 秒
  useEffect(() => {
    if (!tip) return undefined
    setTipOn(tip)
    const t = setTimeout(() => setTipOn(v => (v === tip ? null : v)), TIP_MS)
    return () => clearTimeout(t)
  }, [tip])
  useEffect(() => {
    if (!undo) return undefined
    const t = setTimeout(() => setUndo(v => (v === undo ? null : v)), UNDO_MS)
    return () => clearTimeout(t)
  }, [undo])

  // 排序 / 移除：优先 DndRoot 上的回调，其次 Toolbox 自己的；排序都没有就用上移 / 下移一步步挪
  const reorder = (from, to) => {
    const fn = dnd.reorder() || onReorder
    if (fn) return fn(from, to)
    const id = latest.current[from]?.id
    for (let k = 0; k < Math.abs(to - from); k++) onMove(id, to > from ? 1 : -1)
    return undefined
  }
  const addFn = dnd.add() || onAdd
  const remove = (id, index) => {
    const p = latest.current.find(x => x.id === id)
    ;(dnd.remove() || onRemove)(id)
    if (p && addFn) setUndo({ id, name: p.name, index, n: Date.now() })
  }
  // 撤销：加回去，再挪回原来的位置
  const restore = () => {
    const u = undo
    if (!u || !addFn) return
    setUndo(null)
    quiet.current.add(u.id)
    flushSync(() => addFn([u.id], { id: u.id, kind: 'plugin', restore: true, index: u.index }))
    const from = latest.current.findIndex(p => p.id === u.id)
    const to = Math.min(u.index, latest.current.length - 1)
    if (from >= 0 && from !== to) flushSync(() => reorder(from, to))
    const pos = latest.current.findIndex(p => p.id === u.id)
    ;(open ? tell : announce)(say.restored(u.name, (pos >= 0 ? pos : to) + 1))
  }

  const slot = (isOver && dragging?.tone === 'ok') || landing ? (dragging?.icon || landing?.icon || '') : null
  const cue = cueOf(dragging, isOver, n)
  const showTip = !dragging && tipOn
  return (
    <>
      <div className={`jvm-dock${dragging ? ' is-receiving' : ''}${mini && !dragging ? ' is-mini' : ''}`} role="region" aria-label="工具箱"
        onFocus={() => setMini(false)}>
        {region}
        <div className="jvm-dock-inner" {...dropProps}>
          <button type="button" className="jvm-tray" onClick={() => setOpen(true)} aria-haspopup="dialog"
            aria-label={n ? `工具箱：已选 ${n} 个插件，点开查看` : '工具箱：还没选插件'}>
            <span className={`jvm-tray-icons${n || slot !== null ? '' : ' is-empty'}`} aria-hidden="true" data-dock-target="" data-dock-bump="">
              {n ? plugins.slice(-4).map(p => <i key={p.id}>{p.icon}</i>) : slot !== null ? null : <i><Icon name="plus" size={14} /></i>}
              {slot !== null ? <i className={`jvd-slot${landing ? ' is-landing' : ''}`} data-dock-slot="">{landing ? '' : slot}</i> : null}
            </span>
            <span className="jvm-tray-text">
              {cue ? (
                <>
                  <span className="jvm-tray-count jvd-cue" data-tone={cue.tone} aria-hidden="true">
                    {cue.tone === 'ok' ? null : <b className="jvd-cue-mark">{cue.tone === 'same' ? '✓' : '⦸'}</b>}{cue.title}
                  </span>
                  <span className="jvm-tray-label" aria-hidden="true">{cue.sub}</span>
                </>
              ) : (
                <>
                  <span className="jvm-tray-count" data-dock-bump="">{n ? `已选 ${n} 个` : '工具箱是空的'}</span>
                  <span className="jvm-tray-label">{n ? mixText(plugins) : '挑几个插件放进来，或拖进来'}</span>
                </>
              )}
            </span>
          </button>
          {action ? (
            <button type="button" className="jvm-btn jvm-dock-go" onClick={action.onClick} disabled={action.disabled}>
              {action.label}{action.arrow ? <Icon name="chevron" size={16} /> : null}
            </button>
          ) : null}
        </div>
        {showTip ? (
          <p className="jvm-dock-hint jvd-tip" data-tone={tipOn.tone} aria-hidden="true" key={tipOn.n}>
            {tipOn.tone === 'deny' ? <b className="jvd-cue-mark">⦸</b> : null}{tipOn.text}
          </p>
        ) : hint ? <p className="jvm-dock-hint" role="status">{hint}</p> : null}
        {!open ? <UndoBar undo={undo} onUndo={restore} className="is-dock" /> : null}
      </div>
      {open ? (
        <Drawer plugins={plugins} onClose={() => setOpen(false)} onMove={onMove} onClear={onClear}
          onOpen={id => { setOpen(false); onOpen(id) }} action={action} reorder={reorder} remove={remove} undo={undo} onUndo={restore}
          announce={tell} region={drawerRegion} />
      ) : null}
    </>
  )
}
