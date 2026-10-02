/* 「核心启动」3D 版：三道玻璃环（MeshPhysicalMaterial：transmission + clearcoat + iridescence + dispersion）
 * 依次旋入、减速对齐，中心能量核点火成 AI 渐变流体光球，环向外扩散消散，镜头落在登录页光球的位置。
 *
 * - 环境光：程序化「摄影棚」——几条长条柔光板（顶部主光、左冷右暖竖条、后方一紫一粉），PMREM 预滤波，不加载 HDR
 * - 镜头：28° 长焦，深空 44 → 由目标直径反算的落点距离；镜头平移用 setViewOffset（移轴），
 *   核心始终在光轴上，屏幕投影是正圆，最后正好落在登录页光球的中心与直径
 * - 桌面：DPR ≤1.75 + Bloom；手机：DPR ≤1.25、关后处理、关色散、透射缓冲半分辨率
 * - 卸载：本文件创建的几何体/材质/环境贴图在 effect 清理里逐个 dispose，R3F 卸载时再 forceContextLoss */
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  BG_FRAG, BG_VERT, CORE_FRAG, CORE_VERT, DUST_FRAG, DUST_VERT, HALO_FRAG, HALO_VERT, PULSE_FRAG,
} from './shaders.js'
import { estimateOrbSize } from './target.js'
import { BEATS, SCENE_S, distanceForSize, lerp, ringFit, sceneState } from './timeline.js'

export const FOV = 28
const D0 = 44
const HALO_EXTENT = 1.8
// 三道环：内圈竖带、中圈细管、外圈扁环（半径以核心半径为单位，再整体乘 ringFit）
const RING_DEFS = [
  { R: 1.55, kind: 'band', a: 0.045, b: 0.16, tint: '#cfd6ff' },
  { R: 2.05, kind: 'tube', a: 0.05, tint: '#e6dcff' },
  { R: 2.6, kind: 'washer', a: 0.12, b: 0.032, tint: '#d8e4ff' },
]
const FINAL_TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.02, 0, 0.16))

/** 圆角矩形截面（x=径向，y=轴向）绕 Y 旋转成环，再转到 XY 平面（法线 = Z） */
function bandGeometry(R, a, b, segments) {
  const c = Math.min(a, b) * 0.9
  const n = 5
  const pts = []
  const corners = [
    [R + a - c, b - c, 0], [R - a + c, b - c, Math.PI / 2],
    [R - a + c, -b + c, Math.PI], [R + a - c, -b + c, Math.PI * 1.5],
  ]
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= n; i++) {
      const t = start + (i / n) * (Math.PI / 2)
      pts.push(new THREE.Vector2(cx + c * Math.cos(t), cy + c * Math.sin(t)))
    }
  }
  pts.push(pts[0].clone())
  const g = new THREE.LatheGeometry(pts, segments)
  g.rotateX(Math.PI / 2)
  return g
}

function makeRingGeometry(def, mobile) {
  const seg = mobile ? 128 : 220
  if (def.kind === 'tube') return new THREE.TorusGeometry(def.R, def.a, mobile ? 20 : 32, seg)
  return bandGeometry(def.R, def.a, def.b, seg)
}

const GLASS = { ior: 1.45, thickness: 0.5, clearcoat: 1, iridescence: 0.8, env: 1.6 }

function makeGlass(def, mobile) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.035,
    transmission: 1, thickness: GLASS.thickness, ior: GLASS.ior,
    clearcoat: GLASS.clearcoat, clearcoatRoughness: 0.04,
    iridescence: GLASS.iridescence, iridescenceIOR: 1.3, iridescenceThicknessRange: [160, 480],
    dispersion: mobile ? 0 : 1.6,
    attenuationColor: new THREE.Color(def.tint), attenuationDistance: 2.6,
    specularIntensity: 1, envMapIntensity: GLASS.env,
  })
}

/** 只加颜色、不动目标 alpha 的叠加混合：透明画布上的光晕/微尘按「加光」合成到下面的 CSS 背景上 */
function additive(mat) {
  mat.blending = THREE.CustomBlending
  mat.blendEquation = THREE.AddEquation
  mat.blendSrc = THREE.OneFactor
  mat.blendDst = THREE.OneFactor
  mat.blendSrcAlpha = THREE.ZeroFactor
  mat.blendDstAlpha = THREE.OneFactor
  mat.depthWrite = false
  mat.transparent = false   // 留在不透明队列：会被写进透射缓冲，玻璃环能折射到它
  return mat
}

/** 程序化摄影棚环境：黑底 + 几条长条柔光板，PMREM 预滤波成环境贴图 */
function buildStudioEnv(gl) {
  const env = new THREE.Scene()
  const geo = new THREE.PlaneGeometry(1, 1)
  const mats = []
  const strip = (color, k, pos, sx, sy) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide })
    mats.push(m)
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(...pos)
    mesh.scale.set(sx, sy, 1)
    mesh.lookAt(0, 0, 0)
    env.add(mesh)
  }
  strip('#ffffff', 16, [0, 7, 2], 18, 0.8)        // 顶部细长主光：环上沿一道锐利高光
  strip('#e9eeff', 0.9, [0, 8, -5], 16, 6)         // 后上方大柔光箱：倾斜环的上表面整片泛光
  strip('#dfe8ff', 11, [-9, 1, 2], 0.8, 12)       // 左侧冷白竖条
  strip('#fff1e2', 7, [9, -1, 1], 0.7, 10)        // 右侧暖白竖条
  strip('#7d6bff', 3.2, [-6, -2, -9], 8, 4)       // 后方紫：透过玻璃看到的冷色反光
  strip('#ff5fa8', 2.6, [6, 3, -9], 4, 3)         // 后方粉
  strip('#ffffff', 4, [0, -7, 4], 14, 0.5)        // 底部细条：下沿轮廓
  strip('#c9d2ff', 0.7, [0, 2, 12], 10, 4)        // 机位后的弱补光
  const pmrem = new THREE.PMREMGenerator(gl)
  const rt = pmrem.fromScene(env, 0.035)
  pmrem.dispose()
  geo.dispose()
  mats.forEach(m => m.dispose())
  return rt
}

function makeDust(count) {
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  const pos = new Float32Array(count * 3)
  const size = new Float32Array(count)
  const alpha = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const r = 2.2 + rnd() ** 0.8 * 15
    const a = rnd() * Math.PI * 2
    pos[i * 3] = Math.cos(a) * r
    pos[i * 3 + 1] = Math.sin(a) * r * 0.8
    pos[i * 3 + 2] = -30 + rnd() * 66
    size[i] = 0.018 + rnd() * 0.03
    alpha[i] = 0.25 + rnd() * 0.6
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
  return g
}

function Rig({ targetRef, mobile, onReady, bloomRef }) {
  const { gl, scene, camera, size } = useThree()
  const ringRefs = useRef([])
  const coreRef = useRef(null)
  const haloRef = useRef(null)
  const pulseRef = useRef(null)
  const lightRef = useRef(null)
  const clock = useRef({ t0: 0, frames: 0, phase: Math.random() * 10, spin: Math.random() * 6.28 })

  const res = useMemo(() => {
    const ringGeos = RING_DEFS.map(d => makeRingGeometry(d, mobile))
    const ringMats = RING_DEFS.map(d => makeGlass(d, mobile))
    const coreGeo = new THREE.SphereGeometry(1, 96, 64)
    const coreMat = new THREE.ShaderMaterial({
      vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
      uniforms: {
        uPhase: { value: 0 }, uSpin: { value: 0 }, uEnergy: { value: 0.05 }, uIgnite: { value: 0 },
        uFlash: { value: 0 }, uLight: { value: 0 },
      },
    })
    const planeGeo = new THREE.PlaneGeometry(2, 2)
    const haloMat = additive(new THREE.ShaderMaterial({
      vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
      uniforms: { uHalo: { value: 0.35 }, uPhase: { value: 0 }, uIgnite: { value: 0 }, uFlash: { value: 0 }, uExtent: { value: HALO_EXTENT } },
    }))
    const pulseMat = additive(new THREE.ShaderMaterial({
      vertexShader: HALO_VERT, fragmentShader: PULSE_FRAG, side: THREE.DoubleSide,
      uniforms: { uAlpha: { value: 0 }, uPhase: { value: 0 } },
    }))
    const dustGeo = makeDust(mobile ? 220 : 380)
    const dustMat = additive(new THREE.ShaderMaterial({
      vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
      uniforms: { uPx: { value: 400 }, uFade: { value: 0 } },
    }))
    const bgMat = new THREE.ShaderMaterial({
      vertexShader: BG_VERT, fragmentShader: BG_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uView: { value: new THREE.Vector2(1440, 900) }, uAmbient: { value: 0 } },
    })
    return { ringGeos, ringMats, coreGeo, coreMat, planeGeo, haloMat, pulseMat, dustGeo, dustMat, bgMat }
  }, [mobile])

  // 环境贴图（程序化）+ 透射缓冲分辨率；卸载时释放全部 GPU 资源
  useLayoutEffect(() => {
    const envRT = buildStudioEnv(gl)
    scene.environment = envRT.texture
    gl.transmissionResolutionScale = mobile ? 0.5 : 1
    return () => {
      scene.environment = null
      envRT.dispose()
      // three 内部的透射渲染目标、后处理缓冲由 R3F 卸载时的 forceContextLoss 一并回收（实测卸载后 isContextLost = true）
      res.ringGeos.forEach(g => g.dispose())
      res.ringMats.forEach(m => m.dispose())
      ;[res.coreGeo, res.coreMat, res.planeGeo, res.haloMat, res.pulseMat, res.dustGeo, res.dustMat, res.bgMat].forEach(o => o.dispose())
    }
  }, [gl, scene, mobile, res])

  const axes = useMemo(() => BEATS.rings.map(r => new THREE.Vector3(...r.axis).normalize()), [])
  const tmpQ = useMemo(() => new THREE.Quaternion(), [])
  // 环组缩放只随视口变：对齐时外环约占短边 40%
  const fit = useMemo(() => {
    const dAlign = lerp(D0, distanceForSize(estimateOrbSize(size.width, size.height), size.height, FOV), sceneState(1.5).dolly)
    return ringFit(size.width, size.height, dAlign, FOV, RING_DEFS[2].R)
  }, [size.width, size.height])

  useFrame((state, dtRaw) => {
    const C = clock.current
    const now = performance.now()
    if (!C.frames) C.t0 = now
    C.frames += 1
    if (C.frames === 2) onReady?.(C.t0)
    const s = Math.min(SCENE_S + 1, (now - C.t0) / 1000)
    const dt = Math.min(0.05, dtRaw)
    const st = sceneState(s)
    const warm = C.frames <= 2
    const W = size.width
    const H = size.height
    const T = targetRef.current || { x: W / 2, y: H * 0.276, size: estimateOrbSize(W, H) }

    // 镜头：深空缓推 + 轻微环绕/滚转归零；移轴把核心从屏幕中心送到登录页光球的位置
    const dEnd = distanceForSize(T.size, H, FOV)
    const dist = lerp(D0, dEnd, st.dolly)
    const az = 0.3 * st.orbit
    const el = 0.11 * st.orbit
    const roll = -0.06 * st.orbit
    camera.position.set(dist * Math.sin(az) * Math.cos(el), dist * Math.sin(el), dist * Math.cos(az) * Math.cos(el))
    camera.up.set(Math.sin(roll), Math.cos(roll), 0)
    camera.lookAt(0, 0, 0)
    const px = lerp(W / 2, T.x, st.pan)
    const py = lerp(H / 2, T.y, st.pan)
    camera.setViewOffset(W, H, W / 2 - px, H / 2 - py, W, H)
    camera.updateProjectionMatrix()

    // 环：绕各自的世界轴旋入（弹簧对齐）+ 从镜头外收拢；退场沿平面放大并「隐形」（反射、折射一起归零）
    st.rings.forEach((r, i) => {
      const mesh = ringRefs.current[i]
      if (!mesh) return
      const m = res.ringMats[i]
      const k = r.appear
      mesh.visible = k > 0.003 || warm   // 前两帧（画布还没显示）全部画一遍：着色器在揭幕前编译完，播放中不卡
      tmpQ.setFromAxisAngle(axes[i], r.angle)
      mesh.quaternion.copy(tmpQ).multiply(FINAL_TILT)
      mesh.scale.setScalar(fit * r.scale)
      m.envMapIntensity = GLASS.env * k
      m.specularIntensity = k
      m.clearcoat = Math.max(0.001, GLASS.clearcoat * k)
      m.iridescence = Math.max(0.001, GLASS.iridescence * k)
      m.thickness = GLASS.thickness * k
      m.ior = lerp(1.0, GLASS.ior, k)
    })
    scene.environmentRotation.set(0.15, st.envTurn, 0)

    // 能量核：白热 → AI 流体；参数最后回到登录页 idle（energy .28 / halo .5 / 缩放 1）
    C.phase += st.speed * dt
    C.spin += (0.05 + 0.5 * st.flash) * dt * 1.6
    const lightTheme = document.body.classList.contains('light') ? st.ambient : 0
    const cu = res.coreMat.uniforms
    cu.uPhase.value = C.phase
    cu.uSpin.value = C.spin
    cu.uEnergy.value = st.energy
    cu.uIgnite.value = st.ignite
    cu.uFlash.value = st.flash
    cu.uLight.value = lightTheme
    const breath = s > SCENE_S ? 1 + 0.022 * Math.sin((s - SCENE_S) * (Math.PI * 2 / 5.6)) : 1
    coreRef.current?.scale.setScalar(st.coreScale * breath)
    const hu = res.haloMat.uniforms
    hu.uHalo.value = st.halo
    hu.uPhase.value = C.phase
    hu.uIgnite.value = st.ignite
    hu.uFlash.value = st.flash
    if (haloRef.current) {
      haloRef.current.quaternion.copy(camera.quaternion)
      haloRef.current.scale.setScalar(HALO_EXTENT * st.coreScale)
    }
    if (pulseRef.current) {
      pulseRef.current.visible = st.pulse.alpha > 0.002 || warm
      pulseRef.current.quaternion.copy(FINAL_TILT)
      pulseRef.current.scale.setScalar(fit * st.pulse.radius)
      res.pulseMat.uniforms.uAlpha.value = st.pulse.alpha
      res.pulseMat.uniforms.uPhase.value = C.phase
    }
    if (lightRef.current) lightRef.current.intensity = (2 + 10 * st.energy + 40 * st.flash) * st.ignite + 1.5
    res.bgMat.uniforms.uView.value.set(W, H)
    res.bgMat.uniforms.uAmbient.value = st.ambient
    res.dustMat.uniforms.uFade.value = st.dust
    res.dustMat.uniforms.uPx.value = (H * state.viewport.dpr) / 2 / Math.tan((FOV * Math.PI) / 360)
    if (bloomRef?.current) bloomRef.current.intensity = st.bloom
  })

  return (
    <>
      <mesh geometry={res.planeGeo} material={res.bgMat} renderOrder={-10} frustumCulled={false} />
      <points geometry={res.dustGeo} material={res.dustMat} frustumCulled={false} />
      <mesh ref={haloRef} geometry={res.planeGeo} material={res.haloMat} renderOrder={-1} />
      <mesh ref={coreRef} geometry={res.coreGeo} material={res.coreMat} />
      <pointLight ref={lightRef} color="#b9a4ff" intensity={1.5} distance={0} decay={2} />
      {/* 两盏轮廓光：低粗糙度玻璃上打出细小的镜面闪点，随环转动沿环滑过 */}
      <directionalLight position={[-4, 6, -3]} intensity={2.6} color="#e4eaff" />
      <directionalLight position={[5, 2.5, 4]} intensity={1.3} color="#ffeadb" />
      <mesh ref={pulseRef} geometry={res.planeGeo} material={res.pulseMat} visible={false} />
      {RING_DEFS.map((d, i) => (
        <mesh key={d.kind} ref={el => { ringRefs.current[i] = el }} geometry={res.ringGeos[i]} material={res.ringMats[i]} />
      ))}
    </>
  )
}

/** 3D 场景。targetRef.current = { x, y, size }（视口 px）；第二帧画出时 onReady(首帧时刻) */
export default function RingsScene({ targetRef, mobile = false, onReady }) {
  const bloomRef = useRef(null)
  return (
    <Canvas
      className="ir-canvas"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      dpr={mobile ? [1, 1.25] : [1, 1.75]}
      flat
      gl={{ alpha: false, antialias: mobile, stencil: false, powerPreference: 'high-performance' }}
      camera={{ fov: FOV, near: 0.1, far: 200, position: [0, 0, D0] }}
      onCreated={({ gl }) => gl.setClearColor(0x0b0b0f, 1)}
    >
      <Rig targetRef={targetRef} mobile={mobile} onReady={onReady} bloomRef={bloomRef} />
      {!mobile && (
        <EffectComposer multisampling={4} enableNormalPass={false}>
          <Bloom ref={bloomRef} mipmapBlur intensity={0.35} luminanceThreshold={0.62} luminanceSmoothing={0.22} radius={0.72} />
        </EffectComposer>
      )}
    </Canvas>
  )
}
