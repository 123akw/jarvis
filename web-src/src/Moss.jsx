import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { AuroraPlane } from './ShaderBg.jsx'

const RED = '#FF2A1F'
const METAL = '#263241'
const PLATE = '#10161F'

/** 径向渐变光晕贴图（程序生成，免素材） */
function makeGlowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255,60,40,0.9)')
  g.addColorStop(0.3, 'rgba(255,42,31,0.35)')
  g.addColorStop(1, 'rgba(255,42,31,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
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

function Lens({ position, r = 0.16 }) {
  return (
    <group position={position}>
      <mesh>
        <cylinderGeometry args={[r, r * 1.12, 0.14, 24]} />
        <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.3} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.075, 0]}>
        <circleGeometry args={[r * 0.78, 24]} />
        <meshBasicMaterial color="#06090E" />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0.03, 0.076, -0.03]}>
        <circleGeometry args={[r * 0.16, 12]} />
        <meshBasicMaterial color="#9FDCEF" transparent opacity={0.8} />
      </mesh>
    </group>
  )
}

function MossHead({ mouse, busy, fail, spinup }) {
  const head = useRef()
  const pupil = useRef()
  const glowMat = useRef()
  const ringMat = useRef()
  const irisMat = useRef()
  const ledMats = useRef([])
  const glowTex = useRef()
  if (!glowTex.current) glowTex.current = makeGlowTexture()
  // 待机行为状态机：环视 / 每四次凝视镜头一次 / 视线切换时光圈重对焦
  const idle = useRef({ was: false, n: 0, tx: 0, ty: 0, tilt: 0, nextAt: 0, pulseAt: -9e9 })

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
        s.tilt = lookAtYou ? 0 : (Math.random() * 2 - 1) * 0.07
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
    const kk = idling ? k * 0.45 : k  // 待机时转头更慢，像扫视
    // 头部追视 + 侧倾 + 呼吸浮动 + 失败短震
    head.current.rotation.y += (tx * 0.55 - head.current.rotation.y) * kk
    head.current.rotation.x += (-ty * 0.38 - head.current.rotation.x) * kk
    head.current.rotation.z += (s.tilt - head.current.rotation.z) * kk
    head.current.position.y = Math.sin(t * 0.8) * 0.06
    head.current.position.x = fail ? Math.sin(t * 42) * 0.05 : head.current.position.x * 0.9
    // 瞳孔视差：比头部多动一点，才像「盯」
    pupil.current.position.x = tx * 0.11
    pupil.current.position.y = ty * 0.09
    // 光圈重对焦脉冲（300ms 收放）
    const ph = (now - s.pulseAt) / 300
    const focus = ph < 1 ? 1 + Math.sin(Math.min(ph, 1) * Math.PI) * 0.3 : 1
    pupil.current.scale.setScalar(focus)
    // 红瞳呼吸/状态
    const base = spinup ? 2.8 : fail ? 2.4 : busy ? 1.7 : 1.0
    const pulse = base + Math.sin(t * (busy || fail ? 7 : 2.1)) * 0.18
    glowMat.current.opacity = 0.20 * pulse
    ringMat.current.opacity = Math.min(1, 0.75 * pulse)
    irisMat.current.opacity = Math.min(1, 0.5 * pulse)
    // 状态灯序列闪烁
    ledMats.current.forEach((m, i) => {
      if (m) m.opacity = Math.sin(t * 2.6 + i * 2.1) > 0.2 ? 0.9 : 0.15
    })
  })

  return (
    <group position={[0.32, 0, 0]} scale={0.75}>
    <group ref={head}>
      {/* 机身主体与背板 */}
      <mesh>
        <boxGeometry args={[2.3, 2.3, 0.8]} />
        <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0, 0.41]}>
        <boxGeometry args={[2.06, 2.06, 0.04]} />
        <meshStandardMaterial color={PLATE} metalness={0.7} roughness={0.45} />
      </mesh>
      {/* 侧面散热鳍 */}
      {[-1, 1].map(s => [0.55, 0.15, -0.25, -0.65].map(y => (
        <mesh key={`${s}${y}`} position={[s * 1.19, y, 0]}>
          <boxGeometry args={[0.08, 0.26, 0.62]} />
          <meshStandardMaterial color={METAL} metalness={0.9} roughness={0.3} />
        </mesh>
      )))}
      {/* 顶部提梁 */}
      <mesh position={[0, 1.24, 0]}>
        <boxGeometry args={[1.5, 0.12, 0.5]} />
        <meshStandardMaterial color={METAL} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* 中央主摄：镜筒 + 细红环 + 玻璃瞳 + 径向辉光 */}
      <group position={[0, 0.1, 0.46]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.62, 0.7, 0.22, 40]} />
          <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.28} />
        </mesh>
        <mesh position={[0, 0, 0.115]}>
          <torusGeometry args={[0.54, 0.022, 12, 64]} />
          <meshBasicMaterial ref={ringMat} color={RED} transparent toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, 0.10]}>
          <circleGeometry args={[0.52, 48]} />
          <meshBasicMaterial color="#05070A" />
        </mesh>
        <group ref={pupil} position={[0, 0, 0.12]}>
          <mesh>
            <torusGeometry args={[0.17, 0.016, 10, 40]} />
            <meshBasicMaterial ref={irisMat} color={RED} transparent toneMapped={false} />
          </mesh>
          <mesh>
            <circleGeometry args={[0.07, 24]} />
            <meshBasicMaterial color={RED} toneMapped={false} />
          </mesh>
          <mesh position={[0.14, 0.15, 0.02]}>
            <circleGeometry args={[0.03, 12]} />
            <meshBasicMaterial color="#FFE2DE" transparent opacity={0.85} />
          </mesh>
        </group>
        <sprite position={[0, 0, 0.14]} scale={[2.0, 2.0, 1]}>
          <spriteMaterial ref={glowMat} map={glowTex.current} transparent opacity={0.3}
            blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
      </group>
      {/* 四角副镜头（前面板上） */}
      <group rotation={[Math.PI / 2, 0, 0]}>
        <Lens position={[-0.82, 0.46, -0.92]} />
        <Lens position={[0.82, 0.46, -0.92]} />
        <Lens position={[-0.82, 0.46, 0.72]} r={0.13} />
        <Lens position={[0.82, 0.46, 0.72]} r={0.13} />
      </group>
      {/* 状态灯条 */}
      {[-0.3, 0, 0.3].map((x, i) => (
        <mesh key={i} position={[x, -0.92, 0.44]}>
          <boxGeometry args={[0.16, 0.05, 0.02]} />
          <meshBasicMaterial ref={m => { ledMats.current[i] = m }} color="#53E8FF"
            transparent opacity={0.6} toneMapped={false} />
        </mesh>
      ))}
    </group>
    </group>
  )
}

/** MOSS 背景层：极光深空 + MOSS + Bloom 辉光，一张画布全包，不拦鼠标事件 */
export default function Moss({ busy = false, fail = false, spinup = false }) {
  const mouse = useMouse()
  return (
    <div className="mossbg">
      <Canvas dpr={[1, 1.75]} camera={{ position: [0, 0, 5.4], fov: 42 }}
        gl={{ antialias: true, alpha: true }} style={{ position: 'absolute', inset: 0 }}>
        <AuroraPlane dim={0.5} />
        <ambientLight intensity={1.0} />
        <pointLight position={[-4, 3, 5]} intensity={70} color="#53E8FF" />
        <pointLight position={[4, -2, 4]} intensity={35} color="#FFFFFF" />
        <MossHead mouse={mouse} busy={busy} fail={fail} spinup={spinup} />
        <EffectComposer>
          <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.32}
            luminanceSmoothing={0.2} radius={0.72} />
        </EffectComposer>
      </Canvas>
    </div>
  )
}
