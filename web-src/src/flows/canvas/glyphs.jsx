/* 画布专用的线性小图形（24 网格、1.7 描边、currentColor，与 Icon.jsx 同一套笔触）。 */

const PATHS = {
  start: <><circle cx="12" cy="12" r="8.5" /><path d="M10.4 8.6v6.8l5.3-3.4Z" /></>,
  llm: <><path d="M11 3.5 12.6 8 17 9.6l-4.4 1.6L11 15.6 9.4 11.2 5 9.6 9.4 8Z" /><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" /></>,
  tool: <><path d="M9 3.5v4M15 3.5v4" /><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0Z" /><path d="M12 16v4.5" /></>,
  condition: <><path d="M4 12h5" /><path d="M9 12c3.2 0 3.2-5.5 6.8-5.5H20M9 12c3.2 0 3.2 5.5 6.8 5.5H20" /><path d="m17.8 4.5 2.2 2-2.2 2M17.8 15.5l2.2 2-2.2 2" /></>,
  template: <><path d="M4.5 6.5h15M4.5 12h10M4.5 17.5h7" /><path d="M16.5 14.5h3v3h-3z" /></>,
  step: <><path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9Z" /><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" /></>,
  end: <><path d="M6 20.5V4" /><path d="M6 4.5h11l-2.5 4 2.5 4H6" /></>,
  layout: <><rect x="3.5" y="4" width="6" height="5" rx="1.5" /><rect x="14.5" y="4" width="6" height="5" rx="1.5" /><rect x="14.5" y="15" width="6" height="5" rx="1.5" /><path d="M9.5 6.5h5M12 6.5v11h2.5" /></>,
  variable: <><path d="M8.5 4.5c-2 0-2.5 1-2.5 2.5v2.5c0 1-.7 2-2 2.5 1.3.5 2 1.5 2 2.5V17c0 1.5.5 2.5 2.5 2.5M15.5 4.5c2 0 2.5 1 2.5 2.5v2.5c0 1 .7 2 2 2.5-1.3.5-2 1.5-2 2.5V17c0 1.5-.5 2.5-2.5 2.5" /><path d="m10 9.5 4 5M14 9.5l-4 5" /></>,
  play: <><path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" /></>,
  save: <><path d="M5.5 4h10l3 3v11.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5Z" /><path d="M8.5 4v4.5h6V4M8.5 20v-5.5h7V20" /></>,
  warn: <><path d="M12 4 21 19.5H3Z" /><path d="M12 10v4.5M12 17h.01" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.4 3.5 5.4 3.5 8.5s-1 6.1-3.5 8.5c-2.5-2.4-3.5-5.4-3.5-8.5s1-6.1 3.5-8.5Z" /></>,
  grip: <><circle cx="9" cy="7" r=".9" /><circle cx="15" cy="7" r=".9" /><circle cx="9" cy="12" r=".9" /><circle cx="15" cy="12" r=".9" /><circle cx="9" cy="17" r=".9" /><circle cx="15" cy="17" r=".9" /></>,
  up: <><path d="m6.5 14.5 5.5-5.5 5.5 5.5" /></>,
  sys: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  item: <><path d="M5 7h14M5 12h14M5 17h9" /></>,
  down: <><path d="m6.5 9.5 5.5 5.5 5.5-5.5" /></>,
}

export default function Glyph({ name, size = 18, className = '' }) {
  return (
    <svg className={`jv-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] || null}
    </svg>
  )
}

/** 节点图标：目录项带 emoji 就用 emoji，否则用类型图形 */
export function NodeIcon({ type, emoji = '', size = 16 }) {
  return (
    <span className="fc-icon" data-type={type} aria-hidden="true">
      {emoji ? <span className="fc-icon-emoji">{emoji}</span> : <Glyph name={type} size={size} />}
    </span>
  )
}
