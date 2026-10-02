import { useState } from 'react'
import Icon from '../Icon.jsx'
import { ProfessionTags } from './Recommend.jsx'
import { SearchBox } from './TopBar.jsx'

/*
 * 首屏只有一个焦点（参考 App Store / GPT 商店 / Claude 连接器目录）：一句主张 + 大搜索框。
 * 搜索框同时是「一句话帮我推荐」：
 *  - 打字即时过滤下面的目录；输入像一句话（超过 6 个字或带标点）时，下拉第一行是「✨ 让 AI 按这句推荐一套」，回车即触发；
 *  - 获焦且为空时，下拉给「最近搜索」（最多 5 条，本机 localStorage）和「按行当」8 个职业（2 列）；
 *  - 搜索框下面一行文字建议「试试：个体店主 · 老师 …」，点一下就按这个职业推荐。
 * 下拉用 ↑↓ 移动、回车选中、Esc 收起（焦点一直在输入框里，aria-activedescendant 指向当前项）。
 */

const RECENT_KEY = 'jvm_recent_searches'
const RECENT_MAX = 5

export function loadRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, RECENT_MAX) : []
  } catch { return [] }
}
export function pushRecent(list, q) {
  const text = String(q || '').trim().slice(0, 60)
  if (!text) return list
  const next = [text, ...list.filter(x => x !== text)].slice(0, RECENT_MAX)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* 隐私模式：只在本次生效 */ }
  return next
}
/** 像一句话：超过 6 个字，或带中英文标点 */
export const sentenceLike = q => [...String(q || '').trim()].length > 6 || /[，。？！、；,.?!;]/.test(String(q || '').trim())

export default function Hero({ catalog, query, onQuery, inputRef, formRef, onSubmit, onAsk, profession, onPickProfession, onReopen }) {
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)   // 选过一项 / 按了 Esc：直到再打字之前不再弹
  const [active, setActive] = useState(-1)
  const [recent, setRecent] = useState(loadRecent)
  const q = query.trim()
  const professions = catalog?.professions || []

  const blurInput = () => inputRef.current?.blur()
  const ask = text => { setRecent(r => pushRecent(r, text)); setDismissed(true); onAsk(text) }
  const options = []
  if (q) {
    if (sentenceLike(q)) options.push({ id: 'ask', group: '', icon: '✨', label: '让 AI 按这句推荐一套', run: () => ask(q) })
  } else {
    recent.forEach(r => options.push({ id: `r-${r}`, group: 'recent', icon: null, label: r, run: () => { onQuery(r); setDismissed(true) } }))
    professions.forEach(p => options.push({
      id: `p-${p.id}`, group: 'prof', icon: p.icon, label: p.name, run: () => { setDismissed(true); blurInput(); onPickProfession(p.id) },
    }))
  }
  const open = focused && !dismissed && options.length > 0
  const cur = open && active >= 0 && active < options.length ? active : -1

  function onKeyDown(e) {
    if (e.nativeEvent?.isComposing) return
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault()
      setActive(i => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault()
      setActive(i => (i <= 0 ? options.length - 1 : i - 1))
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      setDismissed(true)
      setActive(-1)
    } else if (e.key === 'Enter') {
      if (cur >= 0) {
        e.preventDefault()
        options[cur].run()
        setActive(-1)
      } else if (q && sentenceLike(q)) {
        e.preventDefault()
        ask(q)
      }
    }
  }
  const submit = () => {
    if (q) setRecent(r => pushRecent(r, q))
    setDismissed(true)
    onSubmit?.()
  }

  const option = (o, i) => (
    <div key={o.id} id={`jvm-sg-${i}`} role="option" aria-selected={cur === i}
      className={`jvm-suggest-opt is-${o.group || 'ask'}${cur === i ? ' is-active' : ''}`}
      onMouseDown={e => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => { o.run(); setActive(-1) }}>
      {o.group === 'recent' ? <Icon name="search" size={15} className="jvm-suggest-icon" /> : <span className="jvm-suggest-emoji" aria-hidden="true">{o.icon}</span>}
      <span className="jvm-suggest-label">{o.label}</span>
      {o.group === '' ? <kbd className="jvm-suggest-key" aria-hidden="true">↵</kbd> : null}
    </div>
  )
  const recentOpts = options.map((o, i) => [o, i]).filter(([o]) => o.group === 'recent')
  const profOpts = options.map((o, i) => [o, i]).filter(([o]) => o.group === 'prof')

  return (
    <section className="jvm-hero" aria-labelledby="jvm-hero-title">
      <h1 id="jvm-hero-title" className="jvm-hero-title" tabIndex={-1}>挑几个插件，<br className="jvm-br" />拼出你的 AI 智能体</h1>
      <p className="jvm-hero-sub">放进工具箱、起个名字，拿到专属账号就能用。</p>
      <div className="jvm-hero-search" ref={formRef}
        onFocus={() => setFocused(true)}
        onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setFocused(false); setDismissed(false); setActive(-1) } }}>
        <SearchBox size="hero" id="jvm-hero-search" value={query} inputRef={inputRef} onSubmit={submit} onKeyDown={onKeyDown}
          onChange={v => { onQuery(v); setDismissed(false); setActive(-1) }}
          inputProps={{
            'aria-controls': open ? 'jvm-suggest' : undefined,
            'aria-activedescendant': cur >= 0 ? `jvm-sg-${cur}` : undefined,
            'aria-autocomplete': 'list',
          }}>
          {open ? (
            <div className="jvm-suggest" id="jvm-suggest" role="listbox" aria-label="搜索建议">
              {options[0]?.group === '' ? option(options[0], 0) : null}
              {recentOpts.length ? (
                <div role="group" aria-label="最近搜索" className="jvm-suggest-group">
                  <p className="jvm-suggest-title" aria-hidden="true">最近搜索</p>
                  {recentOpts.map(([o, i]) => option(o, i))}
                </div>
              ) : null}
              {profOpts.length ? (
                <div role="group" aria-label="按行当推荐" className="jvm-suggest-group">
                  <p className="jvm-suggest-title" aria-hidden="true">按行当推荐</p>
                  <div className="jvm-suggest-grid">{profOpts.map(([o, i]) => option(o, i))}</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </SearchBox>
      </div>
      {professions.length ? (
        <ProfessionTags professions={professions} value={profession} onPick={onPickProfession} onReopen={onReopen} />
      ) : null}
    </section>
  )
}
