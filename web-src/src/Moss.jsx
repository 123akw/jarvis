import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { AuroraPlane } from './ShaderBg.jsx'

const RED = '#FF2A1F'
const METAL = '#232B35'
const DARK = '#12161C'
const GLASS = '#07090D'

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

/** 四角六角螺栓（电影里那四个圆点是螺栓，不是镜头） */
function Bolt({ position }) {
  return (
    <mesh position={position} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.07, 0.07, 0.05, 6]} />
      <meshStandardMaterial color="#3A434F" metalness={0.9} roughness={0.35} />
    </mesh>
  )
}

function MossHead({ mouse, busy, fail, spinup }) {
  const assembly = useRef()
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
    // 云台物理：偏航转整个支架，俯仰只转机头（绕侧轴销）；浮动与失败短震在支架上
    assembly.current.rotation.y += (tx * 0.5 - assembly.current.rotation.y) * kk
    head.current.rotation.x += (-ty * 0.34 - head.current.rotation.x) * kk
    assembly.current.rotation.z += (s.tilt - assembly.current.rotation.z) * kk
    assembly.current.position.y = Math.sin(t * 0.8) * 0.05
    assembly.current.position.x = fail ? Math.sin(t * 42) * 0.05 : assembly.current.position.x * 0.9
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
    glowMat.current.opacity = 0.16 * pulse
    ringMat.current.opacity = Math.min(1, 0.75 * pulse)
    irisMat.current.opacity = Math.min(1, 0.5 * pulse)
    // 状态灯序列闪烁
    ledMats.current.forEach((m, i) => {
      if (m) m.opacity = Math.sin(t * 2.6 + i * 2.1) > 0.2 ? 0.9 : 0.15
    })
  })

  const headGeo = useMemo(() => new RoundedBoxGeometry(2.2, 2.2, 1.0, 4, 0.18), [])
  const faceGeo = useMemo(() => new RoundedBoxGeometry(2.02, 2.02, 0.08, 4, 0.14), [])
  const armGeo = useMemo(() => new RoundedBoxGeometry(0.14, 1.7, 0.42, 3, 0.06), [])

  return (
    <group position={[0.32, 0.1, 0]} scale={0.7}>
    <group ref={assembly}>
      {/* U 型云台支架：立臂 + 侧轴销 + 横梁 + 立柱 */}
      {[-1, 1].map(s => (
        <group key={s}>
          <mesh geometry={armGeo} position={[s * 1.27, -0.29, 0]}>
            <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.4} />
          </mesh>
          <mesh position={[s * 1.16, 0.28, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.18, 0.18, 0.14, 24]} />
            <meshStandardMaterial color="#2E3742" metalness={0.9} roughness={0.3} />
          </mesh>
          <mesh position={[s * 1.26, 0.28, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.07, 0.07, 0.06, 6]} />
            <meshStandardMaterial color="#3A434F" metalness={0.9} roughness={0.35} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, -1.2, 0]}>
        <boxGeometry args={[2.68, 0.14, 0.42]} />
        <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.4} />
      </mesh>
      <mesh position={[0, -1.5, 0]}>
        <cylinderGeometry args={[0.1, 0.14, 0.5, 20]} />
        <meshStandardMaterial color={DARK} metalness={0.8} roughness={0.5} />
      </mesh>

      {/* 机头：圆角方壳 + 玻璃面板，绕侧轴销俯仰 */}
      <group ref={head} position={[0, 0.28, 0]}>
        <mesh geometry={headGeo}>
          <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.38} />
        </mesh>
        <mesh geometry={faceGeo} position={[0, 0, 0.5]}>
          <meshPhysicalMaterial color={GLASS} metalness={0.5} roughness={0.35}
            clearcoat={1} clearcoatRoughness={0.25} />
        </mesh>
        {/* 侧面散热槽 */}
        {[-1, 1].map(s => [0.45, 0.22, -0.01, -0.24, -0.47].map(y => (
          <mesh key={`${s}${y}`} position={[s * 1.105, y, 0]}>
            <boxGeometry args={[0.015, 0.12, 0.66]} />
            <meshBasicMaterial color="#05070A" />
          </mesh>
        )))}
        {/* 四角六角螺栓 */}
        <Bolt position={[-0.87, 0.87, 0.55]} />
        <Bolt position={[0.87, 0.87, 0.55]} />
        <Bolt position={[-0.87, -0.87, 0.55]} />
        <Bolt position={[0.87, -0.87, 0.55]} />
        {/* 大镜头：多级同心镜圈层层内收，几乎占满面板 */}
        <group position={[0, 0, 0.54]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.99, 1.03, 0.18, 56]} />
            <meshStandardMaterial color="#2E3742" metalness={0.9} roughness={0.28} />
          </mesh>
          <mesh position={[0, 0, 0.095]}>
            <ringGeometry args={[0.85, 0.99, 56]} />
            <meshStandardMaterial color="#4A5563" metalness={0.85} roughness={0.35} />
          </mesh>
          <mesh position={[0, 0, 0.075]}>
            <ringGeometry args={[0.70, 0.85, 56]} />
            <meshStandardMaterial color="#2A323D" metalness={0.75} roughness={0.45} />
          </mesh>
          <mesh position={[0, 0, 0.06]}>
            <ringGeometry args={[0.56, 0.70, 56]} />
            <meshStandardMaterial color="#171C22" metalness={0.65} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.05]}>
            <circleGeometry args={[0.56, 56]} />
            <meshStandardMaterial color="#05070A" metalness={0.2} roughness={0.3} />
          </mesh>
          <mesh position={[0, 0, 0.08]}>
            <torusGeometry args={[0.47, 0.03, 12, 64]} />
            <meshBasicMaterial ref={ringMat} color={RED} transparent toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, 0.06]}>
            <torusGeometry args={[0.31, 0.01, 8, 48]} />
            <meshStandardMaterial color="#39424E" metalness={0.9} roughness={0.3} />
          </mesh>
          <group ref={pupil} position={[0, 0, 0.085]}>
            <mesh>
              <torusGeometry args={[0.17, 0.016, 10, 40]} />
              <meshBasicMaterial ref={irisMat} color={RED} transparent toneMapped={false} />
            </mesh>
            <mesh>
              <circleGeometry args={[0.08, 24]} />
              <meshBasicMaterial color={RED} toneMapped={false} />
            </mesh>
            <mesh position={[0.13, 0.14, 0.02]}>
              <circleGeometry args={[0.028, 12]} />
              <meshBasicMaterial color="#FFE2DE" transparent opacity={0.85} />
            </mesh>
          </group>
          <sprite position={[0, 0, 0.11]} scale={[1.05, 1.05, 1]}>
            <spriteMaterial ref={glowMat} map={glowTex.current} transparent opacity={0.3}
              blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </sprite>
        </group>
        {/* 底框状态灯 */}
        {[-0.22, 0, 0.22].map((x, i) => (
          <mesh key={i} position={[x, -1.03, 0.52]}>
            <circleGeometry args={[0.026, 16]} />
            <meshBasicMaterial ref={m => { ledMats.current[i] = m }} color="#53E8FF"
              transparent opacity={0.6} toneMapped={false} />
          </mesh>
        ))}
      </group>
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
