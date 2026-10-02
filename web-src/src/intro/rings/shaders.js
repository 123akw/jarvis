/* 「核心启动」的着色器。能量核的流体配色与登录页 PresenceGL 同一套算法（同噪声、同四色、同菲涅尔与高光），
 * 定格时参数回到登录页 idle 值，两者淡入淡出时看不出接缝。
 * 输出约定：先把 sRGB 显示色转线性，再走 three 的 colorspace_fragment —— 直出画布与经过 EffectComposer
 * 两条管线颜色一致；不做色调映射（Canvas flat）。 */

const NOISE = /* glsl */`
float hash(vec3 p){
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x){
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), u.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p){ return 0.64 * noise(p) + 0.36 * noise(p * 1.93 + vec3(4.1, 1.7, 8.3)); }
vec3 pal(float t){
  t = fract(t) * 4.0;
  vec3 c0 = vec3(0.231, 0.510, 0.965);
  vec3 c1 = vec3(0.545, 0.361, 0.965);
  vec3 c2 = vec3(0.925, 0.282, 0.600);
  vec3 c3 = vec3(0.961, 0.620, 0.043);
  vec3 a = t < 1.0 ? c0 : t < 2.0 ? c1 : t < 3.0 ? c2 : c3;
  vec3 b = t < 1.0 ? c1 : t < 2.0 ? c2 : t < 3.0 ? c3 : c0;
  return mix(a, b, smoothstep(0.0, 1.0, fract(t)));
}
vec3 toLinear(vec3 c){ return sRGBTransferEOTF(vec4(c, 1.0)).rgb; }
`

export const CORE_VERT = /* glsl */`
varying vec3 vN;
void main(){
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const CORE_FRAG = /* glsl */`
uniform float uPhase;
uniform float uSpin;
uniform float uEnergy;
uniform float uIgnite;
uniform float uFlash;
uniform float uLight;
varying vec3 vN;
${NOISE}
void main(){
  vec3 nv = normalize(vN);
  float z = clamp(nv.z, 0.0, 1.0);
  vec2 p = nv.xy;
  float c = cos(uSpin), s = sin(uSpin);
  vec3 n = vec3(c * p.x - s * p.y, s * p.x + c * p.y, z);

  float w  = fbm(n * 1.05 + vec3(0.0, 0.0, uPhase * 0.22));
  float w2 = fbm(n * 1.4 + vec3(w * 2.4 - uPhase * 0.12, w * 1.3 + uPhase * 0.1, uPhase * 0.16));
  float t = dot(n, vec3(0.32, 0.22, 0.12)) + (w2 - 0.5) * 1.05 + uPhase * 0.03;
  vec3 col = mix(pal(t), pal(t + 0.36), smoothstep(0.28, 0.72, w));
  float field = w2 * 2.4 + n.x * 0.6 + uPhase * 0.08;
  float rib = pow(1.0 - abs(sin(field * 3.1415926)), 20.0);

  float fres = pow(1.0 - z, 2.0);
  vec3 deep = mix(vec3(0.10, 0.08, 0.26), vec3(0.97, 0.97, 1.0), uLight);
  vec3 orb = mix(col * 0.95, deep, (0.34 - 0.14 * uLight) * z);
  orb = mix(orb, col * 1.25 + 0.08, fres * 0.8);
  orb += (col * 0.55 + 0.45) * rib * (0.05 + 0.75 * uEnergy * uEnergy) * (1.0 - 0.5 * fres);
  orb *= 0.88 + 0.26 * uEnergy;
  float spec = max(0.0, 1.0 - length(p - vec2(-0.38, 0.46)) * 1.6);
  orb += vec3(1.0) * pow(spec, 3.0) * 0.28;
  orb = mix(orb, mix(orb, vec3(1.0), 0.3), uLight);
  orb = clamp(orb, 0.0, 1.0);

  // 点火前：白热的能量核，中心白、边缘偏蓝紫；点火时溶进流体
  vec3 hot = mix(vec3(1.0, 0.99, 1.0), vec3(0.66, 0.68, 1.0), smoothstep(0.05, 0.95, 1.0 - z));
  orb = mix(hot, orb, uIgnite);

  gl_FragColor = vec4(toLinear(orb) * (1.0 + uFlash * 1.8), 1.0);
  #include <colorspace_fragment>
}
`

/** 朝向镜头的光晕面片（球心处），颜色沿角度取四色，按球半径指数衰减（与 PresenceGL 外晕同参数） */
export const HALO_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
export const HALO_FRAG = /* glsl */`
uniform float uHalo;
uniform float uPhase;
uniform float uIgnite;
uniform float uFlash;
uniform float uExtent;   // 面片半宽 / 球半径
varying vec2 vUv;
${NOISE}
void main(){
  vec2 p = (vUv * 2.0 - 1.0) * uExtent;
  float r = length(p);
  float d = max(r - 1.0, 0.0);
  vec3 hc = pal(atan(p.y, p.x) / 6.2831853 + uPhase * 0.03);
  hc = mix(vec3(0.72, 0.74, 1.0), hc, uIgnite);
  float halo = exp(-d * mix(2.6, 3.6, uIgnite)) * uHalo * smoothstep(uExtent, uExtent * 0.62, r);
  float a = halo * 0.6 * (1.0 + uFlash * 1.4) * step(0.98, r);
  // 在显示空间里乘强度再转线性：叠在暗底上的观感与 PresenceGL（预乘 alpha 直出）一致
  gl_FragColor = vec4(toLinear(hc * min(a, 1.0)) * max(1.0, a), 1.0);
  #include <colorspace_fragment>
}
`

/** 点火时向外扩散的一圈细光（在环平面内） */
export const PULSE_FRAG = /* glsl */`
uniform float uAlpha;
uniform float uPhase;
varying vec2 vUv;
${NOISE}
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float band = smoothstep(0.955, 0.99, r) * (1.0 - smoothstep(0.99, 1.0, r));
  float inner = smoothstep(0.6, 0.99, r) * (1.0 - smoothstep(0.99, 1.0, r)) * 0.08;   // 内侧一点余辉
  vec3 hc = pal(atan(p.y, p.x) / 6.2831853 + uPhase * 0.05);
  gl_FragColor = vec4(toLinear(mix(hc, vec3(1.0), 0.25) * min(1.0, (band + inner) * uAlpha)), 1.0);
  #include <colorspace_fragment>
}
`

/** 全屏背景：深空底色 →（定格时）登录页背景光。逐项复刻 Login.css 的 .jvl-ambient / .jvl-key-light / .jvl-grain：
 *  CSS 渐变在 sRGB 预乘空间里线性插值、逐层 source-over 合成，这里按同样规则算出显示色再转线性输出。
 *  它也画进透射缓冲，玻璃环折射到的就是真实背景（透明画布时 three 会把透射缓冲清成半透明白，玻璃发灰）。 */
export const BG_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`
export const BG_FRAG = /* glsl */`
uniform vec2 uView;      // 视口 CSS px
uniform float uAmbient;  // 0 深空 → 1 登录页背景
varying vec2 vUv;
vec3 toLinear(vec3 c){ return sRGBTransferEOTF(vec4(c, 1.0)).rgb; }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 over(vec3 dst, vec4 src){ return src.rgb + dst * (1.0 - src.a); }   // src 已预乘
vec4 pm(vec3 c, float a){ return vec4(c * a, a); }
vec4 fadeTo0(vec3 c, float a, float t, float end){ return pm(c, a * (1.0 - clamp(t / end, 0.0, 1.0))); }
void main(){
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uView;
  float vmin = min(uView.x, uView.y) / 100.0;
  float vmax = max(uView.x, uView.y) / 100.0;
  vec3 bg = vec3(11.0, 11.0, 15.0) / 255.0;
  vec3 col = bg;
  // .jvl-ambient：三层椭圆渐变（列表靠后的在下面）
  float t3 = length((px - vec2(1.00, 0.00) * uView) / vec2(40.0 * vmax, 28.0 * vmax));
  col = over(col, fadeTo0(vec3(245.0, 158.0, 11.0) / 255.0, 0.045, t3, 0.7));
  float t2 = length((px - vec2(0.98, 1.04) * uView) / vec2(52.0 * vmax, 40.0 * vmax));
  col = over(col, fadeTo0(vec3(236.0, 72.0, 153.0) / 255.0, 0.10, t2, 0.7));
  float t1 = length((px - vec2(0.06, 1.08) * uView) / vec2(60.0 * vmax, 46.0 * vmax));
  col = over(col, fadeTo0(vec3(59.0, 130.0, 246.0) / 255.0, 0.14, t1, 0.7));
  // .jvl-key-light：96vmin 的圆，中心 (50%, 30%)，circle 默认 farthest-corner；取漂移动画起点（-2vmin, scale .96）
  vec2 kc = vec2(0.5 * uView.x - 2.0 * vmin, 0.3 * uView.y);
  float kt = length(px - kc) / (48.0 * vmin * 0.96 * 1.41421356);
  vec4 k0 = pm(vec3(124.0, 58.0, 237.0) / 255.0, 0.24);
  vec4 k1 = pm(vec3(79.0, 70.0, 229.0) / 255.0, 0.13);
  vec4 k2 = pm(vec3(59.0, 130.0, 246.0) / 255.0, 0.05);
  vec4 key = kt < 0.28 ? mix(k0, k1, kt / 0.28)
    : kt < 0.48 ? mix(k1, k2, (kt - 0.28) / 0.2)
    : mix(k2, vec4(0.0), clamp((kt - 0.48) / 0.18, 0.0, 1.0));
  col = over(col, key);
  // .jvl-grain：5% 白噪点，均值约 +1.2%
  col += 0.012 + (hash2(floor(px)) - 0.5) * 0.014;
  gl_FragColor = vec4(toLinear(mix(bg, col, uAmbient)), 1.0);
  #include <colorspace_fragment>
}
`

/** 深空微尘：柔边圆点，透视缩放 */
export const DUST_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
uniform float uPx;
varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPx / -mv.z, 0.0, 7.0);
  vA = aAlpha * smoothstep(0.6, 3.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`
export const DUST_FRAG = /* glsl */`
uniform float uFade;
varying float vA;
vec3 toLinear(vec3 c){ return sRGBTransferEOTF(vec4(c, 1.0)).rgb; }
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.0, dot(q, q)) * vA * uFade;
  gl_FragColor = vec4(toLinear(vec3(0.62, 0.68, 0.95) * a), 1.0);
  #include <colorspace_fragment>
}
`
