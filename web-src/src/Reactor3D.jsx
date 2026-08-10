import { Canvas, useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'

const ARC = '#53E8FF'
const RED = '#FF5C5C'

function Dust() {
  const ref = useRef()
  const positions = useMemo(() => {
    const arr = new Float32Array(420 * 3)
    for (let i = 0; i < 420; i++) {
      const r = 7 + Math.random() * 7
      const a = Math.random() * Math.PI * 2
      const b = Math.acos(2 * Math.random() - 1)
      arr[i * 3] = r * Math.sin(b) * Math.cos(a)
      arr[i * 3 + 1] = r * Math.sin(b) * Math.sin(a)
      arr[i * 3 + 2] = r * Math.cos(b)
    }
    return arr
  }, [])
  useFrame((_, dt) => { ref.current.rotation.y += dt * 0.02 })
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color={ARC} size={0.035} transparent opacity={0.5}
        blending={THREE.AdditiveBlending} depthWrite={false} sizeAttenuation />
    </points>
  )
}

function Ring({ radius, tube, arc = Math.PI * 2, color, opacity = 0.9, groupRef, tilt = [0, 0, 0] }) {
  return (
    <group ref={groupRef} rotation={tilt}>
      <mesh>
        <torusGeometry args={[radius, tube, 8, 128, arc]} />
        <meshBasicMaterial color={color} transparent opacity={opacity}
          blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

function Gyro({ busy, fail, spinup }) {
  const grp = useRef()
  const g1 = useRef()
  const g2 = useRef()
  const g3 = useRef()
  const core = useRef()
  const halo = useRef()
  useFrame((state, dt) => {
    const mult = spinup ? 9 : busy ? 3.4 : 1
    g1.current.rotation.x += dt * 0.55 * mult
    g1.current.rotation.z += dt * 0.32 * mult
    g2.current.rotation.y += dt * 0.72 * mult
    g2.current.rotation.x -= dt * 0.21 * mult
    g3.current.rotation.z -= dt * 0.4 * mult
    g3.current.rotation.y += dt * 0.27 * mult
    const t = state.clock.elapsedTime
    core.current.rotation.y += dt * 0.6 * mult
    core.current.scale.setScalar(1 + Math.sin(t * (busy ? 6 : 2.2)) * 0.06)
    halo.current.scale.setScalar(1 + Math.sin(t * (busy ? 6 : 2.2) + 1) * 0.1)
    grp.current.rotation.y += (state.pointer.x * 0.38 - grp.current.rotation.y) * 0.05
    grp.current.rotation.x += (-state.pointer.y * 0.28 - grp.current.rotation.x) * 0.05
  })
  const c = fail ? RED : ARC
  return (
    <group ref={grp}>
      <Ring groupRef={g1} radius={1.75} tube={0.024} color={c} />
      <Ring groupRef={g2} radius={2.15} tube={0.014} color={c} opacity={0.75} />
      <Ring groupRef={g3} radius={2.55} tube={0.04} arc={Math.PI * 1.45} color={c} opacity={0.8} />
      <mesh ref={core}>
        <icosahedronGeometry args={[0.82, 1]} />
        <meshBasicMaterial color={c} wireframe transparent opacity={0.85} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.4, 24, 24]} />
        <meshBasicMaterial color={fail ? RED : '#BDF6FF'} transparent opacity={0.75}
          blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** 全息陀螺仪。busy=思考中加速；fail=红闪；spinup=登录成功冲刺；dust=星尘背景 */
export default function Reactor3D({ busy = false, fail = false, spinup = false, dust = true, className }) {
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div className={`glow-bed${fail ? ' glow-red' : ''}${busy ? ' glow-hot' : ''}`} />
      <Canvas dpr={[1, 2]} camera={{ position: [0, 0, 6.4], fov: 45 }}
        gl={{ antialias: true, alpha: true }} style={{ position: 'absolute', inset: 0 }}>
        {dust && <Dust />}
        <Gyro busy={busy} fail={fail} spinup={spinup} />
      </Canvas>
    </div>
  )
}
