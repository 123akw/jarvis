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
  meeting_start: ['🎙', '开始会议纪要'],
  meeting_stop: ['🎙', '结束会议纪要'],
  sys_query: ['🖥', '系统查询'],
  web_search: ['🔎', '联网搜索'],
  web_extract: ['📄', '读取网页'],
  movie_ratings: ['🎬', '电影评分'],
  esports_scores: ['🏆', '电竞比分'],
  ticket_search: ['🎫', '票务查询'],
  recall_history: ['🗂', '翻聊天记录'],
}

export function toolLabel(name) {
  const info = TOOL_INFO[name]
  return info ? `${info[0]} ${info[1]}` : `⚙ ${name}`
}

/** 芯片上的人话：[进行中, 完成]。克制：一句动作，不带感叹、不报流水账 */
const TOOL_PHRASES = {
  now: ['正在看时间', '看了时间'],
  calc: ['正在算', '算好了'],
  weather: ['正在看天气', '看了天气'],
  weather_here: ['正在看天气', '看了天气'],
  my_location: ['正在确认位置', '确认了位置'],
  coding_status: ['正在看编程进度', '看了编程进度'],
  memo_add: ['正在记下', '记下了'],
  memo_list: ['正在翻备忘', '翻了备忘'],
  memo_del: ['正在删备忘', '删掉了备忘'],
  profile_remember: ['正在记住', '记住了'],
  profile_list: ['正在回想', '回想了一下'],
  profile_forget: ['正在忘掉', '忘掉了'],
  schedule_add: ['正在排日程', '排进日程了'],
  schedule_list: ['正在看日程', '看了日程'],
  schedule_del: ['正在删日程', '删掉了日程'],
  todo_add: ['正在加待办', '加进待办了'],
  todo_list: ['正在看待办', '看了待办'],
  todo_done: ['正在勾待办', '勾掉了待办'],
  meeting_start: ['正在通知桌面端', '通知了桌面端'],
  meeting_stop: ['正在收尾会议记录', '收尾了会议记录'],
  sys_query: ['正在看服务器状态', '看了服务器状态'],
  web_search: ['正在联网搜索', '搜过了'],
  web_extract: ['正在读网页', '读了网页'],
  movie_ratings: ['正在查评分', '查了评分'],
  esports_scores: ['正在查比分', '查了比分'],
  ticket_search: ['正在查票务', '查了票务'],
  recall_history: ['正在翻聊天记录', '翻了聊天记录'],
}

const SEARCHY = new Set(['web_search', 'movie_ratings', 'esports_scores', 'ticket_search'])

/** 工具芯片文案：「⛅ 正在看天气」→「⛅ 看了天气」；搜索类完成时按结果数说「查了 3 个来源」 */
export function toolChipText(chip) {
  const info = TOOL_INFO[chip.name]
  const phrase = TOOL_PHRASES[chip.name]
  if (!info || !phrase) return toolLabel(chip.name)
  if (!chip.done) return `${info[0]} ${phrase[0]}`
  if (chip.ok === false) return `${info[0]} ${info[1]}没成功`
  const count = SEARCHY.has(chip.name) && /结果数：(\d+)/.exec(chip.detail || '')
  if (count) return `${info[0]} ${Number(count[1]) > 0 ? `查了 ${count[1]} 个来源` : '没搜到结果'}`
  return `${info[0]} ${phrase[1]}`
}
