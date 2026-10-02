/* 「光幕」的 WebGL1 渲染：一个全屏三角形 + 一段片元着色器，无依赖。
 * 一个圆角矩形的距离场同时画三件事：贴着视口四边的彩色流光 → 收拢成圆环 → 汇成光点；
 * 最后在同一处画出与登录页一致的光球（中心深、边缘亮、左上高光、外圈紫色光晕）。
 * 长度统一按「短边 = 1」归一化，mediump 精度下也不会溢出。 */

const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'

const FS = `precision mediump float;
uniform vec2 uC,uH;uniform float uK,uR,uW,uT,uP,uB,uA,uF,uO,uL,uQ;
vec3 pal(float t){t=fract(t)*4.;
vec3 a=vec3(.231,.51,.965),b=vec3(.545,.361,.965),c=vec3(.925,.282,.6),d=vec3(.961,.62,.043);
float f=smoothstep(0.,1.,fract(t));
return t<1.?mix(a,b,f):t<2.?mix(b,c,f):t<3.?mix(c,d,f):mix(d,a,f);}
// 三层叠光（参考 Siri 流光的多层描边：锐线 + 中层 + 外层柔光），外层用高斯衰减，远离边缘不发闷
float fo(float d){float e=d/uW;return exp(-e*12.)*.9+exp(-e*3.2)*.5+exp(-e*e)*.5;}
float rv(float s){float g=uP-s;
return smoothstep(-.03,0.,g)*mix(smoothstep(0.,.04,s),1.,smoothstep(.9,1.,uP))*(1.+uB*(1.-smoothstep(.8,1.,uP))*(.8*exp(-max(g,0.)*9.)+1.1*exp(-g*g*2000.)));}
void main(){
vec2 p=(gl_FragCoord.xy-uC)*uK;
vec2 a=abs(p),q=a-uH+uR;
float d=abs(length(max(q,0.))+min(max(q.x,q.y),0.)-uR);
float dv=length(vec2(uH.x-a.x,max(a.y-uH.y,0.))),dh=length(vec2(max(a.x-uH.x,0.),uH.y-a.y));
float s=fract(atan(p.x,p.y)*.159155+1.);
// 周长参数（顶部正中起顺时针 0→1）：横边按 x、竖边按 y 投影，亮头的切口垂直于边，不是从中心射出的扇形
float Pm=max(4.*(uH.x+uH.y),.001);vec2 k=clamp(p,-uH,uH);
float sh=p.y>0.?fract(k.x/Pm+1.):(2.*(uH.x+uH.y)-k.x)/Pm;
float sv=p.x>0.?(uH.x+uH.y-k.y)/Pm:(3.*(uH.x+uH.y)+k.y)/Pm;
float m=mix(.8+.2*sin(s*31.4-uT*2.6)*sin(s*12.6+uT*1.7),1.,uQ);
vec3 col=mix(pal(s-uT*.12),pal(s*2.+uT*.07+.4),.3);
// 贴边时四条边各自发光、叠加（角上自然更亮，没有距离场对角线的折痕）；收拢后切到圆角矩形距离场
float I=mix(fo(dv)*rv(sv)+fo(dh)*rv(sh),fo(d),smoothstep(0.,.2,uQ));
vec3 c=mix(col,vec3(1.),.18*exp(-min(d,min(dv,dh))/(uW*.06)))*I*m*uA;
float rr=length(p);
c+=vec3(1.,.96,1.)*uF*exp(-rr/(uW*.5));
c=1.-exp(-c*1.3);
float disc=0.;
if(uO>0.){
float x=rr/uO;
disc=1.-smoothstep(uO-uK*1.5,uO+uK*1.5,rr);
// 球面颜色：被正弦扭曲过的斜向渐变（不用极角，球心不会出现色轮奇点）
vec2 o=p/uO,w=o+.28*vec2(sin(o.y*2.3+uT*.8),sin(o.x*2.1-uT*.6));
float u=.62+.3*w.x+.22*w.y+uT*.03;
vec3 oc=mix(pal(u),pal(u+.33),.25+.2*sin(w.x*3.-w.y*2.+uT))*1.08;
vec3 deep=mix(vec3(.043,.051,.114),vec3(.93,.94,.98),uL);
vec3 orb=mix(deep,oc,.62+.38*smoothstep(0.,1.,x));
orb+=.4*exp(-length(o-vec2(-.34,.38))*4.);
float halo=exp(-max(rr-uO,0.)/(uO*.5))*(1.-disc)*.55;
c=c*(1.-disc)+orb*disc+vec3(.4,.27,.86)*halo;
}
float al=clamp(max(max(c.r,c.g),max(c.b,disc)),0.,1.);
gl_FragColor=vec4(min(c,vec3(al)),al);}`

const NAMES = ['C', 'H', 'K', 'R', 'W', 'T', 'P', 'B', 'A', 'F', 'O', 'L', 'Q']

/** 建不出 WebGL 时返回 null，调用方走 CSS 兜底。
 *  着色器异步编译：有 KHR_parallel_shader_compile 时逐帧询问是否编好，编好前 draw 什么也不画
 *  （开场前 80ms 本来就是全黑）；不在挂载那一刻同步等编译，避免首帧卡一下。编译失败时 draw 返回 false。 */
export function createGlow(canvas) {
  let gl = null
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
  } catch { gl = null }
  if (!gl) return null
  const pr = gl.createProgram()
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    gl.attachShader(pr, sh)
  }
  gl.bindAttribLocation(pr, 0, 'a')
  gl.linkProgram(pr)
  const par = gl.getExtension('KHR_parallel_shader_compile')
  const U = {}
  let s = 1
  let state = 0   // 0 编译中，1 就绪，-1 失败

  function ready() {
    if (par && !gl.getProgramParameter(pr, par.COMPLETION_STATUS_KHR)) return 0
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return -1
    gl.useProgram(pr)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    NAMES.forEach(n => { U[n] = gl.getUniformLocation(pr, 'u' + n) })
    return 1
  }

  return {
    /** 画布按 CSS 尺寸 × min(dpr, 1.5)：流光本就是柔光，不需要满分辨率 */
    size(w, h) {
      s = Math.min(window.devicePixelRatio || 1, 1.5)
      canvas.width = Math.round(w * s)
      canvas.height = Math.round(h * s)
      gl.viewport(0, 0, canvas.width, canvas.height)
    },
    draw(t, u, L) {
      if (state === 0) state = ready()
      if (state < 1) return state === 0
      const v = Math.min(L.w, L.h)
      gl.uniform2f(U.C, u.cx * s, (L.h - u.cy) * s)
      gl.uniform2f(U.H, u.hx / v, u.hy / v)
      gl.uniform1f(U.K, 1 / (v * s))
      gl.uniform1f(U.R, u.rad / v)
      gl.uniform1f(U.W, u.wd / v)
      gl.uniform1f(U.T, t)
      gl.uniform1f(U.P, u.p)
      gl.uniform1f(U.B, u.b)
      gl.uniform1f(U.A, u.a)
      gl.uniform1f(U.F, u.f)
      gl.uniform1f(U.O, u.o / v)
      gl.uniform1f(U.L, L.light ? 1 : 0)
      gl.uniform1f(U.Q, u.q)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return true
    },
    dispose() {
      try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* 已丢失 */ }
    },
  }
}
