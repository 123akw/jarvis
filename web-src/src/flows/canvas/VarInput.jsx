import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from '../../Modal.jsx'
import { parseVars } from '../graph.js'
import Glyph, { NodeIcon } from './glyphs.jsx'
import { applyEdit, displayToMarkup, insertToken, markupToDisplay, toDisplay, triggerAt } from './varText.js'

/* 带变量的文字输入：
 *   - 「插入变量」按钮，或直接打 `{{`，弹出上游节点的产出（人话：「AI 处理 · 文字」）；
 *   - 插进去存成 {{n1.text}}，输入框里显示成人话 chip（同一份文字铺两层：上层透明文字的 textarea 负责编辑与光标，
 *     下层镜像把变量画成 chip）；
 *   - 删除碰到 chip 时整块删掉；复制 / 剪切带变量的内容，粘回任何变量输入框仍是变量（外面粘出去是人话文字）。 */

const CLIP_MIME = 'application/x-jv-flow-text'

const flat = groups => groups.flatMap(g => g.vars.map(v => ({ ...v, group: g })))

function filterGroups(groups, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return groups
  return groups.map(g => ({ ...g, vars: g.vars.filter(v => v.label.toLowerCase().includes(q)) })).filter(g => g.vars.length)
}

/** 变量选择列表（输入框下方弹出；也给条件规则的「比较什么」复用） */
export function VarPicker({ groups, query, onQuery, active, onActive, onPick, onClose, searchable, listId, labelledBy }) {
  const shown = filterGroups(groups, query)
  const all = flat(shown)
  const listRef = useRef(null)
  useEscape(onClose)
  useEffect(() => {
    const el = listRef.current?.querySelector('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); onActive(Math.min(all.length - 1, active + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onActive(Math.max(0, active - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (all[active]) onPick(all[active]) }
  }
  let i = -1
  return (
    <div className="fc-vp" role="dialog" aria-label="插入变量" onMouseDown={e => { if (e.target.tagName !== 'INPUT') e.preventDefault() }}>
      {searchable ? (
        <input className="fc-vp-search" value={query} placeholder="搜变量，比如：文字" aria-label="搜变量" autoFocus
          aria-controls={listId} aria-activedescendant={all[active] ? `${listId}-${active}` : undefined}
          onChange={e => { onQuery(e.target.value); onActive(0) }} onKeyDown={onKey} />
      ) : null}
      {all.length ? (
        <div className="fc-vp-list" role="listbox" id={listId} ref={listRef} aria-labelledby={labelledBy}>
          {shown.map(g => (
            <div key={g.id} role="group" aria-label={g.title} className="fc-vp-group">
              <div className="fc-vp-head" aria-hidden="true">
                <NodeIcon type={g.type} size={12} />
                <span>{g.title}</span>
              </div>
              {g.vars.map(v => {
                i += 1
                const idx = i
                return (
                  <div key={v.token} id={`${listId}-${idx}`} role="option" aria-selected={idx === active}
                    className={`fc-vp-item${idx === active ? ' is-active' : ''}`}
                    onMouseEnter={() => onActive(idx)} onClick={() => onPick(v)}>
                    <span className="fc-vp-short">{v.short}</span>
                    <span className="fc-vp-full">{v.label}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        <p className="fc-vp-empty">
          {groups.length ? '没有对得上的变量' : '前面还没有能用的结果：先把这个节点和前面的节点连上'}
        </p>
      )}
    </div>
  )
}

/**
 * props：value（存的文字，含 {{…}}）、onChange(新文字)、groups（varOptions 的结果）、labelOf(ref, field) → { label, broken }、
 * multiline、rows、placeholder、label（读屏名）、id、disabled、maxLength、tour（给「插入变量」按钮加 data-tour="flow-var"）。
 */
export default function VarInput({
  value = '', onChange, groups = [], labelOf, multiline = true, rows = 3, placeholder = '', label, id, disabled = false,
  maxLength, tour = false, describedBy, typeTrigger = true,
}) {
  const info = useMemo(() => toDisplay(value, labelOf), [value, labelOf])
  const taRef = useRef(null)
  const mirrorRef = useRef(null)
  const caretRef = useRef(null)          // 下次渲染后要放的光标（markup 位置）
  const lastCaret = useRef(null)          // 最近一次光标（display 位置），按钮插入用
  const [pick, setPick] = useState(null)  // { mode: 'type'|'button', start(display), query, from, to(markup) }
  const [active, setActive] = useState(0)
  const autoId = useId()
  const listId = `${autoId}-vars`
  const inputId = id || `${autoId}-input`

  // 自动长高（单行也允许折行显示长内容）
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const h = ta.scrollHeight
    if (h) ta.style.height = `${h}px`
    if (mirrorRef.current) mirrorRef.current.scrollTop = ta.scrollTop
  }, [info.display])

  useLayoutEffect(() => {
    if (caretRef.current === null) return
    const ta = taRef.current
    const pos = markupToDisplay(caretRef.current, info.chips)
    caretRef.current = null
    if (ta && document.activeElement === ta) {
      try { ta.setSelectionRange(pos, pos) } catch { /* 不可聚焦时忽略 */ }
    }
    lastCaret.current = pos
  })

  function emit(next) {
    if (maxLength && next.markup.length > maxLength) return
    caretRef.current = next.caret
    onChange(next.markup)
  }

  function onInput(e) {
    const ta = e.target
    const caret = ta.selectionEnd ?? ta.value.length
    const next = applyEdit(value, info, ta.value, caret, { singleLine: !multiline })
    emit(next)
    // 打了 {{：弹出选择（按新 display 算）
    const after = toDisplay(next.markup, labelOf)
    const dpos = markupToDisplay(next.caret, after.chips)
    const trig = typeTrigger ? triggerAt(after.display, dpos, after.chips) : null
    if (trig) {
      const from = next.caret - (dpos - trig.start)
      setPick({ mode: 'type', start: trig.start, query: trig.query, from, to: next.caret })
      if (!pick || pick.mode !== 'type' || pick.query !== trig.query) setActive(0)
    } else if (pick?.mode === 'type') setPick(null)
  }

  function openButton() {
    const ta = taRef.current
    const focused = ta && document.activeElement === ta
    const ds = focused ? ta.selectionStart : (lastCaret.current ?? info.display.length)
    const de = focused ? ta.selectionEnd : ds
    const toM = pos => displayToMarkup(pos, info.chips)   // 落在 chip 内部时按 chip 末尾
    setPick({ mode: 'button', from: toM(Math.min(ds, de)), to: toM(Math.max(ds, de)), query: '' })
    setActive(0)
  }

  function choose(v) {
    if (!pick) return
    const next = insertToken(value, pick.from, pick.to, v.token)
    setPick(null)
    taRef.current?.focus()
    emit(next)
  }

  function onKeyDown(e) {
    if (pick?.mode === 'type') {
      const all = flat(filterGroups(groups, pick.query))
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(all.length - 1, a + 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); return }
      if ((e.key === 'Enter' || e.key === 'Tab') && all[active]) { e.preventDefault(); choose(all[active]); return }
    }
    if (!multiline && e.key === 'Enter') e.preventDefault()
  }

  function remember(e) { lastCaret.current = e.target.selectionEnd }

  /** 选区（display）→ markup 范围；碰到 chip 的整块算进来 */
  function selRange(ta) {
    let s = Math.min(ta.selectionStart, ta.selectionEnd)
    let e = Math.max(ta.selectionStart, ta.selectionEnd)
    for (const c of info.chips) if (c.start < e && c.end > s) { s = Math.min(s, c.start); e = Math.max(e, c.end) }
    return [displayToMarkup(s, info.chips), displayToMarkup(e, info.chips)]
  }
  function onCopy(e, cut = false) {
    const ta = e.target
    if (ta.selectionStart === ta.selectionEnd || !e.clipboardData) return
    const [a, b] = selRange(ta)
    const mk = value.slice(a, b)
    if (!parseVars(mk).length) return   // 没有变量：走浏览器默认
    e.preventDefault()
    e.clipboardData.setData('text/plain', toDisplay(mk, labelOf).display)
    e.clipboardData.setData(CLIP_MIME, mk)
    if (cut && !disabled) emit({ markup: value.slice(0, a) + value.slice(b), caret: a })
  }
  function onPaste(e) {
    const mk = e.clipboardData?.getData(CLIP_MIME)
    if (!mk) return   // 外面来的纯文字：走默认插入（applyEdit 处理）
    e.preventDefault()
    const [a, b] = selRange(e.target)
    const text = multiline ? mk : mk.replace(/\r?\n/g, ' ')
    emit({ markup: value.slice(0, a) + text + value.slice(b), caret: a + text.length })
  }

  const shownForType = pick?.mode === 'type' ? flat(filterGroups(groups, pick.query)) : []
  const segs = []
  let at = 0
  for (const c of info.chips) {
    if (c.start > at) segs.push(<span key={`t${at}`}>{info.display.slice(at, c.start)}</span>)
    segs.push(<mark key={`c${c.start}`} className={`fc-chip${c.broken ? ' is-broken' : ''}`}>{info.display.slice(c.start, c.end)}</mark>)
    at = c.end
  }
  if (at < info.display.length) segs.push(<span key={`t${at}`}>{info.display.slice(at)}</span>)

  const broken = info.chips.filter(c => c.broken).length
  return (
    <div className={`fc-vi${multiline ? '' : ' is-single'}${disabled ? ' is-disabled' : ''}`}>
      <div className="fc-vi-box">
        <div className="fc-vi-mirror" ref={mirrorRef} aria-hidden="true">{segs}{'​'}</div>
        <textarea ref={taRef} id={inputId} className="fc-vi-input" value={info.display} rows={multiline ? rows : 1}
          placeholder={placeholder} disabled={disabled} aria-label={label} spellCheck={false}
          aria-describedby={describedBy}
          aria-autocomplete="list" aria-expanded={pick?.mode === 'type' ? true : undefined}
          aria-controls={pick?.mode === 'type' ? listId : undefined}
          aria-activedescendant={pick?.mode === 'type' && shownForType[active] ? `${listId}-${active}` : undefined}
          onChange={onInput} onKeyDown={onKeyDown} onSelect={remember} onClick={remember}
          onCopy={e => onCopy(e)} onCut={e => onCopy(e, true)} onPaste={onPaste}
          onBlur={() => { if (pick?.mode === 'type') setTimeout(() => setPick(p => (p?.mode === 'type' ? null : p)), 120) }}
          onScroll={e => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.target.scrollTop }} />
        <button type="button" className="fc-vi-btn" disabled={disabled} onClick={openButton}
          aria-label={`给「${label}」插入变量`} title={typeTrigger ? '插入前面步骤的结果（也可以直接打 / ）' : '插入前面步骤的结果'} data-tour={tour ? 'flow-var' : undefined}
          aria-haspopup="dialog" aria-expanded={pick?.mode === 'button'}>
          <Glyph name="variable" size={15} /><span>变量</span>
        </button>
      </div>
      {broken ? <p className="fc-vi-warn">有 {broken} 个变量对应的内容已经不在了（标红的），删掉重新选一个</p> : null}
      {pick ? (
        <VarPicker groups={groups} query={pick.query} onQuery={q => setPick(p => ({ ...p, query: q }))}
          active={active} onActive={setActive} onPick={choose} searchable={pick.mode === 'button'}
          onClose={() => { setPick(null); taRef.current?.focus() }} listId={listId} />
      ) : null}
    </div>
  )
}
