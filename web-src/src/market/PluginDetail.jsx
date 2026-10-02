import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard.js'
import Icon from '../Icon.jsx'
import { useDialogFocus, useEscape } from '../Modal.jsx'
import { toolLabel } from '../toolInfo.js'
import { AddButton, Badges, detailHref, linkClick } from './PluginCard.jsx'
import {
  KIND_LABEL, SOURCE_LABEL, abilitiesOf, blockReason, relatedPlugins, requireHelp, requireText, shortRef, sourceLink, sourceOf,
} from './model.js'

/* 插件详情（像 App Store / Codex 的条目页）：地址带 ?plugin=<id>，可分享、可后退。
 * 手机上是从底部升起的整页抽屉，宽屏是右侧抽屉。主按钮「加入工具箱」常驻底部。 */

/** 工具名 → 人话：前端收录的用中文名，没收录的用工具自带的说明，再不行才露出工具名 */
function toolText(t) {
  const label = toolLabel(t.name)
  if (!label.startsWith('⚙ ')) return label
  return t.description ? `🔧 ${t.description}` : `🔧 ${t.name}`
}

/** 「需要什么」：前置条件、MCP 联网主机、管理员配置、目录给的权限声明 */
function needsOf(p) {
  const out = p.requires.map(id => ({ id: `req-${id}`, title: requireText(id), help: requireHelp(id), tone: 'warn' }))
  p.hosts.forEach(h => out.push({ id: `host-${h}`, title: `联网：${h}`, help: '用到这个插件时，请求会发到这个外部服务；返回的内容只当参考资料。', tone: 'info' }))
  p.config.forEach(c => out.push({
    id: `cfg-${c.key}`, title: `${c.required ? '需要' : '可选'}配置：${c.label}`,
    help: c.configured === true ? '管理员已经配置好了。' : c.help || '由管理员在「插件管理」里填写，密钥加密保存、不会显示给别人。',
    tone: c.configured === true ? 'ok' : 'warn',
  }))
  if (!p.config.length && p.configMissing.length) {
    out.push({ id: 'cfg-missing', title: `需要配置：${p.configMissing.join('、')}`, help: '由管理员在「插件管理」里填写后才能用。', tone: 'warn' })
  }
  p.permissions.forEach(x => out.push({ id: `perm-${x.key}`, title: x.label, help: '', tone: x.level === 'warn' ? 'warn' : 'info' }))
  if (p.kind === 'skill' && !p.permissions.length) {
    out.push({ id: 'skill', title: '只加做事方法，不运行代码', help: '技能是一段说明书，按外部资料对待，不能读你的文件、也不联网。', tone: 'ok' })
  }
  return out
}

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
    <li className="jvm-ex">
      <button type="button" className="jvm-ex-text" onClick={copy} aria-label={`复制：${text}`}>
        <span>“{text}”</span>
        <span className={`jvm-ex-state${state ? ` is-${state}` : ''}`} aria-live="polite">
          {state === 'ok' ? <><Icon name="check" size={13} />已复制</> : state === 'fail' ? '没复制成功' : <Icon name="copy" size={14} />}
        </span>
      </button>
      {onAsk ? (
        <button type="button" className="jvm-ex-ask" onClick={() => onAsk(text)} aria-label={`带去推荐：${text}`} title="带去「帮我推荐」">
          <Icon name="sparkles" size={14} />
        </button>
      ) : null}
    </li>
  )
}

function Section({ id, title, children, aside = null }) {
  return (
    <section className="jvm-d-sec" aria-labelledby={id}>
      <header className="jvm-d-sec-head"><h3 id={id}>{title}</h3>{aside}</header>
      {children}
    </section>
  )
}

export default function PluginDetail({ catalog, pluginId, picked, onToggle, onOpen, onClose, onAskAI, authed, toolboxCount = 0 }) {
  const ref = useRef(null)
  const scrollRef = useRef(null)
  const titleRef = useRef(null)
  useEscape(onClose)
  useDialogFocus(ref)
  const p = catalog.plugins.find(x => x.id === pluginId) || null
  // 切到同类推荐里的另一个插件：回到顶部，焦点落到新标题上
  const first = useRef(true)
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 })
    if (first.current) { first.current = false; return }
    titleRef.current?.focus({ preventScroll: true })
  }, [pluginId])

  const shell = (label, children, foot = null) => (
    <div className="jvm-detail-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="jvm-detail" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className="jvm-detail-bar">
          <span className="jvm-detail-grab" aria-hidden="true" />
          <button type="button" className="jvm-detail-close" onClick={onClose} aria-label="关闭详情">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="jvm-detail-scroll" ref={scrollRef}>{children}</div>
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
  const abilities = abilitiesOf(p, toolText)
  const needs = needsOf(p)
  const related = relatedPlugins(catalog.plugins, p)
  const link = sourceLink(p)
  const power = p.kind === 'skill' ? '1 套方法' : p.kind === 'step' ? '流程积木'
    : p.tools.length ? `${p.tools.length} 个工具` : p.kind === 'mcp' ? '远程工具' : '—'
  const facts = [
    ['来源', SOURCE_LABEL[src]],
    ['类型', KIND_LABEL[p.kind]],
    ['能力', power],
    ['分类', catName],
    ['版本', p.version ? `v${p.version}` : '—'],
    ['许可证', p.license || (p.builtin ? '随平台' : '未声明')],
    ['价格', p.tier === 'pro' ? '专业版' : '免费'],
  ]
  const author = p.author || (p.builtin ? 'JWS-Agent' : '社区作者')

  const foot = (
    <div className="jvm-detail-foot">
      <div className="jvm-detail-foot-text">
        {blocked ? <span className="is-warn">{p.status === 'needs_config' ? '需要管理员配置后才能加入' : '暂时不能加入'}</span>
          : <span>{isPicked ? '已在工具箱，生成时一起装上' : '加入后，生成的智能体就会用它'}</span>}
        <span className="jvm-detail-foot-n">工具箱 {toolboxCount} 个</span>
      </div>
      <AddButton plugin={p} picked={isPicked} onToggle={onToggle} size="lg" label="加入工具箱" />
    </div>
  )

  return shell(`插件详情：${p.name}`, (
    <article className="jvm-d" key={p.id}>
      <header className="jvm-d-hero">
        <span className="jvm-d-icon" aria-hidden="true">{p.icon}</span>
        <div className="jvm-d-titles">
          <h2 id="jvm-detail-title" ref={titleRef} tabIndex={-1}>{p.name}</h2>
          {p.summary ? <p className="jvm-d-summary">{p.summary}</p> : null}
          <p className="jvm-d-by">{author}{p.version ? ` · v${p.version}` : ''}</p>
          <Badges plugin={p} />
        </div>
      </header>

      {blocked ? (
        <p className="jvm-d-alert" role="note">
          <b>{p.status === 'needs_config' ? '需要配置' : '暂不可用'}</b>
          {p.status === 'needs_config'
            ? `${blocked}${p.configMissing.length ? `（缺：${p.configMissing.join('、')}）` : ''}。管理员在「插件管理」里填好后就能加入。`
            : `${blocked}。`}
        </p>
      ) : authed && !p.available ? (
        <p className="jvm-d-alert is-soft" role="note"><b>当前账号暂不可用</b>{p.requires.map(requireText).join('、') || '前置条件没满足'}，生成的新账号按它自己的设置算。</p>
      ) : null}

      <dl className="jvm-d-facts" aria-label="基本信息">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>

      {p.description && p.description !== p.summary ? (
        <Section id="jvm-d-about" title="介绍"><p className="jvm-d-text">{p.description}</p></Section>
      ) : null}

      <Section id="jvm-d-can" title="它能做什么">
        {abilities.length ? (
          <ul className="jvm-d-abilities">
            {abilities.map(a => (
              <li key={a.id}>
                {a.icon ? <span className="jvm-d-ab-icon" aria-hidden="true">{a.icon}</span> : null}
                <span>{a.text}{a.detail && !a.text.includes(a.detail) ? <small>{a.detail}</small> : null}</span>
              </li>
            ))}
          </ul>
        ) : <p className="jvm-d-text is-muted">{p.summary || '装上后，智能体会在合适的时候用它。'}</p>}
      </Section>

      {p.examples.length ? (
        <Section id="jvm-d-try" title="试试这样问" aside={<span className="jvm-d-hint">点一下复制</span>}>
          <ul className="jvm-d-examples">{p.examples.slice(0, 3).map(ex => <Example key={ex} text={ex} onAsk={onAskAI} />)}</ul>
        </Section>
      ) : null}

      <Section id="jvm-d-needs" title="需要什么">
        {needs.length ? (
          <ul className="jvm-d-needs">
            {needs.map(n => (
              <li key={n.id} className={`is-${n.tone}`}>
                <span className="jvm-d-need-dot" aria-hidden="true" />
                <span><b>{n.title}</b>{n.help ? <small>{n.help}</small> : null}</span>
              </li>
            ))}
          </ul>
        ) : <p className="jvm-d-text is-muted">开箱即用，不需要额外设置。</p>}
      </Section>

      {link || p.homepage || p.privacyUrl || !p.builtin ? (
        <Section id="jvm-d-src" title="来源">
          <ul className="jvm-d-links">
            {link ? <li><a href={link} target="_blank" rel="noreferrer noopener">源代码{p.source?.ref ? ` @${shortRef(p.source.ref)}` : ''}</a></li> : null}
            {p.homepage && p.homepage !== link ? <li><a href={p.homepage} target="_blank" rel="noreferrer noopener">主页</a></li> : null}
            {p.privacyUrl ? <li><a href={p.privacyUrl} target="_blank" rel="noreferrer noopener">隐私政策</a></li> : null}
            {!p.builtin ? <li className="is-muted">社区插件在独立子进程里运行，不带任何密钥。</li> : null}
          </ul>
        </Section>
      ) : null}

      {related.length ? (
        <Section id="jvm-d-related" title="同类推荐">
          <ul className="jvm-d-related">
            {related.map(r => (
              <li key={r.id}>
                <a href={detailHref(r.id)} onClick={e => linkClick(e, () => onOpen(r.id, { replace: true }))}>
                  <span className="jvm-d-rel-icon" aria-hidden="true">{r.icon}</span>
                  <span className="jvm-d-rel-name">{r.name}</span>
                  <span className="jvm-d-rel-sum">{r.summary}</span>
                </a>
                {picked.includes(r.id) ? <span className="jvm-d-rel-in">已加入</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  ), foot)
}
