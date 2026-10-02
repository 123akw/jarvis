/**
 * 「唤醒」的 WebGL1 场景：一个上下文、两段程序，零依赖。
 *   流光：全屏三角形 + 片元着色器。贴着视口四边的 Apple 式彩色流光（亮头绕一周 + 三层叠光），
 *         从 uS0 起按 detach(u) 一段段熄灭。
 *   粒子：一次 drawArrays(POINTS)。每个粒子只在初始化时写 8 个随机数，之后 JS 每帧只写 uniform，
 *         位置 / 透视 / 景深 / 颜色全在顶点着色器里按时间算。六成粒子出生在流光上（熄灭的同一刻、
 *         同一位置、同一颜色），四成是远景里若隐若现的焦外光斑；两者都沿绕光球的漩涡弧线汇聚到
 *         半径 R 的球壳——正是登录页光球的位置和尺寸。
 * 空间约定：焦平面 z=0 上 1 个世界单位 = 1 CSS px，镜头在 +z，以光球中心为透视中心。
 * 有 KHR_parallel_shader_compile 时着色器在后台编译：编好之前 render() 返回 null、什么也不画。
 */
import { DETACH, GLOW_COLOR, PAL, PERIM } from './glsl.js'

const GLOW_VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'

// 流光（取自「光幕」方案）：长度按短边 = 1 归一化
const GLOW_FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uC,uH;uniform float uK,uW,uT,uP,uB,uA;
${PAL}${GLOW_COLOR}${DETACH}
// 三层叠光（锐线 + 中层 + 外层柔光）
float fo(float d){float e=d/uW;return exp(-e*12.)*.9+exp(-e*3.2)*.5+exp(-e*e)*.5;}
// 亮头：从顶部正中顺时针揭开，头部更亮，绕完一周后熔进整圈
float rv(float s){float g=uP-s;
return smoothstep(-.03,0.,g)*mix(smoothstep(0.,.04,s),1.,smoothstep(.9,1.,uP))*(1.+uB*(1.-smoothstep(.8,1.,uP))*(.8*exp(-max(g,0.)*9.)+1.1*exp(-g*g*2000.)));}
// 碎裂：这一点到 detach() 时熄灭（拖一点余晖），同一刻粒子在这里出生
float keep(float u,float d){return 1.-smoothstep(-.04,.16,uT-detach(u,d/uW));}
void main(){
vec2 p=(gl_FragCoord.xy-uC)*uK;
vec2 a=abs(p);
float dv=length(vec2(uH.x-a.x,max(a.y-uH.y,0.))),dh=length(vec2(max(a.x-uH.x,0.),uH.y-a.y));
float s=fract(atan(p.x,p.y)*.159155+1.);
float Pm=4.*(uH.x+uH.y);vec2 k=clamp(p,-uH,uH);
float sh=p.y>0.?fract(k.x/Pm+1.):(2.*(uH.x+uH.y)-k.x)/Pm;
float sv=p.x>0.?(uH.x+uH.y-k.y)/Pm:(3.*(uH.x+uH.y)+k.y)/Pm;
float m=.8+.2*sin(s*31.4-uT*2.6)*sin(s*12.6+uT*1.7);
float I=fo(dv)*rv(sv)*keep(sv,dv)+fo(dh)*rv(sh)*keep(sh,dh);
vec3 c=mix(glowCol(s,uT),vec3(1.),.18*exp(-min(dv,dh)/(uW*.06)))*I*m*uA;
c=1.-exp(-c*1.3);
gl_FragColor=vec4(c,max(c.r,max(c.g,c.b)));}`

const DUST_VS = `precision highp float;
attribute vec4 aA;   // 远景：屏幕 x,y；流光：周长参数 u、缩进；深度种子；时序/族群种子
attribute vec4 aB;   // 落点经度、纬度、壳层深度；尺寸/颜色种子
uniform vec2 uView;  // 视口（CSS px）
uniform vec3 uOrb;   // 光球中心（CSS px，左上原点）+ 半径
uniform vec2 uCam;   // 指针视差（CSS px）
uniform float uT,uIgn,uDpr,uGw;
varying vec3 vCol;varying float vA;varying float vSoft;varying float vB;
const float PI=3.1415927;
${PAL}${GLOW_COLOR}${DETACH}${PERIM}
// 起步零速、落地长尾减速：像被引力慢慢拉动，到位时轻轻停住
float ease(float t){float e=t*t*(3.-2.*t);return 1.-pow(1.-e,1.8);}
void main(){
float F=max(uView.x,uView.y)*1.15;
vec2 C=uOrb.xy;float R=uOrb.z;
float jit=fract(aA.w*7.31);
float edge=step(fract(aA.w*13.7),.68);
// 远景：撒满屏幕、全在焦平面之后（焦点在大字和流光上，它们是焦外光斑）
vec2 bs=(aA.xy*1.2-.1)*uView;float bz=mix(-1.9,-.3,aA.z)*F;
float bd=clamp(length(bs-C)/max(uView.x,uView.y),0.,1.);
// 流光：出生在视口边上（与流光同一套周长参数），向内缩进至多一个流光宽度
vec4 pe=perim(aA.x,uView*.5);
float dn=.85*aA.y*aA.y;
vec2 es=uView*.5+vec2(pe.x,-pe.y)+vec2(pe.z,-pe.w)*uGw*dn;
vec2 s0=mix(bs,es,edge);float z0=mix(bz,(aA.z-.5)*.1*F,edge);
vec3 S=vec3(C+(s0-C)*(F-z0)/F,z0);
float td=detach(aA.x,dn);
float t0=mix(1.5+.25*bd+.15*jit,td,edge);
float dur=mix(.75,.62,edge)+mix(.15,.2,edge)*fract(aB.w*5.17);
float t=clamp((uT-t0)/dur,0.,1.);
float land=max(uIgn,t0+dur);
float absorb=smoothstep(land-.05,land+.32+.2*jit,uT);
// 落点：球壳（绕纵轴慢转），被点亮的光球吸收时向内收一点
float th=aB.x*2.*PI+uT*.5;
float cy=aB.y*2.-1.;float sy=sqrt(1.-cy*cy);
vec3 dir=vec3(sy*cos(th),cy,sy*sin(th));
float shell=(1.-.28*aB.z*aB.z)*(1.-.14*absorb);
vec3 E=vec3(C+dir.xy*R*shell,dir.z*R*shell);
// 漩涡弧线：统一旋向，终点角度不变，多绕的弧度在途中消化
vec2 sr=S.xy-C,er=E.xy-C;
float a0=atan(sr.y,sr.x),ae=atan(er.y,er.x);
float sw=mod(ae-a0-1.3+PI,2.*PI)-PI+1.3;
float ang=a0+sw*ease(min(1.,t*1.12));
float rad=mix(length(sr),length(er),ease(t));
vec3 P=vec3(C+rad*vec2(cos(ang),sin(ang)),mix(S.z,E.z,ease(min(1.,t*1.06))));
// 镜头：0–1.4s 缓慢推近并漂移（只影响远景），碎裂开始时已停在焦平面，粒子正好从流光的位置出发
float dolly=1.-ease(clamp(uT/1.4,0.,1.));
vec2 cam=uCam+vec2(sin(uT*.9),cos(uT*.7))*12.*dolly;
float zp=P.z-.18*F*dolly;
float s=F/max(F-zp,1.);
vec2 scr=C+(P.xy-C-cam)*s+cam;
// 景深：焦平面清晰，远景是焦外圆斑（能量摊薄）
float coc=15.*abs(s-1.);
float base=(1.1+2.3*aB.w*aB.w*aB.w)*s*2.4;
// 流光粒子出生时先是一团柔光（与流光的柔边衔接），随即收成亮点
float bp=edge*exp(-pow((uT-td)/.14,2.));
float size=(base+coc)*(1.+2.2*bp);
vSoft=clamp(coc/size*1.3,0.,1.);
vB=bp;
// 亮度：远景先暗着、被唤醒后才亮；流光粒子在熄灭的同一刻出现并一闪；点亮时再一闪，随后被吸收
float vig=mix(1.,.45,smoothstep(.22,.7,bd));
float twk=.75+.25*sin(uT*6.+aA.w*40.);
float wb=smoothstep(.15,1.,uT)*mix(.42*twk*vig,.85,t);
float we=smoothstep(td-.06,td+.08,uT)*(1.+1.6*exp(-pow((uT-td)/.1,2.)));
float flash=1.+.9*exp(-pow((uT-land)*6.,2.))*step(uIgn-.2,uT);
float al=1.5*mix(wb,we,edge)*pow(base/(base+coc),1.25)/(1.+1.2*bp)*mix(1.,.8,t*t)*flash*(1.-absorb);
// 颜色：流光粒子取出生处的流光色，远景是偏白的四色微光；落地时都变成光球同一位置的色相
float sa=fract(atan(es.x-uView.x*.5,uView.y*.5-es.y)*.159155+1.);
vec3 c0=mix(mix(pal(aA.x*.6+aA.y*.35+aA.w*.5),vec3(1.),.38),glowCol(sa,uT)*1.1+.12,edge);
vec3 c1=pal(dot(dir,vec3(.32,.22,.12))+.15)*1.15+.06;
vCol=mix(c0,c1,smoothstep(.25,1.,t));
vA=al;
// 看不见的粒子扔出裁剪空间：不进光栅化
gl_Position=al<.002?vec4(2.,2.,2.,1.):vec4(scr.x/uView.x*2.-1.,1.-scr.y/uView.y*2.,0.,1.);
gl_PointSize=max(size*uDpr,1.);}`

const DUST_FS = `precision mediump float;
varying vec3 vCol;varying float vA;varying float vSoft;varying float vB;
void main(){
vec2 q=gl_PointCoord*2.-1.;
float d=dot(q,q);
float core=exp(-d*16.)+.16*exp(-d*3.5);              // 合焦：亮核 + 柔光
float disc=smoothstep(1.,.7,d)*(.7+.3*d);             // 焦外：平底圆斑、边缘略亮
float glow=exp(-d*3.);                                 // 出生：一团没有边的柔光
vec3 c=vCol*mix(mix(core,disc,vSoft),glow,vB)*vA;
gl_FragColor=vec4(c,max(c.r,max(c.g,c.b)));}`       // 发光叠加：alpha 取最大通道，预乘合法

/** 建场景；建不出上下文（含软件渲染被拒）或同步编译失败返回 null，调用方走 CSS 版。 */
export function createScene(canvas, { count = 4000, onLost, random = Math.random } = {}) {
  let gl
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: true,   // SwiftShader 等软件渲染带不动数千粒子：直接走 CSS 版
    })
  } catch {
    gl = null
  }
  if (!gl) return null
  const par = gl.getExtension('KHR_parallel_shader_compile')
  const shaders = []
  const build = (vsrc, fsrc, attrs) => {
    const p = gl.createProgram()
    for (const [type, src] of [[gl.VERTEX_SHADER, vsrc], [gl.FRAGMENT_SHADER, fsrc]]) {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      gl.attachShader(p, sh)
      shaders.push(sh)
    }
    attrs.forEach((n, i) => gl.bindAttribLocation(p, i, n))
    gl.linkProgram(p)
    return p
  }
  const glow = build(GLOW_VS, GLOW_FS, ['a'])
  const dust = build(DUST_VS, DUST_FS, ['aA', 'aB'])
  const progs = [glow, dust]

  const n = Math.max(1, count | 0)
  const data = new Float32Array(n * 8)
  for (let i = 0; i < data.length; i++) data[i] = random()
  const tri = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, tri)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const pts = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, pts)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)

  const G = {}
  const D = {}
  let state = 0   // 0 编译中，1 就绪，-1 失败
  function ready() {
    if (par && !progs.every(p => gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR))) return 0
    if (!progs.every(p => gl.getProgramParameter(p, gl.LINK_STATUS))) return -1
    for (const k of ['uC', 'uH', 'uK', 'uW', 'uT', 'uP', 'uB', 'uA', 'uS0', 'uSd']) G[k] = gl.getUniformLocation(glow, k)
    for (const k of ['uView', 'uOrb', 'uCam', 'uT', 'uIgn', 'uDpr', 'uGw', 'uS0', 'uSd']) D[k] = gl.getUniformLocation(dust, k)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.clearColor(0, 0, 0, 0)
    return 1
  }
  const destroy = () => {
    canvas.removeEventListener('webglcontextlost', onLostEv)
    try {
      gl.deleteBuffer(tri)
      gl.deleteBuffer(pts)
      progs.forEach(p => gl.deleteProgram(p))
      shaders.forEach(sh => gl.deleteShader(sh))
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { /* 已丢失 */ }
  }
  let lost = false
  const onLostEv = e => {
    e.preventDefault()
    lost = true
    onLost?.()
  }
  canvas.addEventListener('webglcontextlost', onLostEv)
  if (!par) {
    state = ready()
    if (state < 0) { destroy(); return null }
  }

  let W = 1
  let H = 1
  let dpr = 1
  return {
    count: n,
    resize(w, h, ratio) {
      W = w
      H = h
      dpr = ratio
      const pw = Math.max(1, Math.round(w * ratio))
      const ph = Math.max(1, Math.round(h * ratio))
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      if (!lost) gl.viewport(0, 0, pw, ph)
    },
    /** u = { t, glow:{a,p,b}|null, dust:bool, orb:[cx,cy,r], cam:[x,y], gw, shatter:[s0,sd], ign }
     *  返回 true 已画；null 着色器还在编译；false 失败 / 上下文丢失 */
    render(u) {
      if (lost || gl.isContextLost()) return false
      if (state === 0) state = ready()
      if (state < 0) return false
      if (state === 0) return null
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (u.glow) {
        const v = Math.min(W, H)
        gl.useProgram(glow)
        gl.bindBuffer(gl.ARRAY_BUFFER, tri)
        gl.enableVertexAttribArray(0)
        gl.disableVertexAttribArray(1)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
        gl.uniform2f(G.uC, W * dpr / 2, H * dpr / 2)
        gl.uniform2f(G.uH, W / 2 / v, H / 2 / v)
        gl.uniform1f(G.uK, 1 / (v * dpr))
        gl.uniform1f(G.uW, u.gw / v)
        gl.uniform1f(G.uT, u.t)
        gl.uniform1f(G.uP, u.glow.p)
        gl.uniform1f(G.uB, u.glow.b)
        gl.uniform1f(G.uA, u.glow.a)
        gl.uniform1f(G.uS0, u.shatter[0])
        gl.uniform1f(G.uSd, u.shatter[1])
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      if (u.dust) {
        gl.useProgram(dust)
        gl.bindBuffer(gl.ARRAY_BUFFER, pts)
        gl.enableVertexAttribArray(0)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0)
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16)
        gl.uniform2f(D.uView, W, H)
        gl.uniform3f(D.uOrb, u.orb[0], u.orb[1], u.orb[2])
        gl.uniform2f(D.uCam, u.cam[0], u.cam[1])
        gl.uniform1f(D.uT, u.t)
        gl.uniform1f(D.uIgn, u.ign)
        gl.uniform1f(D.uDpr, dpr)
        gl.uniform1f(D.uGw, u.gw)
        gl.uniform1f(D.uS0, u.shatter[0])
        gl.uniform1f(D.uSd, u.shatter[1])
        gl.drawArrays(gl.POINTS, 0, n)
      }
      return true
    },
    destroy,
  }
}
