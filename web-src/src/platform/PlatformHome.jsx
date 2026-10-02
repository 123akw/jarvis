import Icon from '../Icon.jsx'
import Presence from '../Presence.jsx'
import { navigate } from '../routes.js'
import { homeChips, homeGreeting, pluginMeta } from './platform.js'
import './platform.css'

const compact = () => typeof matchMedia === 'function' && matchMedia('(max-width:640px)').matches

/** 一条流程的小链：每一步一个插件图标，用细线连起来（呼应流程页的节点 + 连线） */
function FlowChain({ steps, byId }) {
  const list = (Array.isArray(steps) ? steps : []).slice(0, 4)
  return (
    <span className="pf-chain" aria-hidden="true">
      {list.map((s, i) => <span key={s.id || i} className="pf-node">{pluginMeta(s.plugin, byId).icon}</span>)}
    </span>
  )
}

/**
 * 有平台（智能体）的账号的新对话空态：版式与贾维斯的空态相同（光球 · 问候 · 快捷问题），只换内容——
 * 平台问候、平台插件的示例问题；下面多两行：我的工具箱（插件小图标，末尾「添加」去市场）、我的流程（去 /flows）。
 * flows 为 null（还没取到 / 接口失败）时不显示流程那一行。
 */
export default function PlatformHome({ platform, plugins = null, flows = null, onPick }) {
  const chips = homeChips(platform, plugins)
  // 工具箱只摆对话里能用的技能和通道；流程积木（拆分、提炼……）在「我的流程」里出现
  const all = (platform.plugins || []).map(id => pluginMeta(id, plugins))
  const tools = all.some(t => t.kind !== 'step') ? all.filter(t => t.kind !== 'step') : all
  const sub = platform.tagline || '说一句话，剩下的交给我'
  return (
    <div className="chat-empty pf-home">
      <div className="jv-presence-slot pf-orb">
        <Presence state="idle" size={compact() ? 104 : 128} quality="css" decorative />
      </div>
      <h1 className="ce-title">{homeGreeting(platform)}</h1>
      <p className="ce-sub">{sub}</p>
      {chips.length ? (
        <div className="ce-chips">
          {chips.map(c => (
            <button key={c.text} type="button" className="ce-chip" onClick={() => onPick(c.text)}>
              <span className="ce-ico pf-emoji" aria-hidden="true">{c.icon || platform.icon || '✨'}</span>
              <span className="ce-text">
                <span className="ce-q">{c.text}</span>
                {c.hint ? <span className="ce-hint">{c.hint}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="pf-rows">
        <section className="pf-row" aria-label="我的工具箱">
          <span className="pf-row-label">我的工具箱</span>
          <div className="pf-row-items">
            {tools.map(t => (
              <span key={t.id} className="pf-tool" title={t.name} role="img" aria-label={t.name}>{t.icon}</span>
            ))}
            <button type="button" className="pf-add" onClick={() => navigate('/market')} aria-label="添加插件">
              <Icon name="plus" size={14} />添加
            </button>
          </div>
        </section>
        {Array.isArray(flows) ? (
          <section className="pf-row" aria-label="我的流程">
            <span className="pf-row-label">我的流程</span>
            <div className="pf-row-items">
              {flows.slice(0, 3).map(f => (
                <button key={f.id} type="button" className="pf-flow" onClick={() => navigate('/flows')}
                  title={f.summary || f.name}>
                  <FlowChain steps={f.steps} byId={plugins} />
                  <span className="pf-flow-name">{f.name}</span>
                </button>
              ))}
              <button type="button" className="pf-add" onClick={() => navigate('/flows')}>
                {flows.length ? <>全部<Icon name="chevron" size={13} /></> : <><Icon name="flow" size={14} />拼一个流程</>}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
