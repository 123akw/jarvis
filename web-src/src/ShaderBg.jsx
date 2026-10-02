/**
 * 登录页的柔和背景光（沿用 ShaderBg 这个名字，实现换成零依赖的 CSS 光场）。
 *
 * 旧版是 three.js 全屏极光着色器，登录页首屏因此要拉 950KB 的 three；现在：
 *  - 两团静态光场画进背景（只栅格化一次），
 *  - 光球身后一团主光缓慢漂移/呼吸（transform 关键帧，合成线程，主线程零开销），
 *  - 一层静态细颗粒压住暗色渐变的色带。
 * MOSS 形态仍用 three 极光（Aurora.jsx，随 Moss.jsx 懒加载）。样式在 Login.css。
 */
export default function ShaderBg({ className = '' }) {
  return (
    <div className={`jvl-ambient${className ? ` ${className}` : ''}`} aria-hidden="true">
      <i className="jvl-key-light" />
      <i className="jvl-grain" />
    </div>
  )
}
