// Orbitron 只剩字标（顶栏 / 抽屉里的 J.A.R.V.I.S.，700 字重）在用；正文与等宽统一走系统字体（--jv-font / --jv-mono）
import '@fontsource/orbitron/700.css'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import IntroGate from './intro/IntroGate.jsx'
import { TourLayer } from './tour/index.jsx'
import './styles.css'

// 新手引导层整站一份：页面 useTour / startTour 触发，渲染到 body 末尾（在进场动画之下、弹窗之上）
createRoot(document.getElementById('root')).render(<><App /><IntroGate /><TourLayer /></>)
