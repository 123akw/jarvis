/**
 * 进场「唤醒」的光粒子层：原生 WebGL1，一次 drawArrays(POINTS)，零依赖。
 *
 * 每个粒子只在初始化时写入 8 个随机数（起点屏幕位置/深度、落点经纬/壳层、时序与尺寸种子），
 * 之后 JS 每帧只更新几个 uniform：位置、透视、景深、颜色全部在顶点着色器里按时间插值。
 *
 * 空间约定：焦平面 z=0 上 1 个世界单位 = 1 CSS px，镜头在 +z、以光球中心为透视中心。
 * 粒子从撒满全屏的三维体积出发，沿绕光球的漩涡弧线汇聚到半径 R 的球壳上——这个球壳正好是
 * 登录页光球的位置和尺寸，所以光球亮起后可以无缝交给 Presence 渲染。
 */

const VERT = `
precision highp float;
attribute vec4 aA;   // 起点屏幕 x, y（0..1）、深度种子、时序种子
attribute vec4 aB;   // 落点经度、纬度、壳层深度、尺寸/颜色种子
uniform vec2  uView; // 视口（CSS px）
uniform vec3  uOrb;  // 光球中心 xy（CSS px，左上原点）+ 半径
uniform vec2  uCam;  // 指针视差（CSS px）
uniform float uT;    // 秒
uniform float uIgn;  // 光球点亮时刻（秒）
uniform float uDpr;
uniform float uLight;
varying vec3  vCol;
varying float vA;
varying float vSoft;
varying float vL;

const float PI = 3.1415927;

// 与 PresenceGL 同一套循环四色：蓝 → 紫 → 粉 → 琥珀
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
// 起步零速、落地长尾减速：像被引力慢慢拉动，到位时轻轻停住
float ease(float t){
  float e = t * t * (3.0 - 2.0 * t);
  return 1.0 - pow(1.0 - e, 1.8);
}

void main(){
  float F = max(uView.x, uView.y) * 1.15;
  vec2 C = uOrb.xy;
  float R = uOrb.z;

  // ---- 起点：均匀撒满屏幕（略出边），按深度反投影；远处多、近处少 ----
  float z0 = mix(-1.7, 0.58, pow(aA.z, 1.3)) * F;
  vec2 scr0 = (aA.xy * 1.2 - 0.1) * uView;
  vec3 S = vec3(C + (scr0 - C) * (F - z0) / F, z0);

  // ---- 落点：球壳（绕纵轴慢转），被点亮的光球吸收时向内收一点 ----
  float jit = fract(aA.w * 7.31);
  float t0 = 0.16 + 0.32 * clamp(length(scr0 - C) / max(uView.x, uView.y), 0.0, 1.0) + 0.2 * jit;
  float dur = 0.95 + 0.25 * fract(aB.w * 5.17);
  float t = clamp((uT - t0) / dur, 0.0, 1.0);
  float land = max(uIgn, t0 + dur);                       // 吸收从「点亮」或「自己落地」较晚者开始
  float absorb = smoothstep(land - 0.05, land + 0.32 + 0.2 * jit, uT);

  float th = aB.x * 2.0 * PI + uT * 0.5;
  float cy = aB.y * 2.0 - 1.0;
  float sy = sqrt(1.0 - cy * cy);
  vec3 dir = vec3(sy * cos(th), cy, sy * sin(th));
  float shell = (1.0 - 0.28 * aB.z * aB.z) * (1.0 - 0.14 * absorb);
  vec3 E = vec3(C + dir.xy * R * shell, dir.z * R * shell);

  // ---- 路径：以光球为轴的漩涡弧线（统一旋向；终点角度不变，多绕的弧度在途中消化）----
  vec2 sr = S.xy - C;
  vec2 er = E.xy - C;
  float a0 = atan(sr.y, sr.x);
  float ae = atan(er.y, er.x);
  float sweep = mod(ae - a0 - 1.3 + PI, 2.0 * PI) - PI + 1.3;
  float ang = a0 + sweep * ease(min(1.0, t * 1.12));
  float rad = mix(length(sr), length(er), ease(t));
  vec3 P = vec3(C + rad * vec2(cos(ang), sin(ang)), mix(S.z, E.z, ease(min(1.0, t * 1.06))));

  // ---- 镜头：从后方推近到焦平面 + 轻微漂移（推到位时收住），指针带来远近视差 ----
  float dolly = 1.0 - ease(clamp(uT / 1.9, 0.0, 1.0));
  vec2 cam = uCam + vec2(sin(uT * 0.9), cos(uT * 0.7)) * 14.0 * dolly;
  float zp = P.z - 0.28 * F * dolly;
  float s = F / max(F - zp, 1.0);
  vec2 scr = C + (P.xy - C - cam) * s + cam;

  // ---- 景深：先对焦远处，汇聚时拉焦到焦平面（rack focus）----
  float focus = mix(-0.9 * F, 0.0, ease(clamp((uT - 0.15) / 1.35, 0.0, 1.0)));
  float coc = 15.0 * abs(s - F / (F - focus));
  float base = (1.1 + 2.3 * aB.w * aB.w * aB.w) * s * 2.4;   // 精灵 = 亮核 + 一圈柔光
  float size = base + coc;
  vSoft = clamp(coc / size * 1.3, 0.0, 1.0);

  // ---- 亮度：按距离由近及远依次醒来，散焦能量摊薄，落地变暗、点亮时一闪后被吸收 ----
  float wake = smoothstep(0.0, 0.4, uT - 0.6 * t0 + 0.05);
  float twinkle = 0.75 + 0.25 * sin(uT * 6.0 + aA.w * 40.0);
  float flash = 1.0 + 0.9 * exp(-pow((uT - land) * 6.0, 2.0)) * step(uIgn - 0.2, uT);
  float vig = mix(1.0, 0.4, smoothstep(0.22, 0.7, length(scr0 - C) / max(uView.x, uView.y)));  // 四周暗、向光球聚光
  float a = 1.5 * wake * pow(base / size, 1.25) * mix(twinkle * vig, 1.0, t) * mix(1.0, 0.8, t * t)
    * flash * (1.0 - absorb);

  // ---- 颜色：游离时是偏白的四色微光，落地时变成光球同一位置的色相 ----
  vec3 c0 = mix(pal(aA.x * 0.6 + aA.y * 0.35 + aA.w * 0.5), vec3(1.0), 0.38);
  vec3 c1 = pal(dot(dir, vec3(0.32, 0.22, 0.12)) + 0.15) * 1.15 + 0.06;
  vec3 col = mix(c0, c1, smoothstep(0.25, 1.0, t));
  vCol = mix(col, col * 0.62, uLight);
  vA = a * mix(1.0, 1.6, uLight);
  vL = uLight;

  // 看不见的粒子扔出裁剪空间：不进光栅化
  gl_Position = a < 0.002
    ? vec4(2.0, 2.0, 2.0, 1.0)
    : vec4(scr.x / uView.x * 2.0 - 1.0, 1.0 - scr.y / uView.y * 2.0, 0.0, 1.0);
  gl_PointSize = max(size * uDpr, 1.0);
}
`

const FRAG = `
precision mediump float;
varying vec3  vCol;
varying float vA;
varying float vSoft;
varying float vL;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  float core = exp(-d * 16.0) + 0.16 * exp(-d * 3.5);          // 合焦：亮核 + 柔光
  float disc = smoothstep(1.0, 0.7, d) * (0.7 + 0.3 * d);      // 焦外：平底圆斑、边缘略亮
  float k = mix(core, disc, vSoft) * vA;
  vec3 c = vCol * k;
  // 暗色：发光叠加，alpha 取最大通道保证预乘合法；亮色：普通覆盖
  gl_FragColor = vec4(c, mix(max(c.r, max(c.g, c.b)), k, vL));
}
`

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/** 建粒子渲染器；不支持 / 编译失败返回 null（调用方走 CSS 降级）。 */
export function createParticles(canvas, { count = 4000, onLost, random = Math.random } = {}) {
  let gl
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: true,   // 软件渲染（SwiftShader 等）带不动数千粒子：直接走 CSS 版
    })
  } catch {
    gl = null
  }
  if (!gl) return null
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = vs && fs ? gl.createProgram() : null
  if (prog) {
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
  }
  if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (prog) gl.deleteProgram(prog)
    if (vs) gl.deleteShader(vs)
    if (fs) gl.deleteShader(fs)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
  gl.useProgram(prog)

  // 每粒子 8 个随机数，只写一次
  const n = Math.max(1, count | 0)
  const data = new Float32Array(n * 8)
  for (let i = 0; i < data.length; i++) data[i] = random()
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  const la = gl.getAttribLocation(prog, 'aA')
  const lb = gl.getAttribLocation(prog, 'aB')
  gl.enableVertexAttribArray(la)
  gl.vertexAttribPointer(la, 4, gl.FLOAT, false, 32, 0)
  gl.enableVertexAttribArray(lb)
  gl.vertexAttribPointer(lb, 4, gl.FLOAT, false, 32, 16)

  const U = {}
  for (const k of ['uView', 'uOrb', 'uCam', 'uT', 'uIgn', 'uDpr', 'uLight']) U[k] = gl.getUniformLocation(prog, k)
  gl.enable(gl.BLEND)
  gl.clearColor(0, 0, 0, 0)

  let lost = false
  let light = -1
  const onLostEv = e => {
    e.preventDefault()
    lost = true
    onLost?.()
  }
  canvas.addEventListener('webglcontextlost', onLostEv)

  return {
    count: n,
    resize(w, h, dpr) {
      const pw = Math.max(1, Math.round(w * dpr))
      const ph = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      if (lost) return
      gl.viewport(0, 0, pw, ph)
      gl.uniform2f(U.uView, w, h)
      gl.uniform1f(U.uDpr, dpr)
    },
    /** u = { t, ign, orb:[cx,cy,r], cam:[x,y], light:0|1 }；visible=false 时只清屏 */
    render(u, visible = true) {
      if (lost || gl.isContextLost()) return false
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (!visible) return true
      if (u.light !== light) {
        light = u.light
        gl.uniform1f(U.uLight, light)
        if (light) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        else gl.blendFunc(gl.ONE, gl.ONE)
      }
      gl.uniform1f(U.uT, u.t)
      gl.uniform1f(U.uIgn, u.ign)
      gl.uniform3f(U.uOrb, u.orb[0], u.orb[1], u.orb[2])
      gl.uniform2f(U.uCam, u.cam[0], u.cam[1])
      gl.drawArrays(gl.POINTS, 0, n)
      return true
    },
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLostEv)
      try {
        gl.deleteBuffer(buf)
        gl.deleteProgram(prog)
        gl.deleteShader(vs)
        gl.deleteShader(fs)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      } catch { /* 已丢失 */ }
    },
  }
}
