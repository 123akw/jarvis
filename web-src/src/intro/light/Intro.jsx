import { useEffect, useRef, useState } from 'react'
import { createGlow } from './glow.js'
import { DONE_MS, REDUCED_MS, sample } from './timeline.js'
import './light.css'

/** 进场动画方案「light / 光幕」：Apple Intelligence 式边缘流光 + 电影感大字。契约见 ../registry.js，分镜见 ./timeline.js。
 *  流光与光球由一个 WebGL 片元着色器绘制（JS 每帧只写十几个 uniform）；大字全部是 CSS 合成动画
 *  （transform / opacity / filter），主线程再忙也不掉帧。没有 WebGL 时退到 CSS 内发光；减弱动态时只做 600ms 淡入。 */

const TEXT = '你好，我是贾维斯。'
const NAME_FROM = 5   // 「贾维斯」三个字走 AI 渐变

function prefersReduced() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 读登录页光球的位置（只读一次布局，不逐帧读）。光球在做入场缩放，中心不受影响，半径取未变换的 offsetWidth。 */
export function measure() {
  const w = window.innerWidth
  const h = window.innerHeight
  const L = { w, h, tx: w / 2, ty: h / 2, r: 0, light: document.body.classList.contains('light') }
  const el = document.querySelector('.jvl-orb')
  if (el) {
    const b = el.getBoundingClientRect()
    if (b.width > 0) Object.assign(L, { tx: b.left + b.width / 2, ty: b.top + b.height / 2, r: el.offsetWidth / 2 })
  }
  return L
}

export default function Intro({ onDone }) {
  const [reduced] = useState(prefersReduced)
  const root = useRef(null)
  const canvas = useRef(null)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const timer = setTimeout(() => done.current?.(), reduced ? REDUCED_MS : DONE_MS)
    if (reduced) return () => clearTimeout(timer)
    const glow = createGlow(canvas.current)
    let L = measure()
    let raf = 0
    let t0 = 0
    let remeasured = false
    const fit = () => { L = measure(); glow?.size(L.w, L.h) }
    const frame = now => {
      if (!t0) t0 = now
      const t = (now - t0) / 1000
      // 收拢前再量一次：登录页此时已挂好、入场动画也走完了；同时确定主题（亮色主题收尾时黑幕退场）
      if (!remeasured && t > 1.9) {
        remeasured = true
        fit()
        root.current?.classList.toggle('is-light', L.light)
      }
      if (glow.draw(t, sample(t, L), L)) raf = requestAnimationFrame(frame)
      else root.current?.classList.add('no-gl')   // 着色器编译失败：停画，退到 CSS 兜底
    }
    if (glow) {
      glow.size(L.w, L.h)
      raf = requestAnimationFrame(frame)
    } else {
      root.current?.classList.add('no-gl')
    }
    window.addEventListener('resize', fit)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
      glow?.dispose()
    }
  }, [reduced])

  return (
    <div ref={root} className={`jvi${reduced ? ' is-reduced' : ''}`}>
      <i className="jvi-bg" />
      <i className="jvi-amb" />
      {!reduced && <canvas ref={canvas} className="jvi-gl" />}
      <i className="jvi-fb" />
      <div className="jvi-line">
        {[...TEXT].map((ch, i) => (
          <span key={i} style={{ '--i': i, '--k': i - NAME_FROM }}
            className={`jvi-ch${i >= NAME_FROM && i < NAME_FROM + 3 ? ' is-name' : ''}${'，。'.includes(ch) ? ' is-punc' : ''}`}>
            {ch}
          </span>
        ))}
      </div>
    </div>
  )
}
