import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { AuroraPlane } from './ShaderBg.jsx'

const WHITE = '#DEE3E5'   // 机身漆面
const WHITE2 = '#CFD5D8'  // 面板
const CHROME = '#C3C9CF'  // 旋转机构盘
const DARKM = '#22262B'
const GRILLE = '#14171B'
const CY = -1.55          // 机身中心相对吊点的纵向偏移

/** 径向渐变光晕贴图（程序生成，免素材） */
function makeGlowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255,70,45,0.9)')
  g.addColorStop(0.3, 'rgba(255,42,31,0.35)')
  g.addColorStop(1, 'rgba(255,42,31,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(c)
}

/** 铭牌贴图：白底黑字 */
function makeLabelTexture(text) {
  const c = document.createElement('canvas')
  c.width = 128; c.height = 44
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#E8ECEE'; ctx.fillRect(0, 0, 128, 44)
  ctx.strokeStyle = '#3A4045'; ctx.lineWidth = 3; ctx.strokeRect(0, 0, 128, 44)
  ctx.fillStyle = '#22262B'; ctx.font = 'bold 26px monospace'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(text, 64, 24)
  return new THREE.CanvasTexture(c)
}

/** 全窗口鼠标（-1..1）＋最后活动时间，挂 window：鼠标移到表单上 MOSS 也照样盯 */
function useMouse() {
  const m = useRef({ x: 0, y: 0, t: 0 })
  useEffect(() => {
    const fn = e => {
      m.current.x = (e.clientX / window.innerWidth) * 2 - 1
      m.current.y = -((e.clientY / window.innerHeight) * 2 - 1)
      m.current.t = performance.now()
    }
    window.addEventListener('mousemove', fn)
    return () => window.removeEventListener('mousemove', fn)
  }, [])
  return m
}

function Bolt({ position, color = '#8F969B' }) {
  return (
    <mesh position={position} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.055, 0.055, 0.04, 6]} />
      <meshStandardMaterial color={color} metalness={0.85} roughness={0.4} />
    </mesh>
  )
}

function MossHead({ mouse, busy, fail, spinup, onPick }) {
  const assembly = useRef()
  const head = useRef()
  const pupil = useRef()
  const glowMat = useRef()
  const ringMat = useRef()
  const irisMat = useRef()
  const ledMats = useRef([])
  const glowTex = useRef()
  if (!glowTex.current) glowTex.current = makeGlowTexture()
  // 红色发光体用 >1 的 HDR 颜色，Bloom 只挑亮部，白机身不糊
  const redHot = useMemo(() => new THREE.Color(2.6, 0.42, 0.3), [])
  const redCore = useMemo(() => new THREE.Color(3.2, 1.0, 0.6), [])
  const label550 = useMemo(() => makeLabelTexture('550W'), [])
  const labelH50 = useMemo(() => makeLabelTexture('H50'), [])
  // 待机行为状态机：环视 / 每四次凝视镜头一次 / 视线切换时光圈重对焦
  const idle = useRef({ was: false, n: 0, tx: 0, ty: 0, tilt: 0, nextAt: 0, pulseAt: -9e9 })

  const bodyGeo = useMemo(() => new RoundedBoxGeometry(2.2, 2.6, 1.2, 4, 0.09), [])
  const faceGeo = useMemo(() => new RoundedBoxGeometry(2.0, 2.4, 0.08, 4, 0.07), [])
  const capGeo = useMemo(() => new RoundedBoxGeometry(2.32, 0.3, 1.28, 3, 0.06), [])

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const k = Math.min(1, dt * 6)
    const now = performance.now()
    const s = idle.current
    const idling = now - mouse.current.t > 3500
    let tx, ty
    if (idling) {
      if (now > s.nextAt) {
        s.n += 1
        const lookAtYou = s.n % 4 === 3
        s.tx = lookAtYou ? 0 : (Math.random() * 2 - 1) * 0.75
        s.ty = lookAtYou ? 0 : (Math.random() * 2 - 1) * 0.5
        s.tilt = lookAtYou ? 0 : (Math.random() * 2 - 1) * 0.05
        s.nextAt = now + (lookAtYou ? 2200 : 2600 + Math.random() * 2800)
        s.pulseAt = now
      }
      tx = s.tx; ty = s.ty
    } else {
      if (s.was) s.pulseAt = now  // 从待机切回追踪：重对焦一次
      tx = mouse.current.x; ty = mouse.current.y
      s.tilt = 0
      s.nextAt = 0
    }
    s.was = idling
    if (busy && !fail) {  // 思考中：红瞳左右扫描，无视鼠标
      tx = Math.sin(t * 1.8) * 0.55
      ty = Math.sin(t * 0.9) * 0.12
    }
    const kk = idling ? k * 0.45 : k  // 待机时转头更慢，像扫视
    // 吊装物理：整机绕顶端球关节偏航/俯仰，像悬挂云台在摆头
    head.current.rotation.y += (tx * 0.35 - head.current.rotation.y) * kk
    head.current.rotation.x += (-ty * 0.22 - head.current.rotation.x) * kk
    head.current.rotation.z += (s.tilt - head.current.rotation.z) * kk
    assembly.current.position.y = Math.sin(t * 0.8) * 0.04
    assembly.current.position.x = fail ? Math.sin(t * 42) * 0.05 : assembly.current.position.x * 0.9
    // 红眼视差：比头部多动一点，才像「盯」
    pupil.current.position.x = tx * 0.05
    pupil.current.position.y = ty * 0.04
    // 光圈重对焦脉冲（300ms 收放）
    const ph = (now - s.pulseAt) / 300
    const focus = ph < 1 ? 1 + Math.sin(Math.min(ph, 1) * Math.PI) * 0.3 : 1
    pupil.current.scale.setScalar(focus)
    // 红眼呼吸/状态
    const base = spinup ? 2.8 : fail ? 2.4 : busy ? 1.7 : 1.0
    const pulse = base + Math.sin(t * (busy || fail ? 7 : 2.1)) * 0.18
    glowMat.current.opacity = 0.22 * pulse
    ringMat.current.opacity = Math.min(1, 0.8 * pulse)
    irisMat.current.opacity = Math.min(1, 0.6 * pulse)
    // 指示灯：绿灯闪烁 / 红灯慢脉动 / 小屏微闪
    const [g, r, scr] = ledMats.current
    if (g) g.opacity = Math.sin(t * 2.4) > 0 ? 0.95 : 0.2
    if (r) r.opacity = 0.55 + 0.35 * Math.sin(t * 1.1)
    if (scr) scr.opacity = 0.72 + 0.08 * Math.sin(t * 13) + 0.05 * Math.sin(t * 47)
  })

  return (
    <group ref={assembly}
      onClick={e => { e.stopPropagation(); onPick?.() }}
      onPointerOver={() => { document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { document.body.style.cursor = '' }}>
      {/* 白色机械臂（从天花板垂下）+ 球关节 */}
      <mesh position={[0.5, 3.0, 0]} rotation={[0, 0, 0.12]}>
        <cylinderGeometry args={[0.13, 0.13, 1.4, 20]} />
        <meshStandardMaterial color={WHITE} metalness={0.2} roughness={0.5} />
      </mesh>
      <mesh position={[0.42, 2.35, 0]}>
        <sphereGeometry args={[0.17, 24, 24]} />
        <meshStandardMaterial color={WHITE2} metalness={0.3} roughness={0.45} />
      </mesh>
      <mesh position={[0.21, 1.99, 0]} rotation={[0, 0, -0.52]}>
        <cylinderGeometry args={[0.11, 0.11, 0.88, 20]} />
        <meshStandardMaterial color={WHITE} metalness={0.2} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.62, 0]}>
        <sphereGeometry args={[0.16, 24, 24]} />
        <meshStandardMaterial color={WHITE2} metalness={0.3} roughness={0.45} />
      </mesh>

      {/* 悬挂机头：绕球关节摆动 */}
      <group ref={head} position={[0, 1.62, 0]}>
        <mesh position={[0, -0.16, 0]}>
          <cylinderGeometry args={[0.1, 0.12, 0.3, 16]} />
          <meshStandardMaterial color={WHITE2} metalness={0.3} roughness={0.45} />
        </mesh>
        {/* 顶盖与锁扣 */}
        <mesh geometry={capGeo} position={[0, CY + 1.42, 0]}>
          <meshStandardMaterial color={WHITE} metalness={0.2} roughness={0.5} />
        </mesh>
        {[-0.7, 0.7].map(x => (
          <mesh key={x} position={[x, CY + 1.42, 0.62]}>
            <boxGeometry args={[0.22, 0.14, 0.06]} />
            <meshStandardMaterial color="#AEB5B9" metalness={0.6} roughness={0.4} />
          </mesh>
        ))}
        {/* 机身与面板 */}
        <mesh geometry={bodyGeo} position={[0, CY, 0]}>
          <meshStandardMaterial color={WHITE} metalness={0.2} roughness={0.55} />
        </mesh>
        <mesh geometry={faceGeo} position={[0, CY, 0.63]}>
          <meshStandardMaterial color={WHITE2} metalness={0.15} roughness={0.5} />
        </mesh>
        {/* 面板拼缝 */}
        <mesh position={[0, CY - 0.15, 0.675]}>
          <boxGeometry args={[1.96, 0.016, 0.01]} />
          <meshBasicMaterial color="#9AA0A4" />
        </mesh>
        <mesh position={[-0.25, CY - 0.72, 0.675]}>
          <boxGeometry args={[0.016, 1.1, 0.01]} />
          <meshBasicMaterial color="#9AA0A4" />
        </mesh>
        {/* 左侧提手 */}
        <mesh position={[-1.16, CY + 0.7, 0]}>
          <boxGeometry args={[0.1, 0.5, 0.14]} />
          <meshStandardMaterial color={WHITE2} metalness={0.3} roughness={0.45} />
        </mesh>
        {/* 四角螺栓 */}
        <Bolt position={[-0.86, CY + 1.06, 0.68]} />
        <Bolt position={[0.86, CY + 1.06, 0.68]} />
        <Bolt position={[-0.86, CY - 1.06, 0.68]} />
        <Bolt position={[0.86, CY - 1.06, 0.68]} />
        {/* 铭牌 */}
        <mesh position={[0.52, CY + 1.02, 0.68]}>
          <planeGeometry args={[0.44, 0.15]} />
          <meshBasicMaterial map={label550} />
        </mesh>
        <mesh position={[0.42, CY - 0.9, 0.68]}>
          <planeGeometry args={[0.3, 0.11]} />
          <meshBasicMaterial map={labelH50} />
        </mesh>
        {/* 银色旋转机构盘 + 红眼 */}
        <group position={[0, CY + 0.42, 0.66]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.62, 0.66, 0.1, 48]} />
            <meshStandardMaterial color={CHROME} metalness={0.95} roughness={0.25} />
          </mesh>
          {/* 盘面辐条与铆钉 */}
          {[0, 1, 2].map(i => (
            <mesh key={i} position={[0, 0, 0.055]} rotation={[0, 0, (i * Math.PI * 2) / 3 + 0.5]}>
              <boxGeometry args={[0.5, 0.07, 0.02]} />
              <meshStandardMaterial color="#AEB5BB" metalness={0.9} roughness={0.3} />
            </mesh>
          ))}
          {[0, 1, 2, 3, 4, 5].map(i => {
            const a = (i * Math.PI) / 3
            return (
              <mesh key={i} position={[Math.cos(a) * 0.52, Math.sin(a) * 0.52, 0.06]}
                rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.035, 0.035, 0.03, 6]} />
                <meshStandardMaterial color="#7E858B" metalness={0.9} roughness={0.35} />
              </mesh>
            )
          })}
          {/* 深色镜筒环 + 红环 */}
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.06]}>
            <cylinderGeometry args={[0.3, 0.34, 0.12, 32]} />
            <meshStandardMaterial color={DARKM} metalness={0.7} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0, 0.125]}>
            <torusGeometry args={[0.24, 0.014, 10, 48]} />
            <meshBasicMaterial ref={ringMat} color={redHot} transparent toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, 0.115]}>
            <circleGeometry args={[0.23, 32]} />
            <meshBasicMaterial color="#0A0506" />
          </mesh>
          {/* 红瞳组：视差 + 重对焦 */}
          <group ref={pupil} position={[0, 0, 0.13]}>
            <mesh>
              <circleGeometry args={[0.13, 28]} />
              <meshBasicMaterial ref={irisMat} color={redHot} transparent toneMapped={false} />
            </mesh>
            <mesh position={[0, 0, 0.005]}>
              <circleGeometry args={[0.055, 20]} />
              <meshBasicMaterial color={redCore} toneMapped={false} />
            </mesh>
            <mesh position={[0.07, 0.08, 0.01]}>
              <circleGeometry args={[0.02, 10]} />
              <meshBasicMaterial color="#FFF1EE" transparent opacity={0.9} />
            </mesh>
          </group>
          <sprite position={[0, 0, 0.16]} scale={[0.9, 0.9, 1]}>
            <spriteMaterial ref={glowMat} map={glowTex.current} transparent opacity={0.25}
              blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </sprite>
        </group>
        {/* 小蓝屏 + 红绿指示灯 */}
        <mesh position={[0.45, CY - 0.45, 0.675]}>
          <planeGeometry args={[0.36, 0.26]} />
          <meshBasicMaterial ref={m => { ledMats.current[2] = m }} color="#3D9BFF"
            transparent opacity={0.75} toneMapped={false} />
        </mesh>
        <mesh position={[0.28, CY - 0.72, 0.675]}>
          <circleGeometry args={[0.045, 16]} />
          <meshBasicMaterial ref={m => { ledMats.current[0] = m }} color="#38D06A"
            transparent opacity={0.8} toneMapped={false} />
        </mesh>
        <mesh position={[0.6, CY - 0.72, 0.675]}>
          <circleGeometry args={[0.045, 16]} />
          <meshBasicMaterial ref={m => { ledMats.current[1] = m }} color="#FF3B30"
            transparent opacity={0.7} toneMapped={false} />
        </mesh>
        {/* 黑色散热格栅 */}
        <group position={[-0.55, CY - 0.62, 0.665]}>
          <mesh>
            <boxGeometry args={[0.62, 0.56, 0.03]} />
            <meshStandardMaterial color={GRILLE} metalness={0.4} roughness={0.6} />
          </mesh>
          {[-0.18, -0.06, 0.06, 0.18].map(y => (
            <mesh key={y} position={[0, y, 0.02]}>
              <boxGeometry args={[0.54, 0.035, 0.01]} />
              <meshBasicMaterial color="#2E3338" />
            </mesh>
          ))}
        </group>
      </group>
    </group>
  )
}

/** MOSS 背景层：极光深空 + MOSS + Bloom 辉光，一张画布全包；可点击互动 */
export default function Moss({ busy = false, fail = false, spinup = false, onPick }) {
  const mouse = useMouse()
  return (
    <div className="mossbg">
      <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0, 5.4], fov: 42 }}
        gl={{ antialias: true, alpha: true }} style={{ position: 'absolute', inset: 0 }}>
        <AuroraPlane dim={0.5} />
        <ambientLight intensity={0.9} />
        <pointLight position={[-4, 3, 5]} intensity={40} color="#53E8FF" />
        <pointLight position={[4, -2, 4]} intensity={55} color="#FFFFFF" />
        <group position={[0.35, -0.1, 0]} scale={0.62}>
          <MossHead mouse={mouse} busy={busy} fail={fail} spinup={spinup} onPick={onPick} />
        </group>
        <EffectComposer>
          <Bloom mipmapBlur intensity={1.1} luminanceThreshold={0.6}
            luminanceSmoothing={0.2} radius={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  )
}

/** 侧栏迷你 MOSS：小画布、免后处理，照样追鼠标；busy 时红瞳扫描 */
export function MossMini({ busy = false }) {
  const mouse = useMouse()
  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0, 5.6], fov: 40 }}
      gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={0.95} />
      <pointLight position={[-4, 3, 5]} intensity={28} color="#53E8FF" />
      <pointLight position={[4, -2, 4]} intensity={42} color="#FFFFFF" />
      <group position={[0, 0.78, 0]} scale={0.52}>
        <MossHead mouse={mouse} busy={busy} fail={false} spinup={false} />
      </group>
    </Canvas>
  )
}
