import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import { useDialogFocus, useEscape } from '../Modal.jsx'
import { toolLabel } from '../toolInfo.js'
import { detailHref, linkClick } from './PluginCard.jsx'
import {
  KIND_LABEL, SOURCE_LABEL, abilitiesOf, blockReason, relatedPlugins, requireHelp, requireText, shortRef, sourceLink, sourceOf,
} from './model.js'
import { useMedia } from './useMedia.js'
import './detail.css'

/* 插件详情（第十七轮「少即是多」，对齐 docs/design/2026-10-market-references.md §0 / §4）：
 * 头部 = 96 大图标 + 名称 + 一句话 + 作者；全页唯一的主按钮「加入工具箱」桌面在名称右侧、手机在吸底条。
 * 事实条 4 项（类型 · 能力 · 来源 · 价格）→ 介绍（三行 +「更多」）→ 它能做什么（无框列表，先露 3 条）
 * → 试试这样问（一块浅色面板 + 药丸，点击复制，行尾 → 带去推荐）→ 需要什么（空则不出现）→ 同类推荐 → 信息（2 列）。
 * 需要配置：头部下一条左侧警示竖条说明，主按钮换成禁用的次按钮「需要管理员配置」。
 * 地址带 ?plugin=<id>，可分享、可后退；手机底部全高抽屉（抓手下滑关闭），宽屏右侧抽屉；Esc 关闭、焦点陷阱。 */

const ABILITY_PREVIEW = 3
const EXAMPLE_MAX = 3
const DESC_CLAMP = 80          // 超过这么多字（或有换行）才给「更多」
const DRAWER = '(min-width: 720px)'
const SWIPE_CLOSE = 120        // 下滑超过 120px 或速度 > 0.5px/ms 关闭
const SWIPE_SPEED = 0.5

/** 工具名 → 人话：前端收录的用中文名，没收录的用工具自带的说明，再不行才露出工具名 */
function toolText(t) {
  if (t.label) return `🔧 ${t.label}`
  const label = toolLabel(t.name)
  if (!label.startsWith('⚙ ')) return label
  return t.description ? `🔧 ${t.description}` : `🔧 ${t.name}`
}

/** 「⛅ 城市天气」→ { icon: '⛅', text: '城市天气' }：图标单独占一列，正文对齐 */
function splitIcon(text, icon) {
  if (icon) return { icon, text }
  const m = /^(\S{1,4})\s+(.+)$/su.exec(text)
  return m && !/[\w一-龥]/.test(m[1]) ? { icon: m[1], text: m[2] } : { icon: '', text }
}

/** 「需要什么」：前置条件、MCP 联网主机、管理员配置、目录给的权限声明（技能的「不运行代码」放进「信息」） */
export function needsOf(p) {
  const out = p.requires.map(id => ({ id: `req-${id}`, title: requireText(id), help: requireHelp(id), tone: 'warn' }))
  p.hosts.forEach(h => out.push({ id: `host-${h}`, title: `联网：${h}`, help: '用到时请求会发到这个外部服务，返回的内容只当参考资料。', tone: 'info' }))
  p.config.forEach(c => out.push({
    id: `cfg-${c.key}`, title: `${c.required ? '需要' : '可选'}配置：${c.label}`,
    help: c.configured === true ? '管理员已经配置好了。' : c.help || '由管理员在「插件管理」里填写，密钥加密保存、不会显示给别人。',
    tone: c.configured === true ? 'ok' : 'warn',
  }))
  if (!p.config.length && p.configMissing.length) {
    out.push({ id: 'cfg-missing', title: `需要配置：${p.configMissing.join('、')}`, help: '由管理员在「插件管理」里填写后才能用。', tone: 'warn' })
  }
  p.permissions.forEach(x => out.push({ id: `perm-${x.key}`, title: x.label, help: '', tone: x.level === 'warn' ? 'warn' : 'info' }))
  // 同一件事可能从 hosts 和 permissions 各来一条（如「联网：mcp.deepwiki.com」）：按标题去重，先到的留下
  const seen = new Set()
  return out.filter(x => !seen.has(x.title) && seen.add(x.title))
}

function powerOf(p) {
  if (p.kind === 'skill') return '1 套方法'
  if (p.kind === 'step') return '拼进流程'
  if (p.tools.length) return `${p.tools.length} 个工具`
  return p.kind === 'mcp' ? '远程工具' : '—'
}

/** 唯一的主按钮：加入 / 移出工具箱。不可用 / 需要配置时换成禁用的次按钮，直接写原因（已加入的仍可移出） */
function AddToBox({ plugin, picked, onToggle, mini = false }) {
  const blocked = !!blockReason(plugin) && !picked
  const text = picked ? '已加入' : blocked ? (plugin.status === 'needs_config' ? '需要管理员配置' : '暂不可用') : mini ? '加入' : '加入工具箱'
  const label = picked ? `移出工具箱：${plugin.name}` : blocked ? `${text}：${plugin.name}` : `加入工具箱：${plugin.name}`
  return (
    <button type="button" className={`jvm-pd-add${picked ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}${mini ? ' is-mini' : ''}`}
      aria-pressed={picked} disabled={blocked} aria-label={label} onClick={() => onToggle(plugin.id)}>
      {blocked ? null : <Icon name={picked ? 'check' : 'plus'} size={mini ? 14 : 16} />}
      <span>{text}</span>
    </button>
  )
}

/** 「试试这样问」的一枚药丸：点一下复制；行尾 → 带去「帮我推荐」 */
function Example({ text, onAsk }) {
  const [state, setState] = useState('')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(''), 1600)
  }
  return (
    <li className={`jvm-pd-pill${state ? ` is-${state}` : ''}`}>
      <button type="button" className="jvm-pd-pill-text" onClick={copy} aria-label={`复制：${text}`}>
        <span className="jvm-pd-pill-q">{text}</span>
        <span className="jvm-pd-pill-state" aria-live="polite">
          {state === 'ok' ? <><Icon name="check" size={12} />已复制</> : state === 'fail' ? '没复制成功' : null}
        </span>
      </button>
      {onAsk ? (
        <button type="button" className="jvm-pd-pill-go" onClick={() => onAsk(text)} aria-label={`带去推荐：${text}`} title="带去「帮我推荐」">
          <Icon name="chevron" size={14} />
        </button>
      ) : null}
    </li>
  )
}

function Section({ id, title, children, aside = null, className = '' }) {
  return (
    <section className={`jvm-pd-sec ${className}`.trim()} aria-labelledby={id}>
      <header className="jvm-pd-sec-head"><h3 id={id}>{title}</h3>{aside}</header>
      {children}
    </section>
  )
}

/** 头部滚出视野 → 顶栏浮出小标题（没有 IntersectionObserver 的环境就一直不浮出） */
function useStuck(targetRef, rootRef, key) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = targetRef.current
    setStuck(false)
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { root: rootRef.current, threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [targetRef, rootRef, key])
  return stuck
}

/** 手机：按住顶栏（抓手）往下拖，超过 120px 或甩得够快就关闭，否则弹回 */
function useSwipeDown(sheetRef, onClose, enabled) {
  const drag = useRef(null)
  if (!enabled) return {}
  const set = (dy, animate) => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = animate ? 'transform .24s cubic-bezier(.2,.8,.2,1)' : 'none'
    el.style.transform = dy ? `translateY(${dy}px)` : ''
  }
  return {
    onPointerDown(e) {
      if (e.button !== 0 || e.target.closest('button')) return
      drag.current = { y: e.clientY, t: performance.now(), dy: 0, v: 0 }
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    onPointerMove(e) {
      const d = drag.current
      if (!d) return
      const dy = Math.max(0, e.clientY - d.y)
      const now = performance.now()
      d.v = (dy - d.dy) / Math.max(1, now - d.t)
      d.dy = dy
      d.t = now
      set(dy, false)
    },
    onPointerUp() {
      const d = drag.current
      drag.current = null
      if (!d) return
      if (d.dy > SWIPE_CLOSE || (d.dy > 24 && d.v > SWIPE_SPEED)) onClose()
      else set(0, true)
    },
    onPointerCancel() { drag.current = null; set(0, true) },
  }
}

export default function PluginDetail({ catalog, pluginId, picked, onToggle, onOpen, onClose, onAskAI, authed, toolboxCount = 0 }) {
  const ref = useRef(null)
  const scrollRef = useRef(null)
  const titleRef = useRef(null)
  const headRef = useRef(null)
  const [allAbilities, setAllAbilities] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const wide = useMedia(DRAWER)
  useEscape(onClose)
  useDialogFocus(ref)
  const swipe = useSwipeDown(ref, onClose, !wide)
  const p = catalog.plugins.find(x => x.id === pluginId) || null
  const stuck = useStuck(headRef, scrollRef, p?.id)
  // 切到同类推荐里的另一个插件：回到顶部、折叠复位，焦点落到新标题上
  const first = useRef(true)
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 })
    setAllAbilities(false); setDescOpen(false)
    if (first.current) { first.current = false; return }
    titleRef.current?.focus({ preventScroll: true })
  }, [pluginId])

  const shell = (label, children, { mini = null, foot = null } = {}) => (
    <div className="jvm-pd-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="jvm-pd" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className={`jvm-pd-bar${mini ? ' is-stuck' : ''}`} {...swipe}>
          <span className="jvm-pd-grab" aria-hidden="true" />
          {mini}
          <button type="button" className="jvm-pd-close" onClick={onClose} aria-label="关闭详情">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="jvm-pd-scroll" ref={scrollRef}>{children}</div>
        {foot}
      </div>
    </div>
  )

  if (!p) {
    return shell('插件详情', (
      <div className="jvm-none">
        <span className="jvm-none-icon" aria-hidden="true">🧩</span>
        <p className="jvm-none-title">没找到这个插件</p>
        <p className="jvm-none-sub">它可能已经下架或改了名字，去市场里看看别的吧。</p>
        <div className="jvm-none-actions"><button type="button" className="jvm-btn" onClick={onClose} data-autofocus>回到市场</button></div>
      </div>
    ))
  }

  const isPicked = picked.includes(p.id)
  const blocked = blockReason(p)
  const src = sourceOf(p)
  const catName = catalog.categories.find(c => c.id === p.category)?.name || '其他'
  const abilities = abilitiesOf(p, toolText).map(a => ({ ...a, ...splitIcon(a.text, a.icon) }))
  const shownAbilities = allAbilities ? abilities : abilities.slice(0, ABILITY_PREVIEW)
  const needs = needsOf(p)
  const related = relatedPlugins(catalog.plugins, p)
  const link = sourceLink(p)
  const author = p.author || (p.builtin ? 'JWS-Agent' : '社区作者')
  const desc = p.description && p.description !== p.summary ? p.description : ''
  const descLong = desc.length > DESC_CLAMP || desc.includes('\n')
  const strip = [
    ['类型', KIND_LABEL[p.kind]],
    ['能力', powerOf(p)],
    ['来源', SOURCE_LABEL[src]],
    ['价格', p.tier === 'pro' ? '专业版' : '免费'],
  ]
  const runs = p.kind === 'skill' ? '一段做事说明书：不运行代码、不读你的文件、不联网'
    : !p.builtin ? '在独立子进程里运行，不带任何密钥' : ''
  const info = [
    ['提供者', author],
    ['分类', catName],
    ['版本', p.version ? `v${p.version}` : '—'],
    ['许可证', p.license || (p.builtin ? '随平台' : '未声明')],
  ]
  const links = [
    link ? { id: 'src', label: `源代码${p.source?.ref ? ` @${shortRef(p.source.ref)}` : ''}`, href: link } : null,
    p.homepage && p.homepage !== link && /^https?:\/\//.test(p.homepage) ? { id: 'home', label: '主页', href: p.homepage } : null,
    p.privacyUrl ? { id: 'privacy', label: '隐私政策', href: p.privacyUrl } : null,
  ].filter(Boolean)

  const add = <AddToBox plugin={p} picked={isPicked} onToggle={onToggle} />
  // 桌面：头部滚出视野后，顶栏浮出小图标 + 名字 + 小按钮（那时头部的按钮已看不见，同屏仍只有一个主按钮）
  const mini = stuck ? (
    <div className="jvm-pd-mini">
      <span className="jvm-pd-mini-icon" aria-hidden="true">{p.icon}</span>
      <span className="jvm-pd-mini-name" aria-hidden="true">{p.name}</span>
      {wide ? <AddToBox plugin={p} picked={isPicked} onToggle={onToggle} mini /> : null}
    </div>
  ) : null
  const foot = wide ? null : (
    <div className="jvm-pd-foot">
      {isPicked ? <span className="jvm-pd-foot-note">工具箱里共 {toolboxCount} 个</span> : null}
      {add}
    </div>
  )

  return shell(`插件详情：${p.name}`, (
    <article className="jvm-pd-body" key={p.id}>
      <header className="jvm-pd-head" ref={headRef}>
        <span className="jvm-pd-icon" aria-hidden="true">{p.icon}</span>
        <div className="jvm-pd-titles">
          <h2 id="jvm-detail-title" ref={titleRef} tabIndex={-1}>{p.name}</h2>
          {p.summary ? <p className="jvm-pd-summary">{p.summary}</p> : null}
          <p className="jvm-pd-by">{author}</p>
        </div>
        {wide ? (
          <div className="jvm-pd-act">
            {add}
            {isPicked ? <span className="jvm-pd-act-note">工具箱里共 {toolboxCount} 个</span> : null}
          </div>
        ) : null}
      </header>

      {blocked ? (
        <p className="jvm-pd-alert" role="note">
          <b>{p.status === 'needs_config' ? '需要配置' : '暂不可用'}</b>
          {p.status === 'needs_config'
            ? `${blocked}${p.configMissing.length ? `（缺：${p.configMissing.join('、')}）` : ''}。管理员在「插件管理」里填好后就能加入。`
            : `${blocked}。`}
        </p>
      ) : authed && !p.available ? (
        <p className="jvm-pd-alert is-soft" role="note"><b>当前账号暂不可用</b>{p.requires.map(requireText).join('、') || '前置条件没满足'}，生成的新账号按它自己的设置算。</p>
      ) : null}

      <dl className="jvm-pd-strip" aria-label="概览">
        {strip.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>

      {desc ? (
        <div className={`jvm-pd-desc${descLong && !descOpen ? ' is-clamped' : ''}`}>
          <p id="jvm-pd-desc-text">{desc}</p>
          {descLong ? (
            <button type="button" className="jvm-pd-more" aria-expanded={descOpen} aria-controls="jvm-pd-desc-text"
              onClick={() => setDescOpen(o => !o)}>{descOpen ? '收起' : '更多'}</button>
          ) : null}
        </div>
      ) : null}

      <Section id="jvm-pd-can" title="它能做什么" aside={abilities.length > ABILITY_PREVIEW ? (
        <button type="button" className="jvm-pd-more" aria-expanded={allAbilities} aria-controls="jvm-pd-can-list"
          onClick={() => setAllAbilities(o => !o)}>{allAbilities ? '收起' : `全部 ${abilities.length} 项`}</button>
      ) : null}>
        {abilities.length ? (
          <ul className="jvm-pd-list" id="jvm-pd-can-list">
            {shownAbilities.map(a => (
              <li key={a.id}>
                <span className="jvm-pd-list-icon" aria-hidden="true">{a.icon || '·'}</span>
                <span>{a.text}{a.detail && !a.text.includes(a.detail) ? <small>{a.detail}</small> : null}</span>
              </li>
            ))}
          </ul>
        ) : <p className="jvm-pd-muted">{p.summary || '装上后，智能体会在合适的时候用它。'}</p>}
      </Section>

      {p.examples.length ? (
        <section className="jvm-pd-sec jvm-pd-try" aria-labelledby="jvm-pd-try-h">
          <header className="jvm-pd-sec-head"><h3 id="jvm-pd-try-h">试试这样问</h3><span className="jvm-pd-hint">点一下复制</span></header>
          <ul className="jvm-pd-pills">{p.examples.slice(0, EXAMPLE_MAX).map(ex => <Example key={ex} text={ex} onAsk={onAskAI} />)}</ul>
        </section>
      ) : null}

      {needs.length ? (
        <Section id="jvm-pd-needs" title="需要什么">
          <ul className="jvm-pd-list is-needs">
            {needs.map(n => (
              <li key={n.id} className={`is-${n.tone}`}>
                <span className="jvm-pd-list-icon" aria-hidden="true"><i className="jvm-pd-dot" /></span>
                <span><b>{n.title}</b>{n.help ? <small>{n.help}</small> : null}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {related.length ? (
        <Section id="jvm-pd-related" title="同类推荐">
          <ul className="jvm-pd-related">
            {related.map(r => (
              <li key={r.id}>
                <a href={detailHref(r.id)} onClick={e => linkClick(e, () => onOpen(r.id, { replace: true }))}>
                  <span className="jvm-pd-rel-icon" aria-hidden="true">{r.icon}</span>
                  <span className="jvm-pd-rel-name">{r.name}</span>
                  <span className="jvm-pd-rel-sum">{picked.includes(r.id) ? '已加入' : r.summary}</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="jvm-pd-info" title="信息" className="is-info">
        <dl className="jvm-pd-table">
          {info.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          {runs ? <div className="is-wide"><dt>运行方式</dt><dd>{runs}</dd></div> : null}
        </dl>
        {links.length ? (
          <ul className="jvm-pd-links" aria-label="来源链接">
            {links.map(l => (
              <li key={l.id}><a href={l.href} target="_blank" rel="noreferrer noopener">{l.label}<span aria-hidden="true"> ↗</span></a></li>
            ))}
          </ul>
        ) : null}
      </Section>
    </article>
  ), { mini, foot })
}
