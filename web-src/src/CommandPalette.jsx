import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { useDialogFocus, useEscape } from './Modal.jsx'

/** ⌘K 命令面板：所有设置入口 + 最近会话跳转，键盘 ↑↓ 选择、Enter 执行、Esc 关闭。
 *  commands: [{ id, label, hint?, icon, run }]；threads: [{ id, title }] */
export default function CommandPalette({ commands, threads = [], onPickThread, onClose }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const boxRef = useRef(null)
  useEscape(onClose)
  useDialogFocus(boxRef)   // 焦点进搜索框；关闭后还给打开前的控件

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hit = text => !q || String(text || '').toLowerCase().includes(q)
    const cmds = commands
      .filter(c => hit(c.label) || hit(c.hint) || hit(c.keywords))
      .map(c => ({ ...c, key: `c:${c.id}`, group: '操作' }))
    const convs = threads
      .filter(t => q && hit(t.title))
      .slice(0, 6)
      .map(t => ({ key: `t:${t.id}`, id: t.id, label: t.title, icon: 'bubble', group: '对话', run: () => onPickThread(t.id) }))
    // 没输入时把最近的几条会话也列出来，方便直接跳
    const recent = q ? [] : threads.slice(0, 4).map(t => ({
      key: `t:${t.id}`, id: t.id, label: t.title, icon: 'bubble', group: '最近对话', run: () => onPickThread(t.id),
    }))
    return [...cmds, ...convs, ...recent]
  }, [query, commands, threads, onPickThread])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  function run(item) {
    if (!item) return
    onClose()
    item.run()
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (items.length ? (i + 1) % items.length : 0)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (items.length ? (i - 1 + items.length) % items.length : 0)) }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(items[active]) }
  }

  let lastGroup = ''
  return (
    <div className="jv-palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="jv-palette" role="dialog" aria-modal="true" aria-label="命令面板" ref={boxRef} tabIndex={-1}>
        <div className="jv-palette-search">
          <Icon name="search" size={18} />
          <input ref={inputRef} data-autofocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder="搜索对话，或输入要做的事…" aria-label="搜索命令" role="combobox"
            aria-expanded="true" aria-controls="jv-palette-list"
            aria-activedescendant={items[active] ? `pal-${items[active].key}` : undefined} />
          <kbd>esc</kbd>
        </div>
        <ul className="jv-palette-list" id="jv-palette-list" role="listbox" aria-label="命令" ref={listRef}>
          {items.length === 0 && <li className="jv-palette-empty">没有匹配的命令或对话</li>}
          {items.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : ''
            lastGroup = item.group
            return (
              <li key={item.key} role="presentation">
                {head ? <div className="jv-palette-group" role="presentation">{head}</div> : null}
                <div id={`pal-${item.key}`} role="option" aria-selected={i === active}
                  className={`jv-palette-item${i === active ? ' on' : ''}${item.danger ? ' danger' : ''}`}
                  onMouseMove={() => { if (i !== active) setActive(i) }}
                  onClick={() => run(item)}>
                  <span className="pi-icon"><Icon name={item.icon} size={17} /></span>
                  <span className="pi-label">{item.label}</span>
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
