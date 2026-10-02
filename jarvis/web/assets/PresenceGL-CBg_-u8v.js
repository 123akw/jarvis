const v=`
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`,x=`
precision highp float;
uniform vec2  uRes;
uniform float uPhase;   // 积分后的流动相位（速度变化不跳）
uniform float uSpin;    // 积分后的整体旋转角
uniform float uEnergy;  // 0..1 脉络亮度
uniform float uScale;   // 球半径缩放（含呼吸）
uniform float uHalo;    // 外光晕强度
uniform float uSweep;   // 思考扫光 0..1
uniform float uLight;   // 1 = 亮色主题

const float ORB = 0.555;  // 球半径占画布半宽的比例（画布 = 1.8 倍球径，留给光晕）

float hash(vec3 p){
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
// 五次插值的值噪声：比三次插值少网格感，大尺度流动更顺滑
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
// 循环四色：蓝 → 紫 → 粉 → 琥珀 → 蓝
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

void main(){
  float half_ = 0.5 * min(uRes.x, uRes.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / half_;        // -1..1
  float R = ORB * uScale;
  vec2 p = uv / R;                                          // 球坐标：半径 1
  float r = length(p);
  float z = sqrt(max(0.0, 1.0 - r * r));
  float c = cos(uSpin), s = sin(uSpin);
  vec3 n = vec3(c * p.x - s * p.y, s * p.x + c * p.y, z);

  // 低频域扭曲：大块色域像液体一样缓慢推挤
  float w  = fbm(n * 1.05 + vec3(0.0, 0.0, uPhase * 0.22));
  float w2 = fbm(n * 1.4 + vec3(w * 2.4 - uPhase * 0.12, w * 1.3 + uPhase * 0.1, uPhase * 0.16));
  // 色相随球面位置（连续、无接缝）+ 流场缓慢漂移：同一时刻以两三种颜色为主，不是满屏彩虹
  float t = dot(n, vec3(0.32, 0.22, 0.12)) + (w2 - 0.5) * 1.05 + uPhase * 0.03;
  vec3 col = mix(pal(t), pal(t + 0.36), smoothstep(0.28, 0.72, w));

  // 发光丝带：扭曲场的等值线，细而亮，随能量变强（待机时只隐约可见）
  float field = w2 * 2.4 + n.x * 0.6 + uPhase * 0.08;
  float rib = pow(1.0 - abs(sin(field * 3.1415926)), 20.0);

  float fres = pow(1.0 - z, 2.0);
  vec3 deep = mix(vec3(0.10, 0.08, 0.26), vec3(0.97, 0.97, 1.0), uLight);  // 靛蓝而非纯黑：暖色压暗不发灰
  vec3 orb = mix(col * 0.95, deep, (0.34 - 0.14 * uLight) * z);       // 中心略深，有体积
  orb = mix(orb, col * 1.25 + 0.08, fres * 0.8);                      // 边缘光
  orb += (col * 0.55 + 0.45) * rib * (0.05 + 0.75 * uEnergy * uEnergy) * (1.0 - 0.5 * fres);
  orb *= 0.88 + 0.26 * uEnergy;                                        // 整体亮度随状态呼吸
  float spec = max(0.0, 1.0 - length(p - vec2(-0.38, 0.46)) * 1.6);
  orb += vec3(1.0) * pow(spec, 3.0) * 0.28;                           // 玻璃高光
  // 思考扫光：一道亮弧绕球转（余弦瓣，首尾相接无接缝）
  float sweepA = atan(p.y, p.x) - uPhase * 2.2;
  orb += vec3(1.0) * uSweep * pow(0.5 + 0.5 * cos(sweepA), 10.0) * (0.2 + fres) * 0.5;
  orb = mix(orb, mix(orb, vec3(1.0), 0.3), uLight);                   // 亮色主题：粉彩
  orb = clamp(orb, 0.0, 1.0);

  float edge = 1.5 / (half_ * R);                                     // 约 1.5px 抗锯齿
  float inside = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);

  // 球外光晕：颜色跟着内部流场，向外指数衰减，画布边缘之前衰减到 0
  float d = max(r - 1.0, 0.0);
  vec3 hc = pal(atan(p.y, p.x) / 6.2831853 + uPhase * 0.03 + (w - 0.5) * 0.6);
  float halo = exp(-d * 3.6) * uHalo * smoothstep(1.0, 0.6, length(uv));
  float ha = halo * mix(0.6, 0.45, uLight) * (1.0 - inside);

  vec3 rgb = orb * inside + hc * ha;       // 预乘 alpha
  float a = clamp(inside + ha, 0.0, 1.0);
  gl_FragColor = vec4(rgb, a);
}
`;function p(t,f,e){const o=t.createShader(f);return t.shaderSource(o,e),t.compileShader(o),t.getShaderParameter(o,t.COMPILE_STATUS)?o:(t.deleteShader(o),null)}function d(t,{onLost:f}={}){let e;try{e=t.getContext("webgl",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"low-power"})}catch{e=null}if(!e)return null;const o=p(e,e.VERTEX_SHADER,v),l=p(e,e.FRAGMENT_SHADER,x);if(!o||!l)return null;const i=e.createProgram();if(e.attachShader(i,o),e.attachShader(i,l),e.linkProgram(i),!e.getProgramParameter(i,e.LINK_STATUS))return null;e.useProgram(i);const s=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,s),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW);const u=e.getAttribLocation(i,"aPos");e.enableVertexAttribArray(u),e.vertexAttribPointer(u,2,e.FLOAT,!1,0,0);const a={};for(const r of["uRes","uPhase","uSpin","uEnergy","uScale","uHalo","uSweep","uLight"])a[r]=e.getUniformLocation(i,r);e.clearColor(0,0,0,0);let n=!1;const h=r=>{r.preventDefault(),n=!0,f?.()};return t.addEventListener("webglcontextlost",h),{resize(r,m){const c=Math.max(1,Math.round(r*m));(t.width!==c||t.height!==c)&&(t.width=c,t.height=c),n||(e.viewport(0,0,c,c),e.uniform2f(a.uRes,c,c))},render(r){return n||e.isContextLost()?!1:(e.uniform1f(a.uPhase,r.phase),e.uniform1f(a.uSpin,r.spin),e.uniform1f(a.uEnergy,r.energy),e.uniform1f(a.uScale,r.scale),e.uniform1f(a.uHalo,r.halo),e.uniform1f(a.uSweep,r.sweep),e.uniform1f(a.uLight,r.light),e.drawArrays(e.TRIANGLES,0,3),!0)},destroy(){t.removeEventListener("webglcontextlost",h);try{e.deleteBuffer(s),e.deleteProgram(i),e.deleteShader(o),e.deleteShader(l),e.getExtension("WEBGL_lose_context")?.loseContext()}catch{}}}}export{d as createPresenceRenderer};
