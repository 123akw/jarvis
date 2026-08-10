import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uPointer;
varying vec2 vUv;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main(){
  vec2 uv = vUv;
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float t = uTime * 0.03;

  float band  = fbm(vec2(p.x * 1.6 + t * 2.0, p.y * 3.0 - t));
  float band2 = fbm(vec2(p.x * 2.2 - t * 1.4, p.y * 4.0 + t * 0.7) + 3.7);

  vec3 deep = vec3(0.012, 0.040, 0.070);
  vec3 arc  = vec3(0.325, 0.910, 1.000);
  vec3 gold = vec3(0.940, 0.706, 0.353);

  float a1 = smoothstep(0.45, 0.90, band) * (0.6 + 0.4 * sin(uv.y * 3.0 + t * 4.0));
  float a2 = smoothstep(0.55, 0.95, band2) * 0.22;

  vec3 col = deep;
  col += arc * a1 * (1.0 - uv.y * 0.55) * 0.72;
  col += arc * a2 * 0.55;
  col += gold * smoothstep(0.68, 1.0, band * band2) * 0.22;
  col += arc * exp(-uv.y * 4.0) * 0.10;   // 底部地平线光

  vec2 cell = floor(p * 220.0);
  float star = step(0.9986, hash(cell)) * (0.5 + 0.5 * sin(t * 30.0 + hash(cell) * 20.0));
  col += vec3(star) * 0.45;

  float d = distance(uv, uPointer);
  col += arc * exp(-d * 4.5) * 0.05;

  float vig = smoothstep(1.45, 0.30, length(uv - 0.5) * 1.6);
  col *= vig;
  gl_FragColor = vec4(col, 1.0);
}`

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`

function Plane() {
  const mat = useRef()
  const { size } = useThree()
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uPointer: { value: new THREE.Vector2(0.5, 0.5) },
  }), [])
  useFrame((state, dt) => {
    uniforms.uTime.value += dt
    uniforms.uRes.value.set(size.width, size.height)
    uniforms.uPointer.value.lerp(
      new THREE.Vector2(state.pointer.x * 0.5 + 0.5, state.pointer.y * 0.5 + 0.5), 0.04)
  })
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={mat} vertexShader={VERT} fragmentShader={FRAG}
        uniforms={uniforms} depthWrite={false} />
    </mesh>
  )
}

/** 程序化「动态影像」背景：流动极光 + 星野 + 指针光晕，效果等同视频循环但零素材 */
export default function ShaderBg() {
  return (
    <div className="shaderbg">
      <Canvas dpr={[1, 1.6]} gl={{ antialias: false }} style={{ position: 'absolute', inset: 0 }}>
        <Plane />
      </Canvas>
    </div>
  )
}
