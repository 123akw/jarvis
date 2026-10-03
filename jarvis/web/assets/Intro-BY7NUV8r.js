import{r as v,j as s}from"./react-DrpTdOL3.js";import{P as te,L as oe}from"./index-DSh_JnmA.js";import{createPresenceRenderer as re}from"./PresenceGL-CQDVlRhq.js";import"./markdown-E61d5k6v.js";const D=(t,a,r)=>Math.min(r,Math.max(a,t));function ae(t,a){const r=Math.round(Math.max(120,Math.min(210,t*.42,a*.24))),f=.022*a,e=D(f,4,26),H=D(f,12,22),x=D(.03*t,26,36)*1.2,L=r+e+H+(x+25.5)+H+304,C=a<640?64:64+(a-96-L)/2;return{cx:t/2,cy:C+r/2,size:r}}function X(){const t=ae(window.innerWidth,window.innerHeight);try{const a=document.querySelector(".jvl-orb .jv-presence");if(a&&a.offsetWidth>0){const r=a.getBoundingClientRect();t.cx=r.left+r.width/2,t.cy=r.top+r.height/2,t.size=a.offsetWidth}}catch{}return t}const ne=(t,a)=>["cx","cy","size"].every(r=>Math.abs(t[r]-a[r])<.5);function se(t,a,r=8){let f=Math.min(t,a)<600?2400:Math.round(D(t*a*.0052,4500,8e3));return r&&r<=4&&(f=Math.round(f*.6)),f}const ie=(t,a)=>Math.max(22,Math.min(60,Math.min(t,a)*.055)),J=`
vec3 pal(float t){t=fract(t)*4.;
vec3 a=vec3(.231,.51,.965),b=vec3(.545,.361,.965),c=vec3(.925,.282,.6),d=vec3(.961,.62,.043);
float f=smoothstep(0.,1.,fract(t));
return t<1.?mix(a,b,f):t<2.?mix(b,c,f):t<3.?mix(c,d,f):mix(d,a,f);}
`,Q=`
vec3 glowCol(float s,float T){return mix(pal(s-T*.12),pal(s*2.+T*.07+.4),.3);}
`,Z=`
uniform float uS0,uSd;
float h1(float i){return fract(sin(i*12.9898)*43758.5453);}
float vn(float x,float n){float i=floor(x),f=fract(x);
return mix(h1(mod(i,n)),h1(mod(i+1.,n)),f*f*(3.-2.*f));}
float detach(float u,float dn){return uS0+uSd*(.6*vn(u*72.,72.)+.4*vn(u*190.,190.))-.1*clamp(dn,0.,1.5);}
`,ce=`
vec4 perim(float u,vec2 H){
float L=u*4.*(H.x+H.y);
if(L<H.x)return vec4(L,H.y,0.,-1.);
if(L<H.x+2.*H.y)return vec4(H.x,H.y-(L-H.x),-1.,0.);
if(L<3.*H.x+2.*H.y)return vec4(H.x-(L-H.x-2.*H.y),-H.y,0.,1.);
if(L<3.*H.x+4.*H.y)return vec4(-H.x,-H.y+(L-3.*H.x-2.*H.y),1.,0.);
return vec4(-H.x+(L-3.*H.x-4.*H.y),H.y,0.,-1.);}
`,le="attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}",fe=`#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uC,uH;uniform float uK,uW,uT,uP,uB,uA;
${J}${Q}${Z}
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
gl_FragColor=vec4(c,max(c.r,max(c.g,c.b)));}`,ue=`precision highp float;
attribute vec4 aA;   // 远景：屏幕 x,y；流光：周长参数 u、缩进；深度种子；时序/族群种子
attribute vec4 aB;   // 落点经度、纬度、壳层深度；尺寸/颜色种子
uniform vec2 uView;  // 视口（CSS px）
uniform vec3 uOrb;   // 光球中心（CSS px，左上原点）+ 半径
uniform vec2 uCam;   // 指针视差（CSS px）
uniform float uT,uIgn,uDpr,uGw;
varying vec3 vCol;varying float vA;varying float vSoft;varying float vB;
const float PI=3.1415927;
${J}${Q}${Z}${ce}
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
gl_PointSize=max(size*uDpr,1.);}`,de=`precision mediump float;
varying vec3 vCol;varying float vA;varying float vSoft;varying float vB;
void main(){
vec2 q=gl_PointCoord*2.-1.;
float d=dot(q,q);
float core=exp(-d*16.)+.16*exp(-d*3.5);              // 合焦：亮核 + 柔光
float disc=smoothstep(1.,.7,d)*(.7+.3*d);             // 焦外：平底圆斑、边缘略亮
float glow=exp(-d*3.);                                 // 出生：一团没有边的柔光
vec3 c=vCol*mix(mix(core,disc,vSoft),glow,vB)*vA;
gl_FragColor=vec4(c,max(c.r,max(c.g,c.b)));}`;function me(t,{count:a=4e3,onLost:r,random:f=Math.random}={}){let e;try{e=t.getContext("webgl",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance",failIfMajorPerformanceCaveat:!0})}catch{e=null}if(!e)return null;const H=e.getExtension("KHR_parallel_shader_compile"),x=[],L=(o,p,P)=>{const g=e.createProgram();for(const[w,A]of[[e.VERTEX_SHADER,o],[e.FRAGMENT_SHADER,p]]){const T=e.createShader(w);e.shaderSource(T,A),e.compileShader(T),e.attachShader(g,T),x.push(T)}return P.forEach((w,A)=>e.bindAttribLocation(g,A,w)),e.linkProgram(g),g},C=L(le,fe,["a"]),y=L(ue,de,["aA","aB"]),B=[C,y],j=Math.max(1,a|0),z=new Float32Array(j*8);for(let o=0;o<z.length;o++)z[o]=f();const _=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,_),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW);const O=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,O),e.bufferData(e.ARRAY_BUFFER,z,e.STATIC_DRAW);const u={},d={};let n=0;function i(){if(H&&!B.every(o=>e.getProgramParameter(o,H.COMPLETION_STATUS_KHR)))return 0;if(!B.every(o=>e.getProgramParameter(o,e.LINK_STATUS)))return-1;for(const o of["uC","uH","uK","uW","uT","uP","uB","uA","uS0","uSd"])u[o]=e.getUniformLocation(C,o);for(const o of["uView","uOrb","uCam","uT","uIgn","uDpr","uGw","uS0","uSd"])d[o]=e.getUniformLocation(y,o);return e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),e.clearColor(0,0,0,0),1}const R=()=>{t.removeEventListener("webglcontextlost",S);try{e.deleteBuffer(_),e.deleteBuffer(O),B.forEach(o=>e.deleteProgram(o)),x.forEach(o=>e.deleteShader(o)),e.getExtension("WEBGL_lose_context")?.loseContext()}catch{}};let h=!1;const S=o=>{o.preventDefault(),h=!0,r?.()};if(t.addEventListener("webglcontextlost",S),!H&&(n=i(),n<0))return R(),null;let b=1,c=1,l=1;return{count:j,resize(o,p,P){b=o,c=p,l=P;const g=Math.max(1,Math.round(o*P)),w=Math.max(1,Math.round(p*P));(t.width!==g||t.height!==w)&&(t.width=g,t.height=w),h||e.viewport(0,0,g,w)},render(o){if(h||e.isContextLost()||(n===0&&(n=i()),n<0))return!1;if(n===0)return null;if(e.clear(e.COLOR_BUFFER_BIT),o.glow){const p=Math.min(b,c);e.useProgram(C),e.bindBuffer(e.ARRAY_BUFFER,_),e.enableVertexAttribArray(0),e.disableVertexAttribArray(1),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.uniform2f(u.uC,b*l/2,c*l/2),e.uniform2f(u.uH,b/2/p,c/2/p),e.uniform1f(u.uK,1/(p*l)),e.uniform1f(u.uW,o.gw/p),e.uniform1f(u.uT,o.t),e.uniform1f(u.uP,o.glow.p),e.uniform1f(u.uB,o.glow.b),e.uniform1f(u.uA,o.glow.a),e.uniform1f(u.uS0,o.shatter[0]),e.uniform1f(u.uSd,o.shatter[1]),e.drawArrays(e.TRIANGLES,0,3)}return o.dust&&(e.useProgram(y),e.bindBuffer(e.ARRAY_BUFFER,O),e.enableVertexAttribArray(0),e.enableVertexAttribArray(1),e.vertexAttribPointer(0,4,e.FLOAT,!1,32,0),e.vertexAttribPointer(1,4,e.FLOAT,!1,32,16),e.uniform2f(d.uView,b,c),e.uniform3f(d.uOrb,o.orb[0],o.orb[1],o.orb[2]),e.uniform2f(d.uCam,o.cam[0],o.cam[1]),e.uniform1f(d.uT,o.t),e.uniform1f(d.uIgn,o.ign),e.uniform1f(d.uDpr,l),e.uniform1f(d.uGw,o.gw),e.uniform1f(d.uS0,o.shatter[0]),e.uniform1f(d.uSd,o.shatter[1]),e.drawArrays(e.POINTS,0,j)),!0},destroy:R}}const m={end:3.3,reducedEnd:.9,shatter:[1.42,.5],glowOff:2.1,ignite:2.3,dustOff:3.25,orbAt:.5},he=t=>t<0?0:t>1?1:t,M=(t,a,r)=>he((t-a)/(r-a)),ve=t=>t<.5?4*t*t*t:1-(2-2*t)**3/2,G=t=>1-(1-t)**3;function xe(t){const a=Math.sin(Math.PI*M(t,1.2,1.6));return{a:G(M(t,.08,.6))*(1+.28*a),p:ve(M(t,.12,1.35)),b:1-M(t,1.3,1.8)}}function pe(t,a){const r=G(M(t,m.ignite,m.end)),f=G(M(t,m.ignite,m.ignite+.6)),e=(1-r)**2;return{phase:a.phase-.55*e,spin:a.spin-.45*e,energy:.72-.44*r,scale:(.84+.16*f)*a.breath,halo:.9-.4*r,sweep:0}}const ge="你好，我是贾维斯。",k=5;function we(){try{return!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches}catch{return!1}}function ye(){try{return typeof window.WebGLRenderingContext<"u"&&!navigator.connection?.saveData}catch{return!1}}function be(t){const a=["#3B82F6","#8B5CF6","#EC4899","#F59E0B","#C4B5FD","#93C5FD"],r=Math.max(window.innerWidth,window.innerHeight);return Array.from({length:t},(f,e)=>({a:Math.round(e/t*360+Math.random()*24),r:Math.round(r*(.3+Math.random()*.3)),d:(1.42+Math.random()*.45).toFixed(2),s:(3+Math.random()*4).toFixed(1),c:a[e%a.length]}))}function Se({onDone:t,authed:a=!1}){const[r,f]=v.useState(()=>we()?"reduced":ye()?"gl":"css"),[e,H]=v.useState(!1),[x,L]=v.useState(X),C=v.useRef(null),y=v.useRef(null),B=v.useRef(null),j=v.useRef(null),z=v.useRef(x);z.current=x;const _=v.useRef(t);_.current=t;const O=v.useMemo(()=>r==="css"?be(window.innerWidth<600?28:48):[],[r]);v.useEffect(()=>{const n=()=>L(R=>{const h=X();return ne(R,h)?R:h}),i=setInterval(n,300);return window.addEventListener("resize",n),()=>{clearInterval(i),window.removeEventListener("resize",n)}},[]),v.useEffect(()=>{const n=C.current;let i=!1,R=!1;const h=()=>{R||(R=!0,_.current?.())},S=[];let b=0,c=null,l=null,o=null;const p=typeof window.cancelAnimationFrame=="function"?window.cancelAnimationFrame.bind(window):clearTimeout,P=typeof window.requestAnimationFrame=="function"?window.requestAnimationFrame.bind(window):E=>setTimeout(()=>E(performance.now()),16),g=()=>document.body.classList.contains("light");if(r==="reduced")return g()&&y.current&&(y.current.style.opacity="0"),S.push(setTimeout(h,m.reducedEnd*1e3)),()=>S.forEach(clearTimeout);if(r==="gl"&&(c=me(B.current,{count:se(window.innerWidth,window.innerHeight,navigator.hardwareConcurrency),onLost:h}),!c)){f("css");return}const w=performance.now();n?.classList.add("is-run"),S.push(setTimeout(h,m.end*1e3));const A=[0,0],T=[0,0];c&&(o=E=>{T[0]=(E.clientX/window.innerWidth-.5)*40,T[1]=(E.clientY/window.innerHeight-.5)*28},window.addEventListener("pointermove",o,{passive:!0}),S.push(setTimeout(()=>{i||(l=re(j.current,{onLost:()=>{l=null,h()}}),l||H(!0))},m.orbAt*1e3)));let I=0,N=0,$=1,V=0,U=w;const q=()=>{if(i)return;b=P(q);const E=performance.now(),F=Math.max(0,(E-w)/1e3),ee=Math.min(.1,Math.max(0,(E-U)/1e3));U=E;const K=g();if(y.current&&(y.current.style.opacity=K?String(1-M(F,2.7,3.2)):"1"),!c)return;const W=z.current;(window.innerWidth!==I||window.innerHeight!==N)&&(I=window.innerWidth,N=window.innerHeight,$=Math.min(window.devicePixelRatio||1,I*N>11e5?1.5:2),c.resize(I,N,$));const Y=1-Math.exp(-ee/.35);if(A[0]+=(T[0]-A[0])*Y,A[1]+=(T[1]-A[1])*Y,F<m.dustOff+.1&&c.render({t:F,glow:F<m.glowOff?xe(F):null,dust:F<m.dustOff,orb:[W.cx,W.cy,W.size/2],cam:A,gw:ie(I,N),shatter:m.shatter,ign:m.ignite})===!1){c.destroy(),c=null,h();return}l&&F>m.ignite-.1&&(W.size!==V&&(V=W.size,l.resize(Math.round(V*1.8),Math.min(window.devicePixelRatio||1,V>200?1.5:2))),l.render({...pe(F,oe()),light:K?1:0}))};return b=P(q),()=>{i=!0,p(b),S.forEach(clearTimeout),o&&window.removeEventListener("pointermove",o),c?.destroy(),l?.destroy(),c=null,l=null}},[r]);const u={"--cx":`${x.cx}px`,"--cy":`${x.cy}px`,"--sz":`${x.size}px`},d=r==="gl";return s.jsxs("div",{ref:C,className:`jva is-${r}`,style:u,"data-mode":r,"aria-hidden":"true",children:[s.jsx("i",{ref:y,className:"jva-bg"}),!a&&s.jsx("div",{className:"jva-amb",children:s.jsxs("div",{className:"jvl-ambient",children:[s.jsx("i",{className:"jvl-key-light"}),s.jsx("i",{className:"jvl-grain"})]})}),d&&!e?s.jsx("canvas",{ref:j,className:"jva-orb"}):s.jsx("div",{className:"jva-orbcss",children:s.jsx(te,{size:x.size,quality:"css",decorative:!0})}),r!=="reduced"&&s.jsx("i",{className:"jva-ring"}),d&&s.jsx("canvas",{ref:B,className:"jva-gl"}),r==="css"&&s.jsx("i",{className:"jva-fb"}),r==="css"&&s.jsx("div",{className:"jva-dots",children:O.map((n,i)=>s.jsx("i",{style:{"--a":`${n.a}deg`,"--r":`${n.r}px`,"--d":`${n.d}s`,"--s":`${n.s}px`,"--c":n.c},children:s.jsx("b",{})},i))}),s.jsx("div",{className:"jva-line",children:[...ge].map((n,i)=>s.jsx("span",{style:{"--i":i,"--k":i-k},className:`jva-ch${i>=k&&i<k+3?" is-name":""}${"，。".includes(n)?" is-punc":""}`,children:n},i))})]})}export{Se as default};
