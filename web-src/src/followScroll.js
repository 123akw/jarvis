import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* 对话区「贴底跟随」：流式输出时视口跟着最新内容走，用户一往上翻就立刻松手。
 *
 * 旧版按「离底 <80px」判断要不要跟随：流式时每帧都有新内容，用户手指还没拖出 80px，
 * 下一帧就被 scrollTop=scrollHeight 拽回底部——手机上就是「一直抖、上不去」。现在：
 *  - 用户意图看输入：手指往下拖 / 滚轮往上 / PageUp·↑·Home → 立刻停止跟随；
 *  - 用户自己滚回底部（离底 ≤STICK_PX）→ 恢复跟随；
 *  - 手指还在屏上、或惯性滚动没停时一律不写 scrollTop（iOS 上程序写 scrollTop 会掐断惯性、
 *    画面来回跳），停稳后再补一次；
 *  - 自己写 scrollTop 引起的 scroll、内容变矮时浏览器夹紧 scrollTop 引起的 scroll，都不算用户滚动。 */
export const STICK_PX = 24      // 用户滚到离底部这么近，恢复跟随
export const SETTLE_MS = 180    // 最后一次触摸/滚轮/用户滚动之后这么久没动静，才算停稳（惯性结束）
export const AWAY_PX = 240      // 不跟随且离底超过这么多，才露出「回到底部」
const DRAG_PX = 4               // 手指往下拖超过这么多（且以竖向为主）才算「往上翻」
const UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const editable = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

export function useFollowScroll(logRef) {
  const follow = useRef(true)
  const touch = useRef(null)        // 手指在屏上：{ x, y } 为参照点；不在屏上为 null
  const userAt = useRef(-Infinity)  // 最近一次用户输入或用户滚动
  const progTop = useRef(null)      // 刚由程序写入的 scrollTop
  const last = useRef({ top: 0, height: 0 })
  const retry = useRef(0)
  const awayRef = useRef(false)
  const [away, setAway] = useState(false)

  const refreshAway = useCallback(() => {
    const el = logRef.current
    if (!el) return
    const next = !follow.current && el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX
    if (next !== awayRef.current) { awayRef.current = next; setAway(next) }
  }, [logRef])

  const stick = useCallback(() => {
    const el = logRef.current
    if (!el || !follow.current) return
    if (touch.current || now() - userAt.current < SETTLE_MS) {   // 用户手还在、惯性没停：停稳后补一次
      clearTimeout(retry.current)
      retry.current = setTimeout(stick, SETTLE_MS)
      return
    }
    const max = el.scrollHeight - el.clientHeight
    if (el.scrollTop >= max - 1) return
    el.scrollTop = max
    progTop.current = el.scrollTop
    last.current = { top: el.scrollTop, height: el.scrollHeight }
  }, [logRef])

  const release = useCallback(() => {
    follow.current = false
    clearTimeout(retry.current)
  }, [])

  /** 内容变了（新消息、流式 token、图片/代码高亮落地）：跟随中就贴底，否则只更新「回到底部」 */
  const onContent = useCallback(() => { stick(); refreshAway() }, [stick, refreshAway])

  /** 自己发消息 / 切换会话：总是回到跟随 */
  const reset = useCallback(() => {
    follow.current = true
    touch.current = null
    userAt.current = -Infinity
  }, [])

  /** 「回到底部」：立即贴底并恢复跟随 */
  const jump = useCallback(() => {
    reset()
    stick()
    refreshAway()
  }, [reset, stick, refreshAway])

  useEffect(() => {   // 键盘翻页：点过对话区后按键落在 body 上而不是对话区，挂在 window 上听
    function onKey(e) {
      if (!SCROLL_KEYS.has(e.key) || editable(e.target)) return
      if (e.target !== document.body && !logRef.current?.contains(e.target)) return
      userAt.current = now()
      if (UP_KEYS.has(e.key)) release()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(retry.current) }
  }, [logRef, release])

  const handlers = useMemo(() => {
    function onTouchEnd(e) {
      if (e.touches.length) return
      touch.current = null
      userAt.current = now()
      stick()   // 手指离开时如果仍在跟随，惯性停稳后补一次贴底
    }
    return {
      onScroll() {
        const el = logRef.current
        if (!el) return
        const top = el.scrollTop
        const height = el.scrollHeight
        const max = height - el.clientHeight
        const prog = progTop.current !== null && Math.abs(top - progTop.current) < 2
        progTop.current = null
        // 内容变矮被夹紧（或滚动锚定把 scrollTop 往回调）不是用户在翻
        if (!prog && !(height < last.current.height && top < last.current.top)) {
          userAt.current = now()
          const up = top < last.current.top - 0.5
          if (up && top < max - 1) release()                           // 往上翻（越过底部后的回弹不算）
          else if (!up && max - top <= STICK_PX) follow.current = true // 自己滚回了底部
        }
        last.current = { top, height }
        refreshAway()
      },
      onTouchStart(e) {
        const t = e.touches[0]
        touch.current = t ? { x: t.clientX, y: t.clientY } : null
        userAt.current = now()
      },
      onTouchMove(e) {
        const t = e.touches[0]
        const ref = touch.current
        userAt.current = now()
        if (!t || !ref) return
        const dy = t.clientY - ref.y
        if (dy > DRAG_PX && dy > Math.abs(t.clientX - ref.x)) release()   // 手指往下拖 = 往上翻
        if (dy < 0) touch.current = { x: t.clientX, y: t.clientY }        // 参照点跟着往上走，回头往下拖也能及时识别
      },
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      onWheel(e) {
        userAt.current = now()
        if (e.deltaY < 0) release()
      },
    }
  }, [logRef, release, refreshAway, stick])

  return { handlers, onContent, reset, jump, release, away }
}
