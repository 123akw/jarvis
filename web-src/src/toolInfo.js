/** 工具 → 中文友好名与图标（desktop/renderer.js 内有同步的注入版副本） */
const TOOL_INFO = {
  now: ['🕐', '当前时间'],
  calc: ['🧮', '计算'],
  weather: ['⛅', '城市天气'],
  weather_here: ['📍', '本地天气'],
  my_location: ['📍', '我的位置'],
  coding_status: ['⌨️', '编程进度'],
  memo_add: ['📝', '记备忘'],
  memo_list: ['📝', '查备忘'],
  memo_del: ['📝', '删备忘'],
  profile_remember: ['◉', '记住画像'],
  profile_list: ['◉', '查画像'],
  profile_forget: ['◉', '忘记画像'],
  schedule_add: ['📅', '加日程'],
  schedule_list: ['📅', '查日程'],
  schedule_del: ['📅', '删日程'],
  todo_add: ['☑️', '加待办'],
  todo_list: ['☑️', '查待办'],
  todo_done: ['☑️', '完成待办'],
  sys_query: ['🖥', '系统查询'],
  web_search: ['🔎', '联网搜索'],
  web_extract: ['📄', '读取网页'],
  movie_ratings: ['🎬', '电影评分'],
  esports_scores: ['🏆', '电竞比分'],
  ticket_search: ['🎫', '票务查询'],
}

export function toolLabel(name) {
  const info = TOOL_INFO[name]
  return info ? `${info[0]} ${info[1]}` : `⚙ ${name}`
}
