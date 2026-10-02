import{a as r,j as e}from"./react-BzvpziFy.js";import{u as C,V as A,a as O,C as Y,N as ee,Y as se,b as W,R as T,A as te,c as U}from"./three-DVVA7pvJ.js";const oe=`
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform float uDim;
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
  float t = uTime * 0.09;

  float band  = fbm(vec2(p.x * 1.6 + t * 2.0, p.y * 3.0 - t));
  float band2 = fbm(vec2(p.x * 2.2 - t * 1.4, p.y * 4.0 + t * 0.7) + 3.7);
  float wisp  = fbm(vec2(p.x * 3.2 - t * 4.5, p.y * 6.0 + t * 1.8) + 9.1);

  vec3 deep = vec3(0.012, 0.040, 0.070);
  vec3 arc  = vec3(0.325, 0.910, 1.000);
  vec3 gold = vec3(0.940, 0.706, 0.353);

  float a1 = smoothstep(0.45, 0.90, band) * (0.6 + 0.4 * sin(uv.y * 3.0 + t * 4.0));
  float a2 = smoothstep(0.55, 0.95, band2) * 0.22;

  vec3 col = deep;
  col += arc * a1 * (1.0 - uv.y * 0.55) * 0.72;
  col += arc * a2 * 0.55;
  col += arc * smoothstep(0.60, 0.95, wisp) * 0.20;          // 快速流动的光丝
  col += gold * smoothstep(0.68, 1.0, band * band2) * 0.22;
  col += arc * exp(-uv.y * 4.0) * 0.10;                       // 底部地平线光

  vec2 cell = floor(p * 220.0);
  float star = step(0.9986, hash(cell)) * (0.5 + 0.5 * sin(t * 30.0 + hash(cell) * 20.0));
  col += vec3(star) * 0.45;

  // 缓缓上升的尘埃（格内小圆点，不是整格色块）
  vec2 q = vec2(p.x * 34.0, p.y * 34.0 - uTime * 0.9);
  vec2 fq = fract(q) - 0.5;
  float dustP = step(0.998, hash(floor(q))) * smoothstep(0.16, 0.04, length(fq));
  float tw = 0.5 + 0.5 * sin(uTime * 2.0 + hash(floor(q)) * 40.0);
  col += arc * dustP * tw * 0.6;

  // 约每 20 秒一道斜掠光束
  float ph = fract(uTime * 0.05);
  float beam = exp(-abs(uv.x + uv.y - ph * 2.4 + 0.2) * 26.0)
             * smoothstep(0.0, 0.12, ph) * smoothstep(1.0, 0.88, ph);
  col += arc * beam * 0.10;

  float d = distance(uv, uPointer);
  col += arc * exp(-d * 4.5) * 0.06;

  float vig = smoothstep(1.45, 0.30, length(uv - 0.5) * 1.6);
  col *= vig * uDim;
  gl_FragColor = vec4(col, 1.0);
}`,ne=`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`;function re({dim:t=1}){const o=r.useRef(),{size:s}=C(),a=r.useMemo(()=>({uTime:{value:0},uRes:{value:new A(1,1)},uPointer:{value:new A(.5,.5)},uDim:{value:1}}),[]);return O((m,u)=>{a.uTime.value+=u,a.uDim.value=t,a.uRes.value.set(s.width,s.height),a.uPointer.value.lerp(new A(m.pointer.x*.5+.5,m.pointer.y*.5+.5),.04)}),e.jsxs("mesh",{renderOrder:-1,frustumCulled:!1,children:[e.jsx("planeGeometry",{args:[2,2]}),e.jsx("shaderMaterial",{ref:o,vertexShader:ne,fragmentShader:oe,uniforms:a,depthWrite:!1,depthTest:!1})]})}const G="#DEE3E5",y="#CFD5D8",ae="#C3C9CF",ie="#22262B",ce="#14171B",i=-1.55;function le(){const t=document.createElement("canvas");t.width=t.height=256;const o=t.getContext("2d"),s=o.createRadialGradient(128,128,0,128,128,128);return s.addColorStop(0,"rgba(255,70,45,0.9)"),s.addColorStop(.3,"rgba(255,42,31,0.35)"),s.addColorStop(1,"rgba(255,42,31,0)"),o.fillStyle=s,o.fillRect(0,0,256,256),new U(t)}function q(t){const o=document.createElement("canvas");o.width=128,o.height=44;const s=o.getContext("2d");return s.fillStyle="#E8ECEE",s.fillRect(0,0,128,44),s.strokeStyle="#3A4045",s.lineWidth=3,s.strokeRect(0,0,128,44),s.fillStyle="#22262B",s.font="bold 26px monospace",s.textAlign="center",s.textBaseline="middle",s.fillText(t,64,24),new U(o)}function V(){const t=r.useRef({x:0,y:0,t:0});return r.useEffect(()=>{const o=s=>{t.current.x=s.clientX/window.innerWidth*2-1,t.current.y=-(s.clientY/window.innerHeight*2-1),t.current.t=performance.now()};return window.addEventListener("mousemove",o),()=>window.removeEventListener("mousemove",o)},[]),t}function E({position:t,color:o="#8F969B"}){return e.jsxs("mesh",{position:t,rotation:[Math.PI/2,0,0],children:[e.jsx("cylinderGeometry",{args:[.055,.055,.04,6]}),e.jsx("meshStandardMaterial",{color:o,metalness:.85,roughness:.4})]})}function z({mouse:t,busy:o,fail:s,spinup:a,onPick:m}){const u=r.useRef(),l=r.useRef(),p=r.useRef(),d=r.useRef(),f=r.useRef(),j=r.useRef(),M=r.useRef([]),B=r.useRef();B.current||(B.current=le());const P=r.useMemo(()=>new W(2.6,.42,.3),[]),N=r.useMemo(()=>new W(3.2,1,.6),[]),_=r.useMemo(()=>q("550W"),[]),K=r.useMemo(()=>q("H50"),[]),X=r.useRef({was:!1,n:0,tx:0,ty:0,tilt:0,nextAt:0,pulseAt:-9e9}),J=r.useMemo(()=>new T(2.2,2.6,1.2,4,.09),[]),Q=r.useMemo(()=>new T(2,2.4,.08,4,.07),[]),Z=r.useMemo(()=>new T(2.32,.3,1.28,3,.06),[]);return O((n,b)=>{const h=n.clock.elapsedTime,k=Math.min(1,b*6),x=performance.now(),c=X.current,F=x-t.current.t>3500;let g,v;if(F){if(x>c.nextAt){c.n+=1;const w=c.n%4===3;c.tx=w?0:(Math.random()*2-1)*.75,c.ty=w?0:(Math.random()*2-1)*.5,c.tilt=w?0:(Math.random()*2-1)*.05,c.nextAt=x+(w?2200:2600+Math.random()*2800),c.pulseAt=x}g=c.tx,v=c.ty}else c.was&&(c.pulseAt=x),g=t.current.x,v=t.current.y,c.tilt=0,c.nextAt=0;c.was=F,o&&!s&&(g=Math.sin(h*1.8)*.55,v=Math.sin(h*.9)*.12);const R=F?k*.45:k;l.current.rotation.y+=(g*.35-l.current.rotation.y)*R,l.current.rotation.x+=(-v*.22-l.current.rotation.x)*R,l.current.rotation.z+=(c.tilt-l.current.rotation.z)*R,u.current.position.y=Math.sin(h*.8)*.04,u.current.position.x=s?Math.sin(h*42)*.05:u.current.position.x*.9,p.current.position.x=g*.05,p.current.position.y=v*.04;const I=(x-c.pulseAt)/300,$=I<1?1+Math.sin(Math.min(I,1)*Math.PI)*.3:1;p.current.scale.setScalar($);const S=(a?2.8:s?2.4:o?1.7:1)+Math.sin(h*(o||s?7:2.1))*.18;d.current.opacity=.22*S,f.current.opacity=Math.min(1,.8*S),j.current.opacity=Math.min(1,.6*S);const[L,D,H]=M.current;L&&(L.opacity=Math.sin(h*2.4)>0?.95:.2),D&&(D.opacity=.55+.35*Math.sin(h*1.1)),H&&(H.opacity=.72+.08*Math.sin(h*13)+.05*Math.sin(h*47))}),e.jsxs("group",{ref:u,onClick:n=>{n.stopPropagation(),m?.()},onPointerOver:()=>{document.body.style.cursor="pointer"},onPointerOut:()=>{document.body.style.cursor=""},children:[e.jsxs("mesh",{position:[.5,3,0],rotation:[0,0,.12],children:[e.jsx("cylinderGeometry",{args:[.13,.13,1.4,20]}),e.jsx("meshStandardMaterial",{color:G,metalness:.2,roughness:.5})]}),e.jsxs("mesh",{position:[.42,2.35,0],children:[e.jsx("sphereGeometry",{args:[.17,24,24]}),e.jsx("meshStandardMaterial",{color:y,metalness:.3,roughness:.45})]}),e.jsxs("mesh",{position:[.21,1.99,0],rotation:[0,0,-.52],children:[e.jsx("cylinderGeometry",{args:[.11,.11,.88,20]}),e.jsx("meshStandardMaterial",{color:G,metalness:.2,roughness:.5})]}),e.jsxs("mesh",{position:[0,1.62,0],children:[e.jsx("sphereGeometry",{args:[.16,24,24]}),e.jsx("meshStandardMaterial",{color:y,metalness:.3,roughness:.45})]}),e.jsxs("group",{ref:l,position:[0,1.62,0],children:[e.jsxs("mesh",{position:[0,-.16,0],children:[e.jsx("cylinderGeometry",{args:[.1,.12,.3,16]}),e.jsx("meshStandardMaterial",{color:y,metalness:.3,roughness:.45})]}),e.jsx("mesh",{geometry:Z,position:[0,i+1.42,0],children:e.jsx("meshStandardMaterial",{color:G,metalness:.2,roughness:.5})}),[-.7,.7].map(n=>e.jsxs("mesh",{position:[n,i+1.42,.62],children:[e.jsx("boxGeometry",{args:[.22,.14,.06]}),e.jsx("meshStandardMaterial",{color:"#AEB5B9",metalness:.6,roughness:.4})]},n)),e.jsx("mesh",{geometry:J,position:[0,i,0],children:e.jsx("meshStandardMaterial",{color:G,metalness:.2,roughness:.55})}),e.jsx("mesh",{geometry:Q,position:[0,i,.63],children:e.jsx("meshStandardMaterial",{color:y,metalness:.15,roughness:.5})}),e.jsxs("mesh",{position:[0,i-.15,.675],children:[e.jsx("boxGeometry",{args:[1.96,.016,.01]}),e.jsx("meshBasicMaterial",{color:"#9AA0A4"})]}),e.jsxs("mesh",{position:[-.25,i-.72,.675],children:[e.jsx("boxGeometry",{args:[.016,1.1,.01]}),e.jsx("meshBasicMaterial",{color:"#9AA0A4"})]}),e.jsxs("mesh",{position:[-1.16,i+.7,0],children:[e.jsx("boxGeometry",{args:[.1,.5,.14]}),e.jsx("meshStandardMaterial",{color:y,metalness:.3,roughness:.45})]}),e.jsx(E,{position:[-.86,i+1.06,.68]}),e.jsx(E,{position:[.86,i+1.06,.68]}),e.jsx(E,{position:[-.86,i-1.06,.68]}),e.jsx(E,{position:[.86,i-1.06,.68]}),e.jsxs("mesh",{position:[.52,i+1.02,.68],children:[e.jsx("planeGeometry",{args:[.44,.15]}),e.jsx("meshBasicMaterial",{map:_})]}),e.jsxs("mesh",{position:[.42,i-.9,.68],children:[e.jsx("planeGeometry",{args:[.3,.11]}),e.jsx("meshBasicMaterial",{map:K})]}),e.jsxs("group",{position:[0,i+.42,.66],children:[e.jsxs("mesh",{rotation:[Math.PI/2,0,0],children:[e.jsx("cylinderGeometry",{args:[.62,.66,.1,48]}),e.jsx("meshStandardMaterial",{color:ae,metalness:.95,roughness:.25})]}),[0,1,2].map(n=>e.jsxs("mesh",{position:[0,0,.055],rotation:[0,0,n*Math.PI*2/3+.5],children:[e.jsx("boxGeometry",{args:[.5,.07,.02]}),e.jsx("meshStandardMaterial",{color:"#AEB5BB",metalness:.9,roughness:.3})]},n)),[0,1,2,3,4,5].map(n=>{const b=n*Math.PI/3;return e.jsxs("mesh",{position:[Math.cos(b)*.52,Math.sin(b)*.52,.06],rotation:[Math.PI/2,0,0],children:[e.jsx("cylinderGeometry",{args:[.035,.035,.03,6]}),e.jsx("meshStandardMaterial",{color:"#7E858B",metalness:.9,roughness:.35})]},n)}),e.jsxs("mesh",{rotation:[Math.PI/2,0,0],position:[0,0,.06],children:[e.jsx("cylinderGeometry",{args:[.3,.34,.12,32]}),e.jsx("meshStandardMaterial",{color:ie,metalness:.7,roughness:.4})]}),e.jsxs("mesh",{position:[0,0,.125],children:[e.jsx("torusGeometry",{args:[.24,.014,10,48]}),e.jsx("meshBasicMaterial",{ref:f,color:P,transparent:!0,toneMapped:!1})]}),e.jsxs("mesh",{position:[0,0,.115],children:[e.jsx("circleGeometry",{args:[.23,32]}),e.jsx("meshBasicMaterial",{color:"#0A0506"})]}),e.jsxs("group",{ref:p,position:[0,0,.13],children:[e.jsxs("mesh",{children:[e.jsx("circleGeometry",{args:[.13,28]}),e.jsx("meshBasicMaterial",{ref:j,color:P,transparent:!0,toneMapped:!1})]}),e.jsxs("mesh",{position:[0,0,.005],children:[e.jsx("circleGeometry",{args:[.055,20]}),e.jsx("meshBasicMaterial",{color:N,toneMapped:!1})]}),e.jsxs("mesh",{position:[.07,.08,.01],children:[e.jsx("circleGeometry",{args:[.02,10]}),e.jsx("meshBasicMaterial",{color:"#FFF1EE",transparent:!0,opacity:.9})]})]}),e.jsx("sprite",{position:[0,0,.16],scale:[.9,.9,1],children:e.jsx("spriteMaterial",{ref:d,map:B.current,transparent:!0,opacity:.25,blending:te,depthWrite:!1,toneMapped:!1})})]}),e.jsxs("mesh",{position:[.45,i-.45,.675],children:[e.jsx("planeGeometry",{args:[.36,.26]}),e.jsx("meshBasicMaterial",{ref:n=>{M.current[2]=n},color:"#3D9BFF",transparent:!0,opacity:.75,toneMapped:!1})]}),e.jsxs("mesh",{position:[.28,i-.72,.675],children:[e.jsx("circleGeometry",{args:[.045,16]}),e.jsx("meshBasicMaterial",{ref:n=>{M.current[0]=n},color:"#38D06A",transparent:!0,opacity:.8,toneMapped:!1})]}),e.jsxs("mesh",{position:[.6,i-.72,.675],children:[e.jsx("circleGeometry",{args:[.045,16]}),e.jsx("meshBasicMaterial",{ref:n=>{M.current[1]=n},color:"#FF3B30",transparent:!0,opacity:.7,toneMapped:!1})]}),e.jsxs("group",{position:[-.55,i-.62,.665],children:[e.jsxs("mesh",{children:[e.jsx("boxGeometry",{args:[.62,.56,.03]}),e.jsx("meshStandardMaterial",{color:ce,metalness:.4,roughness:.6})]}),[-.18,-.06,.06,.18].map(n=>e.jsxs("mesh",{position:[0,n,.02],children:[e.jsx("boxGeometry",{args:[.54,.035,.01]}),e.jsx("meshBasicMaterial",{color:"#2E3338"})]},n))]})]})]})}function de({busy:t=!1,fail:o=!1,spinup:s=!1,onPick:a}){const m=V();return e.jsx("div",{className:"mossbg",children:e.jsxs(Y,{dpr:[1,1.75],camera:{position:[0,0,5.4],fov:42},gl:{antialias:!0,alpha:!0},style:{position:"absolute",inset:0},children:[e.jsx(re,{dim:.5}),e.jsx("ambientLight",{intensity:.9}),e.jsx("pointLight",{position:[-4,3,5],intensity:40,color:"#53E8FF"}),e.jsx("pointLight",{position:[4,-2,4],intensity:55,color:"#FFFFFF"}),e.jsx("group",{position:[.35,-.1,0],scale:.62,children:e.jsx(z,{mouse:m,busy:t,fail:o,spinup:s,onPick:a})}),e.jsx(ee,{children:e.jsx(se,{mipmapBlur:!0,intensity:1.1,luminanceThreshold:.6,luminanceSmoothing:.2,radius:.7})})]})})}function me({fps:t=30}){const o=C(a=>a.invalidate),s=C(a=>a.gl);return r.useEffect(()=>{let a=0,m=!0;const u=Math.max(1,Math.round(1e3/t)),l=()=>m&&!document.hidden,p=()=>{a=0,l()&&(o(),a=setTimeout(p,u))},d=()=>{!a&&l()&&p()},f=typeof IntersectionObserver=="function"?new IntersectionObserver(j=>{m=j[j.length-1].isIntersecting,d()}):null;return f?.observe(s.domElement),document.addEventListener("visibilitychange",d),d(),()=>{clearTimeout(a),f?.disconnect(),document.removeEventListener("visibilitychange",d)}},[t,s,o]),null}function xe({busy:t=!1}){const o=V();return e.jsxs(Y,{frameloop:"demand",dpr:[1,1.5],camera:{position:[0,0,5.6],fov:40},gl:{antialias:!0,alpha:!0},children:[e.jsx(me,{fps:30}),e.jsx("ambientLight",{intensity:.95}),e.jsx("pointLight",{position:[-4,3,5],intensity:28,color:"#53E8FF"}),e.jsx("pointLight",{position:[4,-2,4],intensity:42,color:"#FFFFFF"}),e.jsx("group",{position:[0,.78,0],scale:.52,children:e.jsx(z,{mouse:o,busy:t,fail:!1,spinup:!1})})]})}export{xe as MossMini,de as default};
