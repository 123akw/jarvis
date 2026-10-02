import { useEffect } from 'react'

/** 进场动画方案「rings」：占位实现，由对应代理替换。契约见 ../registry.js。 */
export default function Intro({ onDone }) {
  useEffect(() => { onDone() }, [onDone])
  return null
}
