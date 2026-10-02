/* 流光与粒子两个着色器共用的 GLSL 片段。「光幕化作粒子」靠这里的 detach()：
 * 流光片元着色器用它决定每一段流光何时熄灭，粒子顶点着色器用它决定从这一段出发的粒子何时出现，
 * 两边同一个函数、同一组 uniform，所以熄灭和出现发生在同一帧、同一位置。 */

/** 与 PresenceGL 同一套循环四色：蓝 → 紫 → 粉 → 琥珀 */
export const PAL = `
vec3 pal(float t){t=fract(t)*4.;
vec3 a=vec3(.231,.51,.965),b=vec3(.545,.361,.965),c=vec3(.925,.282,.6),d=vec3(.961,.62,.043);
float f=smoothstep(0.,1.,fract(t));
return t<1.?mix(a,b,f):t<2.?mix(b,c,f):t<3.?mix(c,d,f):mix(d,a,f);}
`

/** 流光颜色：s = 绕视口中心、从顶部正中顺时针的角度参数（0..1） */
export const GLOW_COLOR = `
vec3 glowCol(float s,float T){return mix(pal(s-T*.12),pal(s*2.+T*.07+.4),.3);}
`

/** 碎裂时刻：周长参数 u（顶部正中起顺时针 0..1）+ 离边距离 dn（以流光宽度计）→ 这一点化作粒子的时刻（秒）。
 *  两个八度的周期值噪声（首尾相接无接缝），落在 [uS0, uS0 + uSd]；越靠里的柔光越早散，贴边的亮线最后散，
 *  看上去是光幕向内塌缩成粒子，而不是一段段整块消失。 */
export const DETACH = `
uniform float uS0,uSd;
float h1(float i){return fract(sin(i*12.9898)*43758.5453);}
float vn(float x,float n){float i=floor(x),f=fract(x);
return mix(h1(mod(i,n)),h1(mod(i+1.,n)),f*f*(3.-2.*f));}
float detach(float u,float dn){return uS0+uSd*(.6*vn(u*72.,72.)+.4*vn(u*190.,190.))-.1*clamp(dn,0.,1.5);}
`

/** 周长参数 → 视口边上的点（相对中心，y 向上）+ 向内法线；H = 半宽、半高 */
export const PERIM = `
vec4 perim(float u,vec2 H){
float L=u*4.*(H.x+H.y);
if(L<H.x)return vec4(L,H.y,0.,-1.);
if(L<H.x+2.*H.y)return vec4(H.x,H.y-(L-H.x),-1.,0.);
if(L<3.*H.x+2.*H.y)return vec4(H.x-(L-H.x-2.*H.y),-H.y,0.,1.);
if(L<3.*H.x+4.*H.y)return vec4(-H.x,-H.y+(L-3.*H.x-2.*H.y),1.,0.);
return vec4(-H.x+(L-3.*H.x-4.*H.y),H.y,0.,-1.);}
`
