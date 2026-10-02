import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import { useDialogFocus, useEscape } from '../Modal.jsx'
import { toolLabel } from '../toolInfo.js'
import { detailHref, linkClick } from './PluginCard.jsx'
import {
  KIND_LABEL, SOURCE_LABEL, abilitiesOf, blockReason, relatedPlugins, requireHelp, requireText, shortRef, sourceLink, sourceOf,
} from './model.js'
import './detail.css'

/* 插件详情（第十七轮「少即是多」，参考 App Store 条目页 / ChatGPT GPT 详情 / Claude 连接器详情）：
 * 一屏讲清三件事——这是什么（头部）、能帮我做什么（前 3 条）、要不要配置（信息条「设置」+ 需要什么）；
 * 其余下移或折叠：介绍「更多」、能力「全部」、「信息」折叠表（含来源链接）、同类推荐在最底。
 * 主按钮「加入工具箱」在头部；头部滚出视野后，顶栏浮出小图标 + 名字 + 小按钮（同 App Store 的导航栏「获取」）。
 * 地址带 ?plugin=<id>，可分享、可后退；手机底部整页抽屉，宽屏右侧抽屉；Esc 关闭、焦点陷阱。 */

const ABILITY_PREVIEW = 3
const EXAMPLE_MAX = 4
const DESC_CLAMP = 80   // 超过这么多字（或有换行）才给「更多」

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

/** 「需要什么」：前置条件、MCP 联网主机、管理员配置、目录给的权限声明（技能的「不运行代码」放进「信息」表） */
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

/** 信息条里的「设置」：一眼看出要不要配置 */
export function setupOf(p) {
  if (p.status === 'unavailable') return { text: '暂不可用', tone: 'warn' }
  if (p.status === 'needs_config') return { text: '需要配置', tone: 'warn' }
  const reqs = p.requires.filter(id => id !== 'files')
  if (reqs.length) return { text: reqs.includes('feishu_bound') ? '需要绑定' : '需要设置', tone: 'warn' }
  if (p.config.some(c => c.configured === true)) return { text: '已配置好', tone: 'ok' }
  return { text: '开箱即用', tone: 'ok' }
}

function powerOf(p) {
  if (p.kind === 'skill') return '1 套方法'
  if (p.kind === 'step') return '拼进流程'
  if (p.tools.length) return `${p.tools.length} 个工具`
  return p.kind === 'mcp' ? '远程工具' : '—'
}

/** 加入 / 移出工具箱：已加入的可以移出；不可用 / 需要配置时禁用（已在工具箱里的仍可移出） */
function AddToBox({ plugin, picked, onToggle, mini = false }) {
  const blocked = blockReason(plugin)
  return (
    <button type="button" className={`jvm-pd-add${picked ? ' is-on' : ''}${mini ? ' is-mini' : ''}`} aria-pressed={picked}
      disabled={!!blocked && !picked} title={blocked && !picked ? blocked : undefined}
      aria-label={picked ? `移出工具箱：${plugin.name}` : `加入工具箱：${plugin.name}`} onClick={() => onToggle(plugin.id)}>
      <Icon name={picked ? 'check' : 'plus'} size={mini ? 14 : 16} />
      <span>{picked ? '已加入' : mini ? '加入' : '加入工具箱'}</span>
    </button>
  )
}

/** 「试试这样问」的一枚 chip：点一下复制；右侧小钮带去「帮我推荐」 */
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
    <li className={`jvm-pd-chip${state ? ` is-${state}` : ''}`}>
      <button type="button" className="jvm-pd-chip-text" onClick={copy} aria-label={`复制：${text}`}>
        <span className="jvm-pd-chip-q">{text}</span>
        <span className="jvm-pd-chip-state" aria-live="polite">
          {state === 'ok' ? <><Icon name="check" size={13} />已复制</> : state === 'fail' ? '没复制成功' : null}
        </span>
      </button>
      {onAsk ? (
        <button type="button" className="jvm-pd-chip-ask" onClick={() => onAsk(text)} aria-label={`带去推荐：${text}`} title="带去「帮我推荐」">
          <Icon name="sparkles" size={14} />
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

/** 头部滚出视野 → 顶栏浮出小标题与小按钮（没有 IntersectionObserver 的环境就一直不浮出） */
function useStuck(targetRef, rootRef, key) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = targetRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { root: rootRef.current, threshold: 0, rootMargin: '-8px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [targetRef, rootRef, key])
  return stuck
}

export default function PluginDetail({ catalog, pluginId, picked, onToggle, onOpen, onClose, onAskAI, authed, toolboxCount = 0 }) {
  const ref = useRef(null)
  const scrollRef = useRef(null)
  const titleRef = useRef(null)
  const actRef = useRef(null)
  const [allAbilities, setAllAbilities] = useState(false)
  const [descOpen, setDescOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  useEscape(onClose)
  useDialogFocus(ref)
  const p = catalog.plugins.find(x => x.id === pluginId) || null
  const stuck = useStuck(actRef, scrollRef, p?.id)
  // 切到同类推荐里的另一个插件：回到顶部、折叠复位，焦点落到新标题上
  const first = useRef(true)
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 })
    setAllAbilities(false); setDescOpen(false); setInfoOpen(false)
    if (first.current) { first.current = false; return }
    titleRef.current?.focus({ preventScroll: true })
  }, [pluginId])

  const shell = (label, children, mini = null) => (
    <div className="jvm-pd-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="jvm-pd" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className={`jvm-pd-bar${mini ? ' is-stuck' : ''}`}>
          <span className="jvm-pd-grab" aria-hidden="true" />
          {mini}
          <button type="button" className="jvm-pd-close" onClick={onClose} aria-label="关闭详情">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="jvm-pd-scroll" ref={scrollRef}>{children}</div>
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
  const setup = setupOf(p)
  const related = relatedPlugins(catalog.plugins, p)
  const link = sourceLink(p)
  const author = p.author || (p.builtin ? 'JWS-Agent' : '社区作者')
  const desc = p.description && p.description !== p.summary ? p.description : ''
  const descLong = desc.length > DESC_CLAMP || desc.includes('\n')
  const license = p.license || (p.builtin ? '随平台' : '未声明')
  const strip = [
    ['类型', KIND_LABEL[p.kind], ''],
    ['能力', powerOf(p), ''],
    ['设置', setup.text, setup.tone],
    ['价格', p.tier === 'pro' ? '专业版' : '免费', ''],
  ]
  const runs = p.kind === 'skill' ? '一段做事说明书：不运行代码、不读你的文件、不联网'
    : !p.builtin ? '在独立子进程里运行，不带任何密钥' : ''
  const info = [
    ['提供者', author],
    ['来源', SOURCE_LABEL[src]],
    ['分类', catName],
    ['类型', KIND_LABEL[p.kind]],
    ['版本', p.version ? `v${p.version}` : '—'],
    ['许可证', license],
    ['价格', p.tier === 'pro' ? '专业版' : '免费'],
    runs ? ['运行方式', runs] : null,
  ].filter(Boolean)
  const links = [
    link ? { id: 'src', label: `源代码${p.source?.ref ? ` @${shortRef(p.source.ref)}` : ''}`, href: link } : null,
    p.homepage && p.homepage !== link && /^https?:\/\//.test(p.homepage) ? { id: 'home', label: '主页', href: p.homepage } : null,
    p.privacyUrl ? { id: 'privacy', label: '隐私政策', href: p.privacyUrl } : null,
  ].filter(Boolean)
  const peek = [SOURCE_LABEL[src], p.version ? `v${p.version}` : '', license].filter(Boolean).join(' · ')

  const mini = stuck ? (
    <div className="jvm-pd-mini">
      <span className="jvm-pd-mini-icon" aria-hidden="true">{p.icon}</span>
      <span className="jvm-pd-mini-name" aria-hidden="true">{p.name}</span>
      <AddToBox plugin={p} picked={isPicked} onToggle={onToggle} mini />
    </div>
  ) : null

  return shell(`插件详情：${p.name}`, (
    <article className="jvm-pd-body" key={p.id}>
      <header className="jvm-pd-head">
        <span className="jvm-pd-icon" aria-hidden="true">{p.icon}</span>
        <div className="jvm-pd-titles">
          <h2 id="jvm-detail-title" ref={titleRef} tabIndex={-1}>{p.name}</h2>
          {p.summary ? <p className="jvm-pd-summary">{p.summary}</p> : null}
          <p className="jvm-pd-by">
            <span>{author}</span>
            <span className={`jvm-pd-src is-${src}`}>{src === 'official' ? <Icon name="check" size={11} /> : null}{SOURCE_LABEL[src]}</span>
          </p>
          <div className="jvm-pd-act" ref={actRef}>
            <AddToBox plugin={p} picked={isPicked} onToggle={onToggle} />
            {isPicked ? <span className="jvm-pd-act-note">工具箱里共 {toolboxCount} 个</span> : null}
          </div>
        </div>
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
        {strip.map(([k, v, tone]) => <div key={k} className={tone ? `is-${tone}` : undefined}><dt>{k}</dt><dd>{v}</dd></div>)}
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
                <span className="jvm-pd-list-icon" aria-hidden="true">{a.icon || '•'}</span>
                <span>{a.text}{a.detail && !a.text.includes(a.detail) ? <small>{a.detail}</small> : null}</span>
              </li>
            ))}
          </ul>
        ) : <p className="jvm-pd-muted">{p.summary || '装上后，智能体会在合适的时候用它。'}</p>}
      </Section>

      {needs.length ? (
        <Section id="jvm-pd-needs" title="需要什么">
          <ul className="jvm-pd-list is-needs">
            {needs.map(n => (
              <li key={n.id} className={`is-${n.tone}`}>
                <span className="jvm-pd-dot" aria-hidden="true" />
                <span><b>{n.title}</b>{n.help ? <small>{n.help}</small> : null}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.examples.length ? (
        <Section id="jvm-pd-try" title="试试这样问" aside={<span className="jvm-pd-hint">点一下复制</span>}>
          <ul className="jvm-pd-chips">{p.examples.slice(0, EXAMPLE_MAX).map(ex => <Example key={ex} text={ex} onAsk={onAskAI} />)}</ul>
        </Section>
      ) : null}

      <section className={`jvm-pd-info${infoOpen ? ' is-open' : ''}`} aria-labelledby="jvm-pd-info-h">
        <h3 id="jvm-pd-info-h">
          <button type="button" aria-expanded={infoOpen} aria-controls="jvm-pd-info-body" onClick={() => setInfoOpen(o => !o)}>
            <span className="jvm-pd-info-title">信息</span>
            <span className="jvm-pd-info-peek">{peek}</span>
            <Icon name="chevron" size={15} />
          </button>
        </h3>
        <div id="jvm-pd-info-body" hidden={!infoOpen}>
          <dl className="jvm-pd-table">
            {info.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </div>
        {links.length ? (
          <ul className="jvm-pd-links" aria-label="来源链接">
            {links.map(l => (
              <li key={l.id}><a href={l.href} target="_blank" rel="noreferrer noopener">{l.label}<span aria-hidden="true"> ↗</span></a></li>
            ))}
          </ul>
        ) : null}
      </section>

      {related.length ? (
        <Section id="jvm-pd-related" title="同类推荐" className="is-related">
          <ul className="jvm-pd-related">
            {related.map(r => (
              <li key={r.id}>
                <a href={detailHref(r.id)} onClick={e => linkClick(e, () => onOpen(r.id, { replace: true }))}>
                  <span className="jvm-pd-rel-icon" aria-hidden="true">{r.icon}</span>
                  <span className="jvm-pd-rel-name">{r.name}</span>
                  <span className="jvm-pd-rel-sum">{r.summary}</span>
                </a>
                {picked.includes(r.id) ? <span className="jvm-pd-rel-in">已加入</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  ), mini)
}
