/** 线性图标（24 网格、1.7 描边、currentColor）：替换旧版 ☰ ⏻ 📎 等字符/emoji，
 *  在暗/亮主题、不同系统字体下保持一致的粗细与对齐。 */
const PATHS = {
  sidebar: <><rect x="3" y="4.5" width="18" height="15" rx="3.5" /><path d="M9.5 4.5v15" /></>,
  compose: <><path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12" /><path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12.5 14.3 9 15l.7-3.5Z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  today: <><rect x="3.5" y="5" width="17" height="15.5" rx="3.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  sparkles: <><path d="M11 3.5 12.6 8 17 9.6l-4.4 1.6L11 15.6 9.4 11.2 5 9.6 9.4 8Z" /><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z" /></>,
  sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  desktop: <><rect x="3" y="4" width="18" height="12.5" rx="2.5" /><path d="M8.5 20h7M12 16.5V20" /></>,
  bubble: <><path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4A8 8 0 1 1 20.5 11.5Z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <><path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.3 6.3 0 0 0 10 10Z" /></>,
  logout: <><path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" /></>,
  close: <><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></>,
  clip: <><path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" /></>,
  wave: <><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3" /></>,
  up: <><path d="M12 19V5.5M6 11.5l6-6 6 6" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" /></>,
  download: <><path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></>,
  pencil: <><path d="M15.8 4.2a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></>,
  trash: <><path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12M9.5 7V4.5h5V7" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  chevron: <><path d="m9.5 6 6 6-6 6" /></>,
  sunrise: <><path d="M3 19.5h18M6.5 16a5.5 5.5 0 0 1 11 0M12 3.5v4.5M5 8.5l1.6 1.6M19 8.5l-1.6 1.6" /></>,
  list: <><path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10M4.8 6.5h.01M4.8 12h.01M4.8 17.5h.01" /></>,
  cloud: <><path d="M7.5 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18.3 9a4.75 4.75 0 0 1-.8 9.5Z" /></>,
  note: <><path d="M5.5 4h13v10.5l-5.5 5.5H5.5Z" /><path d="M13 20v-5.5h5.5M8.5 8.5h7M8.5 12h4" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4.5 7.5 7.5 5.5 7.5-5.5" /></>,
  feishu: <><path d="M4 11.5 20 4.5l-4.5 15-4.2-5.6Z" /><path d="m11.3 13.9 4-4.2" /></>,
  // 第十三轮·平台：市场、流程、分享、平台设置、装到主屏指引
  store: <><path d="M4.5 9.5 6 4.5h12l1.5 5" /><path d="M4.5 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0" /><path d="M6 12v7.5h12V12M10 19.5v-4h4v4" /></>,
  flow: <><rect x="3" y="4" width="6.5" height="5" rx="1.8" /><rect x="14.5" y="9.5" width="6.5" height="5" rx="1.8" /><rect x="3" y="15" width="6.5" height="5" rx="1.8" /><path d="M9.5 6.5h1.5a2 2 0 0 1 2 2V12m0 0v3.5a2 2 0 0 1-2 2H9.5M13 12h1.5" /></>,
  share: <><path d="M12 14.5v-11M8 7l4-4 4 4" /><path d="M8.5 10.5H7a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-1.5" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 1.9-1 1.5-2-.5-1.3.3-2.6 1.7-2.6h1.8a3.5 3.5 0 0 0 3.5-3.5c0-4.9-3.8-8.9-8.5-8.9Z" /><circle cx="7.8" cy="11.2" r="1" /><circle cx="10.5" cy="7.4" r="1" /><circle cx="15" cy="7.8" r="1" /></>,
  addbox: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></>,
  more: <><circle cx="12" cy="5.5" r=".9" /><circle cx="12" cy="12" r=".9" /><circle cx="12" cy="18.5" r=".9" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  check: <><path d="m5 12.5 4.5 4.5L19 7.5" /></>,
  undo: <><path d="M9.5 5.5 5 10l4.5 4.5" /><path d="M5 10h9.5a5 5 0 0 1 0 10H11" /></>,
}

export default function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={`jv-icon ${className}`} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      {PATHS[name] || null}
    </svg>
  )
}
