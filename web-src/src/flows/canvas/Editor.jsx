/* 流程画布编辑器（第十八轮，归画布代理；契约见 docs/proposals/2026-10-round18-flows.md §5.1）。
 *
 * 由 flows/Flows.jsx（列表页代理）在 /flows/<id> 时懒加载渲染：
 *   <Editor flowId="abc" | "new"  initial={{ name, summary, graph }}（新建 / 模板 / 一句话生成时给草稿）
 *           onSaved={flow => …}（首次保存后 Flows 把地址换成 /flows/<id>；编辑器不会因 flowId 变成自己刚存的 id 而重载）
 *           onBack={() => …}  onExpired={() => …}  session={session} />
 * 编辑器自己取节点目录（GET /api/flows/nodes）、读写流程、运行（SSE）。
 *
 * 布局参考 Dify：顶栏 ｜ 左侧节点面板 ｜ 中间 React Flow 画布 ｜ 右侧配置 / 运行面板（浮在画布上）。
 * 手机（<760px）：列表式编辑 + 底部弹层；画布只读可缩放；可运行。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon.jsx'
import Modal, { ModalHead, useEscape } from '../../Modal.jsx'
import { TourButton, useTour } from '../../tour/index.jsx'
import { fileToBase64, getFlow, getNodeCatalog, runGraph, saveFlow } from '../api.js'
import {
  addNode, autoLayout, canRedo, canUndo, cleanGraph, COL, commit, connect, createHistory, createNode, defaultHandle,
  emptyGraph, insertAfter, insertOnEdge, issuesByNode, MAX_NODES, moveNodes, nodeById, nodeSummary, nodeTitle,
  normalizeGraph, redo, removeEdges, removeNodes, runReducer, settle, START_ID, startRunState, topoOrder, transient,
  undo, updateNodeData, validateGraph,
} from '../graph.js'
import Canvas from './Canvas.jsx'
import { indexCatalog, itemOf } from './catalog.js'
import ConfigPanel, { ConfigBody, typeLabelOf } from './ConfigPanel.jsx'
import Glyph, { NodeIcon } from './glyphs.jsx'
import MobileList from './MobileList.jsx'
import Palette, { NodeList } from './Palette.jsx'
import RunPanel from './RunPanel.jsx'
import './canvas.css'

const NARROW = '(max-width: 760px)'

function useMedia(query) {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [match, setMatch] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [query])
  return match
}

/** 节点出口「+」/ 连线「+」弹出的快捷面板（Dify 式），贴着按钮出现 */
function QuickAdd({ quick, graph, index, blocked, onPick, onClose }) {
  useEscape(onClose)
  const W = 300
  const H = 420
  const vw = window.innerWidth || 1280
  const vh = window.innerHeight || 800
  const r = quick.rect || { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3 }
  const left = Math.max(12, Math.min(r.right + 8, vw - W - 12))
  const top = Math.max(12, Math.min(r.top - 24, vh - H - 12))
  const after = quick.after ? nodeById(graph, quick.after) : null
  const where = quick.edgeId ? '插在这条线中间' : after ? `接在「${nodeTitle(after)}」后面` : '加一个节点'
  return (
    <div className="fc-quick-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="fc-quick" role="dialog" aria-label={`加节点：${where}`} style={{ left, top, width: W, maxHeight: H }}>
        <p className="fc-quick-where">{where}</p>
        <NodeList index={index} onPick={onPick} autoFocus blocked={blocked} idPrefix="fc-q"
          exclude={quick.edgeId ? it => it.type === 'end' : null} />
      </div>
    </div>
  )
}

function SaveState({ saving, dirty, isNew }) {
  const k = saving ? 'saving' : dirty || isNew ? 'dirty' : 'saved'
  const text = { saving: '保存中…', dirty: '有改动', saved: '已保存' }[k]
  return <span className={`fc-savestate is-${k}`} role="status"><i aria-hidden="true" />{text}</span>
}

export default function Editor({ flowId = 'new', initial = null, onSaved, onBack, onExpired }) {
  const narrow = useMedia(NARROW)
  const [phase, setPhase] = useState('loading')       // loading · ready · error
  const [loadErr, setLoadErr] = useState('')
  const [catalogRaw, setCatalogRaw] = useState(null)
  const [catalogErr, setCatalogErr] = useState(false)
  const index = useMemo(() => indexCatalog(catalogRaw), [catalogRaw])

  // 节点图 + 撤销历史（ref 同步，连续动作在同一帧里也能接着改）
  const [hist, setHistState] = useState(() => createHistory(emptyGraph()))
  const histRef = useRef(hist)
  const setHist = useCallback(next => { histRef.current = next; setHistState(next) }, [])
  const graph = hist.present

  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const idRef = useRef(flowId && flowId !== 'new' ? flowId : '')
  const loadedFor = useRef(null)
  const [saved, setSaved] = useState({ graph: null, name: '' })
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState('')
  const [tried, setTried] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedEdge, setSelectedEdge] = useState(null)
  const [quick, setQuick] = useState(null)
  const [panel, setPanel] = useState('')             // '' · run（桌面右侧运行抽屉）
  const [run, setRun] = useState(null)
  const [runShown, setRunShown] = useState(false)
  const [inputs, setInputs] = useState({})
  const [notice, setNotice] = useState(null)
  const [announce, setAnnounce] = useState('')
  const [mView, setMView] = useState('list')
  const [sheet, setSheet] = useState(null)           // 手机：{ kind: 'config', id } · { kind: 'add', after, handle } · { kind: 'run' }
  const rfRef = useRef(null)
  const sizesRef = useRef({})
  const abortRef = useRef(null)
  const noticeTimer = useRef(0)
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  const savedCb = useRef(onSaved)
  savedCb.current = onSaved

  const isNew = !idRef.current
  const dirty = saved.graph !== graph || saved.name !== name
  const running = run?.status === 'running'
  const locked = running

  /* ---------- 载入 ---------- */
  const expired = useCallback(() => expiredRef.current?.(), [])
  const loadCatalog = useCallback(async () => {
    try {
      const raw = await getNodeCatalog()
      setCatalogRaw(raw)
      setCatalogErr(false)
    } catch (err) {
      if (err.message === '401') { expired(); return }
      setCatalogErr(true)
    }
  }, [expired])

  const load = useCallback(async target => {
    setPhase('loading')
    setLoadErr('')
    const cat = loadCatalog()
    try {
      let g; let nm; let sm
      if (target && target !== 'new') {
        const flow = await getFlow(target)
        g = normalizeGraph(flow?.graph)
        nm = flow?.name || ''
        sm = flow?.summary || ''
        idRef.current = target
      } else {
        g = normalizeGraph(initial?.graph)
        nm = initial?.name || '新流程'
        sm = initial?.summary || ''
        idRef.current = ''
      }
      await cat
      loadedFor.current = target
      setHist(createHistory(g))
      setName(nm)
      setSummary(sm)
      setSaved({ graph: idRef.current ? g : null, name: nm })
      setSelectedId(null)
      setSelectedEdge(null)
      setRun(null)
      setRunShown(false)
      setPhase('ready')
    } catch (err) {
      if (err.message === '401') { expired(); return }
      setLoadErr(err.message || '流程没加载出来')
      setPhase('error')
    }
  }, [initial, loadCatalog, expired, setHist])

  useEffect(() => {
    if (loadedFor.current !== null && flowId === idRef.current) return   // 自己刚存出来的 id：不重载
    load(flowId)
  }, [flowId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { abortRef.current?.abort(); clearTimeout(noticeTimer.current) }, [])
  useEffect(() => { document.title = `${name || '新流程'} · 我的流程 · 贾维斯` }, [name])

  // 离开前有未保存改动：浏览器关闭 / 刷新时确认
  useEffect(() => {
    if (!dirty || phase !== 'ready') return undefined
    const h = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty, phase])

  useTour('flows-editor', { ready: phase === 'ready' })

  /* ---------- 派生 ---------- */
  const itemFor = useCallback(n => itemOf(index, n), [index])
  const issues = useMemo(() => validateGraph(graph, { itemOf: itemFor, sys: index.sys }), [graph, itemFor, index.sys])
  const issueMap = useMemo(() => issuesByNode(issues), [issues])
  const runBlockers = useMemo(() => issues.filter(i => i.block), [issues])
  const errorCount = runBlockers.length
  const order = useMemo(() => topoOrder(graph), [graph])

  const vmOf = useCallback(node => {
    const item = itemOf(index, node)
    const skill = node.type === 'llm' && node.data?.skill ? index.skills.find(s => s.data.skill === node.data.skill) : null
    return {
      node,
      title: nodeTitle(node),
      typeLabel: typeLabelOf(node, item),
      emoji: item?.icon || '',
      summary: nodeSummary(node, graph, { item, sys: index.sys, skillName: skill?.title || '' }),
      issues: issueMap[node.id] || [],
      run: runShown ? run?.nodes?.[node.id] || null : null,
      cases: node.type === 'condition' ? (node.data?.cases || []).map((c, i) => ({ id: c.id, label: String(c.label || '').trim() || `分支 ${i + 1}` })) : null,
    }
  }, [index, graph, issueMap, run, runShown])

  /* ---------- 提示 ---------- */
  const flash = useCallback((text, kind = 'ok') => {
    setNotice({ text, kind })
    setAnnounce(text)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), kind === 'ok' ? 2200 : 5000)
  }, [])

  /* ---------- 编辑 ---------- */
  /** fn(graph) → 新 graph 或 { graph, error } */
  const edit = useCallback((fn, { group = '', keepRun = false } = {}) => {
    const h = histRef.current
    const res = fn(h.present)
    const next = res && Array.isArray(res.nodes) ? res : res?.graph
    if (res?.error) { flash(res.error, 'error'); return false }
    if (!next || next === h.present) return true
    setHist(commit(h, next, { group }))
    if (!keepRun) setRunShown(false)
    return true
  }, [flash, setHist])

  const select = useCallback(id => {
    setSelectedId(id)
    if (id) setSelectedEdge(null)
    setQuick(null)
  }, [])
  const selectEdge = useCallback(id => {
    setSelectedEdge(id)
    if (id) setSelectedId(null)
  }, [])

  // 撤销后选中的节点 / 连线可能不在了
  useEffect(() => {
    if (selectedId && !nodeById(graph, selectedId)) setSelectedId(null)
    if (selectedEdge && !graph.edges.some(e => e.id === selectedEdge)) setSelectedEdge(null)
  }, [graph, selectedId, selectedEdge])

  const onPatch = useCallback((id, patch, group) => {
    edit(g => updateNodeData(g, id, patch), { group: group || '' })
  }, [edit])

  const onMove = useCallback((positions, done) => {
    const h = histRef.current
    const next = moveNodes(h.present, positions)
    const t = transient(h, next)
    setHist(done ? settle(t) : t)
  }, [setHist])

  const onConnect = useCallback(conn => {
    if (locked) return
    if (edit(g => connect(g, { source: conn.source, target: conn.target, sourceHandle: conn.sourceHandle ?? null }))) {
      setAnnounce('已连上')
    }
  }, [edit, locked])

  function centerPos() {
    const el = document.querySelector('.fc-canvas')
    const rf = rfRef.current
    if (el && rf?.screenToFlowPosition) {
      const r = el.getBoundingClientRect()
      const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      return { x: Math.round((p.x - 128) / 16) * 16, y: Math.round((p.y - 48) / 16) * 16 }
    }
    const maxX = Math.max(0, ...histRef.current.present.nodes.map(n => n.position.x))
    return { x: maxX + COL, y: 0 }
  }

  /** 加节点：{after, handle} 接在某个出口后面；{edgeId} 插在线中间；{position} 放在那里；都没有就按选中节点接 */
  function addItem(item, where = {}) {
    if (locked || !item) return
    if (item.available === false) return
    const g = histRef.current.present
    if (g.nodes.length >= MAX_NODES) { flash(`一个流程最多 ${MAX_NODES} 个节点，先删掉几个再加`, 'error'); return }
    const node = createNode(g, item, where.position || { x: 0, y: 0 })
    if (!node) return
    let res
    if (where.edgeId) res = insertOnEdge(g, where.edgeId, node)
    else if (where.after) res = insertAfter(g, where.after, where.handle ?? null, node)
    else if (where.position) res = { graph: addNode(g, node) }
    else {
      const sel = selectedId ? nodeById(g, selectedId) : null
      const endOf = id => g.edges.filter(e => e.target === id)
      const ends = g.nodes.filter(n => n.type === 'end')
      if (sel && sel.type !== 'end') res = insertAfter(g, sel.id, defaultHandle(sel), node)
      else if (sel?.type === 'end' && endOf(sel.id).length === 1 && node.type !== 'end') res = insertOnEdge(g, endOf(sel.id)[0].id, node)
      else if (!sel && ends.length === 1 && endOf(ends[0].id).length === 1 && node.type !== 'end') res = insertOnEdge(g, endOf(ends[0].id)[0].id, node)
      else res = { graph: addNode(g, { ...node, position: centerPos() }) }
    }
    if (!edit(() => res)) return
    setQuick(null)
    setSelectedId(node.id)
    setSelectedEdge(null)
    setAnnounce(`已加入「${nodeTitle(node)}」`)
  }

  function onDropItem(key, position) {
    const item = index.byKey.get(key)
    if (item) addItem(item, { position })
  }

  function deleteSelected() {
    if (locked) return
    if (selectedEdge) {
      edit(g => removeEdges(g, [selectedEdge]))
      setSelectedEdge(null)
      setAnnounce('已删除连线')
    } else if (selectedId && selectedId !== START_ID) {
      const n = nodeById(graph, selectedId)
      edit(g => removeNodes(g, [selectedId]))
      setSelectedId(null)
      setSheet(null)
      flash(`已删除「${nodeTitle(n)}」，可以撤销`)
    } else if (selectedId === START_ID) {
      flash('「开始」节点不能删', 'error')
    }
  }

  const doUndo = useCallback(() => { if (!locked) { setHist(undo(histRef.current)); setRunShown(false); setAnnounce('已撤销') } }, [locked, setHist])
  const doRedo = useCallback(() => { if (!locked) { setHist(redo(histRef.current)); setRunShown(false); setAnnounce('已重做') } }, [locked, setHist])

  function tidy() {
    if (locked) return
    edit(g => autoLayout(g, sizesRef.current), { keepRun: true })
    setTimeout(() => rfRef.current?.fitView?.({ padding: 0.24, maxZoom: 1.1, duration: 280 }), 60)
    setAnnounce('已自动整理')
  }

  function locate(id) {
    select(id)
    setPanel('')
    if (narrow) { setSheet({ kind: 'config', id }); return }
    const n = nodeById(histRef.current.present, id)
    const s = sizesRef.current[id] || { width: 256, height: 110 }
    if (n && rfRef.current?.setCenter) rfRef.current.setCenter(n.position.x + s.width / 2, n.position.y + s.height / 2, { zoom: 1, duration: 280 })
  }

  /* ---------- 保存 ---------- */
  async function save({ quiet = false, notify = true } = {}) {
    if (saving) return null
    setTried(true)
    const block = issues.filter(i => i.block === 'save')
    if (block.length) {
      flash(block[0].message, 'error')
      if (block[0].nodeId) locate(block[0].nodeId)
      return null
    }
    const g = histRef.current.present
    const rawName = name
    setSaving(true)
    try {
      const flow = await saveFlow({ id: idRef.current, name: rawName.trim() || '未命名流程', summary, graph: cleanGraph(g) })
      if (!flow?.id) throw new Error('保存没成功，请再试一次')
      idRef.current = flow.id
      loadedFor.current = flow.id
      if (flow.name && flow.name !== rawName.trim()) setName(flow.name)
      setSaved({ graph: g, name: flow.name && flow.name !== rawName.trim() ? flow.name : rawName })
      if (!quiet) flash('已保存')
      if (notify) savedCb.current?.(flow)
      return flow
    } catch (err) {
      if (err.message === '401') { expired(); return null }
      flash(err.message || '保存没成功，请再试一次', 'error')
      return null
    } finally {
      setSaving(false)
    }
  }

  /* ---------- 运行 ---------- */
  function openRun() {
    setTried(true)
    setQuick(null)
    if (narrow) setSheet({ kind: 'run' })
    else setPanel('run')
  }

  async function startRun() {
    if (running || busy) return
    setTried(true)
    if (runBlockers.length) return
    let fid = idRef.current
    let later = null
    if (!fid || dirty) {
      const wasNew = !fid
      setBusy('saving')
      // 新流程：先存拿到 id，运行完再通知列表页换地址（换地址可能让外层重挂编辑器，不能打断这次运行）
      const flow = await save({ quiet: true, notify: !wasNew })
      setBusy('')
      if (!flow) return
      fid = flow.id
      if (wasNew) later = flow
    }
    const start = nodeById(histRef.current.present, START_ID)
    const payload = {}
    try {
      for (const f of start?.data?.fields || []) {
        const v = inputs[f.key]
        if (v === undefined || v === null || v === '') continue
        if (f.type === 'file') payload[f.key] = { name: v.name, data_base64: await fileToBase64(v) }
        else if (f.type === 'number') payload[f.key] = Number(v)
        else payload[f.key] = String(v)
      }
    } catch (err) {
      flash(err.message || '读取文件失败，换一个试试', 'error')
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let state = startRunState()
    setRun(state)
    setRunShown(true)
    setSelectedEdge(null)
    setAnnounce('开始运行')
    try {
      for await (const ev of runGraph(fid, payload, ctrl.signal)) {
        if (ctrl.signal.aborted) break
        state = runReducer(state, ev)
        setRun(state)
        if (ev.type === 'run_done') break
      }
      if (ctrl.signal.aborted) state = runReducer(state, { type: 'stopped' })
      else if (state.status === 'running') state = runReducer(state, { type: 'failed', message: '连接断了，流程没跑完' })
    } catch (err) {
      if (err.message === '401') { abortRef.current = null; expired(); return }
      state = ctrl.signal.aborted || err.name === 'AbortError'
        ? runReducer(state, { type: 'stopped' })
        : runReducer(state, { type: 'failed', message: err.message || '流程没跑完' })
    }
    if (abortRef.current === ctrl) abortRef.current = null
    state = { ...state, ms: state.ms || Date.now() - state.startedAt }
    setRun(state)
    setAnnounce(state.status === 'ok' ? '运行完成' : state.status === 'stopped' ? '已停止运行' : `没跑通：${state.error}`)
    if (later) savedCb.current?.(later)
  }

  function stopRun() {
    abortRef.current?.abort()
    setRun(r => (r?.status === 'running' ? runReducer(r, { type: 'stopped' }) : r))
  }

  function back() {
    if (dirty && phase === 'ready' && !window.confirm('改动还没保存，确定离开吗？')) return
    abortRef.current?.abort()
    onBack?.()
  }

  /* ---------- 快捷键 ---------- */
  const keys = useRef({})
  keys.current = { save, doUndo, doRedo, deleteSelected, selectedId, selectedEdge, quick, panel }
  useEffect(() => {
    function onKey(e) {
      const k = keys.current
      const mod = e.metaKey || e.ctrlKey
      const key = String(e.key || '').toLowerCase()
      if (mod && key === 's') { e.preventDefault(); void k.save(); return }
      const t = e.target
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (typing || e.defaultPrevented) return
      if (document.querySelector('.jv-modal-backdrop, .fc-quick-scrim, [data-tour-open]')) return
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) k.doRedo(); else k.doUndo(); return }
      if (mod && key === 'y') { e.preventDefault(); k.doRedo(); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (k.selectedId || k.selectedEdge)) { e.preventDefault(); k.deleteSelected(); return }
      if (e.key === 'Escape' && (k.selectedId || k.selectedEdge)) { setSelectedId(null); setSelectedEdge(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------- 渲染 ---------- */
  if (phase !== 'ready') {
    return (
      <div className="fc-editor fc-editor--state">
        {phase === 'error' ? (
          <div className="fc-state" role="alert">
            <p>{loadErr}</p>
            <div className="jv-actions">
              <button type="button" className="jv-btn jv-btn--sm" onClick={() => load(flowId)}>重新加载</button>
              <button type="button" className="jv-btn jv-btn--sm" onClick={() => onBack?.()}>回到我的流程</button>
            </div>
          </div>
        ) : <div className="fc-state" role="status"><i className="fc-spin" aria-hidden="true" />正在打开流程…</div>}
      </div>
    )
  }

  const sel = selectedId ? nodeById(graph, selectedId) : null
  const nodeLimit = graph.nodes.length >= MAX_NODES ? `已经 ${MAX_NODES} 个节点了，先删掉几个再加` : ''
  const configProps = sel ? {
    node: sel, graph, index, sys: index.sys, issues: issueMap[sel.id] || [], locked, onPatch,
    onDelete: deleteSelected,
    onConnect,
    onDisconnect: id => edit(g => removeEdges(g, [id])),
    onSelectNode: id => locate(id),
  } : null
  const onlyStartEnd = graph.nodes.length <= 2 && graph.nodes.every(n => n.type === 'start' || n.type === 'end')
  const runPanelProps = {
    graph, index, run, inputs, onInputs: setInputs, onRun: startRun, onStop: stopRun, blockers: runBlockers,
    onLocate: locate, busy: busy || (saving ? 'saving' : ''), onClose: () => setPanel(''),
  }

  const top = (
    <header className="fc-top">
      <button type="button" className="fc-back" onClick={back} aria-label="返回我的流程">
        <Icon name="chevron" size={16} className="fc-flip" /><span>我的流程</span>
      </button>
      <div className="fc-namebox">
        <input className="fc-name" value={name} maxLength={30} placeholder="给流程起个名字" aria-label="流程名称"
          onChange={e => setName(e.target.value)} />
        <SaveState saving={saving} dirty={dirty} isNew={isNew} />
      </div>
      <div className="fc-top-r">
        <div className="fc-tools" role="group" aria-label="编辑">
          <button type="button" className="jv-icon-btn" onClick={doUndo} disabled={!canUndo(hist) || locked} aria-label="撤销" title="撤销（⌘Z）">
            <Icon name="undo" size={17} />
          </button>
          <button type="button" className="jv-icon-btn" onClick={doRedo} disabled={!canRedo(hist) || locked} aria-label="重做" title="重做（⇧⌘Z）">
            <Icon name="undo" size={17} className="fc-flip" />
          </button>
          {!narrow ? (
            <button type="button" className="jv-btn jv-btn--sm fc-tidy" onClick={tidy} disabled={locked} title="按从左到右的顺序自动排好">
              <Glyph name="layout" size={15} />整理
            </button>
          ) : null}
        </div>
        <TourButton tour="flows-editor" className="jv-btn jv-btn--sm fc-tour" label={narrow ? '引导' : '新手引导'} />
        <button type="button" className="jv-btn jv-btn--sm fc-save" onClick={() => save()} disabled={saving || locked || (!dirty && !isNew)}
          data-tour="flow-save" title="保存（⌘S）">
          <Glyph name="save" size={15} /><span>{saving ? '保存中' : '保存'}</span>
        </button>
        {running ? (
          <button type="button" className="jv-btn jv-btn--sm fc-stop" onClick={stopRun} data-tour="flow-run">
            <Icon name="stop" size={14} />停止
          </button>
        ) : (
          <button type="button" className="jv-btn jv-btn--sm jv-btn--primary fc-runbtn" onClick={openRun} data-tour="flow-run">
            <Glyph name="play" size={12} />运行
          </button>
        )}
      </div>
    </header>
  )

  const toast = notice ? (
    <p className={`fc-toast is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>
  ) : null

  /* ---- 手机 ---- */
  if (narrow) {
    const sheetNode = sheet?.kind === 'config' ? nodeById(graph, sheet.id) : null
    return (
      <div className={`fc-editor is-narrow${tried ? ' is-tried' : ''}`} aria-busy={running || undefined}>
        {top}
        <div className="fc-mtabs" role="tablist" aria-label="查看方式">
          {[['list', '步骤'], ['canvas', '画布']].map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={mView === v} className={mView === v ? 'is-on' : ''} onClick={() => setMView(v)}>
              <Icon name={v === 'list' ? 'list' : 'flow'} size={15} />{l}
            </button>
          ))}
          {errorCount ? <span className="fc-mcount">{errorCount} 处要处理</span> : null}
        </div>
        <main className="fc-mbody">
          {mView === 'list' ? (
            <MobileList graph={graph} order={order} vmOf={vmOf} locked={locked}
              onOpen={id => { select(id); setSheet({ kind: 'config', id }) }}
              onAdd={(after, handle) => setSheet({ kind: 'add', after, handle })} />
          ) : (
            <Canvas graph={graph} vmOf={vmOf} selectedId={selectedId} selectedEdge={null} locked={locked} readOnly run={runShown ? run : null}
              onSelect={id => { if (id) { select(id); setSheet({ kind: 'config', id }) } }} onSelectEdge={() => {}} onMove={() => {}}
              onConnect={() => {}} onDropItem={() => {}} onInit={inst => { rfRef.current = inst }} sizesRef={sizesRef} />
          )}
        </main>
        {toast}
        {sheetNode ? (
          <Modal label={`设置「${nodeTitle(sheetNode)}」`} onClose={() => setSheet(null)} className="fc-sheet">
            <div className="fc-sheet-head">
              <NodeIcon type={sheetNode.type} emoji={itemOf(index, sheetNode)?.icon || ''} size={18} />
              <div className="fc-config-titles">
                <input className="fc-config-title" value={sheetNode.data?.title ?? ''} maxLength={30} disabled={locked} aria-label="节点名称"
                  onChange={e => onPatch(sheetNode.id, { title: e.target.value }, `${sheetNode.id}.title`)} />
                <small>{typeLabelOf(sheetNode, itemOf(index, sheetNode))}</small>
              </div>
              <button type="button" className="jv-modal-close" onClick={() => setSheet(null)} aria-label="完成"><Icon name="close" size={15} /></button>
            </div>
            <div className="jv-modal-body fc-sheet-body" data-tour="flow-config">
              <ConfigBody {...configProps} node={sheetNode} issues={issueMap[sheetNode.id] || []}
                onSelectNode={id => { select(id); setSheet({ kind: 'config', id }) }} />
            </div>
          </Modal>
        ) : null}
        {sheet?.kind === 'add' ? (
          <Modal label="加一步" onClose={() => setSheet(null)} className="fc-sheet">
            <ModalHead title="加一步" subtitle={`接在「${nodeTitle(nodeById(graph, sheet.after))}」后面`} onClose={() => setSheet(null)} />
            <div className="jv-modal-body">
              <NodeList index={index} blocked={nodeLimit} idPrefix="fc-m"
                onPick={item => { addItem(item, { after: sheet.after, handle: sheet.handle }); setSheet(null) }} />
            </div>
          </Modal>
        ) : null}
        {sheet?.kind === 'run' ? (
          <Modal label="运行流程" onClose={() => setSheet(null)} className="fc-sheet fc-sheet--run" dismissOnBackdrop={!running}>
            <ModalHead title="运行" subtitle={name || '新流程'} onClose={() => setSheet(null)} />
            <div className="jv-modal-body">
              <RunPanel {...runPanelProps} sheet onLocate={id => locate(id)} />
            </div>
          </Modal>
        ) : null}
        <p className="sr-only" aria-live="polite">{announce}</p>
      </div>
    )
  }

  /* ---- 桌面 ---- */
  return (
    <div className={`fc-editor${tried ? ' is-tried' : ''}${running ? ' is-running' : ''}`} aria-busy={running || undefined}>
      {top}
      <div className="fc-body">
        <Palette index={index} onPick={item => addItem(item)} blocked={nodeLimit || (locked ? '运行中，先等它跑完' : '')}
          catalogError={catalogErr} onRetry={loadCatalog} />
        <div className="fc-stage">
          <Canvas graph={graph} vmOf={vmOf} selectedId={selectedId} selectedEdge={selectedEdge} locked={locked} run={runShown ? run : null}
            onSelect={id => { select(id); if (id) setPanel(p => (p === 'run' && !running ? '' : p)) }} onSelectEdge={selectEdge}
            onMove={onMove} onConnect={onConnect} onConnectError={msg => flash(msg, 'error')}
            onDropItem={onDropItem} onQuick={q => { if (!locked) setQuick(q) }}
            onInit={inst => { rfRef.current = inst }} sizesRef={sizesRef} />
          {onlyStartEnd && !sel && panel !== 'run' ? (
            <div className="fc-hint" role="note">
              <b>从这里开始搭</b>
              <span>把左边的节点拖到画布上，或者点连线中间的「+」插一步；节点右边的「+」能接着往后加。</span>
            </div>
          ) : null}
          {errorCount ? (
            <button type="button" className={`fc-issues${tried ? ' is-loud' : ''}`} onClick={() => {
              const ids = [...new Set(runBlockers.map(b => b.nodeId).filter(Boolean))]
              if (!ids.length) { flash(runBlockers[0].message, 'error'); return }
              const i = ids.indexOf(selectedId)
              locate(ids[(i + 1) % ids.length])
            }} aria-label={`还有 ${errorCount} 处要处理，点一下逐个查看`}>
              <Glyph name="warn" size={14} />还有 {errorCount} 处要处理
            </button>
          ) : null}
          {toast}
          {panel === 'run' ? (
            <div className="fc-side"><RunPanel {...runPanelProps} /></div>
          ) : sel ? (
            <div className="fc-side"><ConfigPanel {...configProps} onClose={() => select(null)} /></div>
          ) : null}
        </div>
      </div>
      {quick ? (
        <QuickAdd quick={quick} graph={graph} index={index} blocked={nodeLimit}
          onPick={item => addItem(item, quick.edgeId ? { edgeId: quick.edgeId } : { after: quick.after, handle: quick.handle })}
          onClose={() => setQuick(null)} />
      ) : null}
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  )
}
