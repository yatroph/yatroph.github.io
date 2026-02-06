/* ══════════════════════════════════════════════════════
   yatroph — site engine
   ══════════════════════════════════════════════════════ */
(function () {
  const canvas = document.getElementById("bg");
  const gl = canvas.getContext("webgl");
  if (!gl) return;

  let mouseX = 0.5, mouseY = 0.5;
  let smoothX = 0.5, smoothY = 0.5;
  let clickCount = 0;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();
  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX / window.innerWidth;
    mouseY = e.clientY / window.innerHeight;
  });

  const VS = `
    attribute vec2 a_position;
    varying vec2 vUv;
    void main() {
      vUv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // ═══ Shared GLSL ═════════════════════════════════════
  const COMMON = `
    precision highp float;
    varying vec2 vUv;
    uniform float time;
    uniform vec2 u_mouse;
  `;

  // ═══ 10 SHADERS ══════════════════════════════════════

  // 0 — Monjori-inspired organic interference (original math, not a copy)
  // Complex trigonometric interference creates organic cell-like patterns
  const S0 = COMMON + `
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      float a=time*18.0;
      float g=1.0/40.0;
      float e=400.0*(p.x*0.5+0.5);
      float f=400.0*(p.y*0.5+0.5);
      float i=200.0+sin(e*g*1.1+a/180.0)*22.0;
      float d=200.0+cos(f*g/2.2)*16.0+cos(e*g*0.9)*9.0;
      float r=sqrt(pow(abs(i-e),2.0)+pow(abs(d-f),2.0));
      float q=f/r;
      e=(r*cos(q))-a/2.5;
      f=(r*sin(q))-a/2.5;
      d=sin(e*g)*168.0+sin(e*g*1.1)*156.0+r;
      float h=((f+d)+a/2.5)*g;
      i=cos(h+r*p.x/1.4)*(e+e+a)+cos(q*g*5.5)*(r+h/3.5);
      h=sin(f*g)*136.0-sin(e*g)*204.0*p.x;
      h=(h+(f-e)*q+sin(r-(a+h)/8.0)*12.0+i/4.0)*g;
      i+=cos(h*2.1*sin(a/400.0-q))*176.0*sin(q-(r*4.1+a/14.0)*g)+tan(r*g+h)*176.0*cos(r*g+h);
      i=mod(i/5.8,256.0)/64.0;
      if(i<0.0)i+=4.0;
      if(i>=2.0)i=4.0-i;
      d=r/380.0;
      d+=sin(d*d*7.0)*0.48;
      f=(sin(a*g*0.8)+1.0)/2.0;
      vec3 c1=vec3(f*i/1.8,i/2.0+d/14.0,i)*d*p.x;
      vec3 c2=vec3(i/1.4+d/9.0,i/2.0+d/20.0,i)*d*(1.0-p.x);
      gl_FragColor=vec4(c1+c2,1.0);
    }
  `;

  // 1 — Textured skin: layered Voronoi creates pore-like organic surface
  const S1 = COMMON + `
    vec2 hash2(vec2 p){return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);}
    float voronoi(vec2 p){
      vec2 n=floor(p);vec2 f=fract(p);
      float md=8.0;
      for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
        vec2 g=vec2(float(i),float(j));
        vec2 o=hash2(n+g);
        o=0.5+0.5*sin(time*0.3+6.2831*o);
        vec2 r=g+o-f;
        float d=dot(r,r);
        md=min(md,d);
      }
      return md;
    }
    float voronoi2(vec2 p){
      vec2 n=floor(p);vec2 f=fract(p);
      float md=8.0;float md2=8.0;
      for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
        vec2 g=vec2(float(i),float(j));
        vec2 o=hash2(n+g);
        o=0.5+0.5*sin(time*0.2+6.2831*o);
        vec2 r=g+o-f;
        float d=dot(r,r);
        if(d<md){md2=md;md=d;}else if(d<md2){md2=d;}
      }
      return md2-md;
    }
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      // Layer 1: large cell structure
      float v1=voronoi(p*4.0);
      float e1=voronoi2(p*4.0);
      // Layer 2: fine detail (pores)
      float v2=voronoi(p*12.0+v1*2.0);
      float e2=voronoi2(p*12.0+v1*2.0);
      // Layer 3: micro texture
      float v3=voronoi(p*30.0+v2*1.5);
      // Compose skin-like surface
      float base=sqrt(v1)*0.6;
      float pores=e2*0.5;
      float micro=v3*0.15;
      float ridges=pow(e1,0.5)*0.6;
      float lum=base+pores+micro;
      // Subtle warm coloration
      vec3 col=vec3(0.0);
      col.r=lum*0.42+ridges*0.2+0.04;
      col.g=lum*0.35+ridges*0.15+0.02;
      col.b=lum*0.28+ridges*0.1+0.01;
      // Subsurface scattering hint
      col+=vec3(0.06,0.02,0.01)*pow(1.0-v1,3.0);
      col*=1.0-length(vUv-0.5)*0.5;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 2 — Grid dissolution: clean grid lines that warp and dissolve organically
  const S2 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=0.5;}return v;}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.2;
      // Warp the grid
      vec2 warp=vec2(fbm(p*2.0+t*0.3),fbm(p*2.0+vec2(5.2,1.3)-t*0.25));
      vec2 gp=p*8.0+warp*2.5;
      // Grid lines
      vec2 grid=abs(fract(gp)-0.5)*2.0;
      float lines=min(grid.x,grid.y);
      lines=smoothstep(0.0,0.08,lines);
      // Dissolve mask
      float dissolve=fbm(p*3.0+t*0.5);
      float mask=smoothstep(0.3,0.7,dissolve);
      // Node glow at intersections
      vec2 nearest=floor(gp)+0.5;
      float nodeDist=length(fract(gp)-0.5);
      float glow=exp(-nodeDist*nodeDist*8.0)*0.4;
      // Color
      float base=mix(0.03,0.12,lines*mask);
      vec3 col=vec3(base);
      col+=vec3(0.15,0.18,0.22)*(1.0-lines)*(1.0-mask)*0.6;
      col+=vec3(0.2,0.25,0.3)*glow*mask;
      // Subtle teal accent on some nodes
      float accent=hash(nearest)*step(0.7,hash(nearest+0.5));
      col+=vec3(0.0,0.15,0.12)*glow*accent*2.0;
      col*=1.0-length(vUv-0.5)*0.5;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 3 — Topographic: elevation map with contour lines
  const S3 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<7;i++){v+=a*noise(p);p=rot(0.45)*p*2.05+vec2(1.7,9.2);a*=0.49;}return v;}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.15;
      // Terrain elevation
      vec2 q=vec2(fbm(p*1.5+t),fbm(p*1.5+vec2(5.2,1.3)-t*0.8));
      float elevation=fbm(p*1.5+3.0*q);
      // Contour lines
      float contour=abs(fract(elevation*12.0)-0.5)*2.0;
      contour=smoothstep(0.0,0.06,contour);
      // Major contour lines (every 4th)
      float majorContour=abs(fract(elevation*3.0)-0.5)*2.0;
      majorContour=smoothstep(0.0,0.04,majorContour);
      // Height-based coloring
      vec3 low=vec3(0.03,0.04,0.06);
      vec3 mid=vec3(0.06,0.08,0.1);
      vec3 high=vec3(0.1,0.12,0.14);
      vec3 base=mix(low,mid,smoothstep(0.3,0.5,elevation));
      base=mix(base,high,smoothstep(0.6,0.8,elevation));
      // Apply contour lines
      vec3 lineCol=vec3(0.18,0.22,0.28);
      vec3 majorLineCol=vec3(0.25,0.3,0.38);
      vec3 col=mix(majorLineCol,mix(lineCol,base,contour),majorContour);
      // Subtle warm accent at peaks
      col+=vec3(0.08,0.04,0.02)*smoothstep(0.7,0.9,elevation);
      col*=1.0-length(vUv-0.5)*0.45;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 4 — Membrane: translucent biological membrane with light diffusion
  const S4 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<6;i++){v+=a*noise(p);p=rot(0.37)*p*2.1+vec2(5.3,2.7);a*=0.5;}return v;}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.25;
      // Multiple layers of warped noise for organic membrane
      float n1=fbm(p*2.0+t*0.12);
      float n2=fbm(p*2.0+vec2(3.2,8.1)+n1*3.0-t*0.1);
      float n3=fbm(p*3.5+n2*2.0+t*0.07);
      // Membrane thickness variation
      float thickness=n1*0.5+n2*0.3+n3*0.2;
      // Light passing through — thinner areas glow
      float transmit=pow(1.0-thickness,3.0);
      // Vein network
      float veins=pow(1.0-abs(n2-0.5)*2.0,6.0);
      float fineVeins=pow(1.0-abs(n3-0.5)*2.0,4.0);
      // Subsurface color
      vec3 deep=vec3(0.12,0.03,0.02);
      vec3 surface=vec3(0.18,0.1,0.07);
      vec3 glow=vec3(0.35,0.12,0.08);
      vec3 col=mix(deep,surface,thickness);
      col+=glow*transmit*0.4;
      col+=vec3(0.15,0.04,0.04)*veins*0.5;
      col+=vec3(0.1,0.03,0.02)*fineVeins*0.3;
      // Slight iridescence
      col+=vec3(0.02,0.04,0.06)*sin(n1*10.0+n2*8.0+t)*0.3;
      col*=1.0-length(vUv-0.5)*0.5;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 5 — Scales: reptilian/dragon scale texture with metallic sheen
  const S5 = COMMON + `
    vec2 hash2(vec2 p){return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);}
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.2;
      // Hex-ish grid for scales
      vec2 sp=p*6.0;
      // Offset every other row
      float row=floor(sp.y);
      sp.x+=mod(row,2.0)*0.5;
      vec2 cell=floor(sp);
      vec2 f=fract(sp)-0.5;
      // Distance to cell center — creates rounded scale shapes
      float d=length(f);
      float scaleEdge=smoothstep(0.48,0.45,d);
      // Each scale has slight offset/rotation
      float cellHash=hash(cell);
      float scaleAngle=cellHash*0.3-0.15;
      // Bump mapping — scales curve upward from edges
      float bump=1.0-d*2.0;
      bump=max(0.0,bump);
      bump=bump*bump;
      // Surface normal approximation for lighting
      vec2 normal=normalize(f)*d*2.0;
      // Light direction influenced by mouse
      vec2 lightDir=normalize(u_mouse-0.5);
      float spec=pow(max(0.0,dot(normal,lightDir)),4.0);
      // Sub-scale texture
      float micro=noise(sp*8.0+cellHash*10.0)*0.15;
      // Color per scale with subtle variation
      float hue=cellHash*0.15+noise(cell*0.5+t*0.1)*0.1;
      vec3 scaleCol=vec3(0.06+hue*0.3,0.08+hue*0.15,0.1-hue*0.05);
      // Compose
      vec3 col=vec3(0.02);
      col=mix(col,scaleCol*(0.6+bump*0.4+micro),scaleEdge);
      col+=vec3(0.15,0.17,0.2)*spec*scaleEdge*0.6;
      // Edge highlight between scales
      float edgeGlow=smoothstep(0.45,0.48,d)*smoothstep(0.52,0.48,d);
      col+=vec3(0.08,0.1,0.12)*edgeGlow*2.0;
      col*=1.0-length(vUv-0.5)*0.45;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 6 — Interference film: thin-film iridescence like oil on water
  const S6 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<6;i++){v+=a*noise(p);p=rot(0.5)*p*2.0+vec2(3.1,7.3);a*=0.5;}return v;}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.3;
      // Film thickness variation
      float thickness=fbm(p*2.5+t*0.1)*0.5+fbm(p*5.0-t*0.08)*0.3+fbm(p*10.0+t*0.05)*0.2;
      // Thin-film interference — wavelength-dependent reflection
      float phase=thickness*25.0;
      vec3 film;
      film.r=pow(sin(phase*1.0)*0.5+0.5,2.0);
      film.g=pow(sin(phase*1.15+1.0)*0.5+0.5,2.0);
      film.b=pow(sin(phase*1.3+2.0)*0.5+0.5,2.0);
      // Darken and mute
      film=film*0.25+0.03;
      // Surface flow
      float flow=fbm(p*3.0+vec2(t*0.2,0.0));
      film*=0.7+flow*0.5;
      // Specular highlight
      float spec=pow(max(0.0,sin(thickness*30.0+t)),12.0)*0.15;
      film+=vec3(spec);
      film*=1.0-length(vUv-0.5)*0.5;
      gl_FragColor=vec4(film,1.0);
    }
  `;

  // 7 — Woven: fabric/textile weave pattern with depth
  const S7 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p=rot(0.3)*p*2.0+vec2(2.3,8.1);a*=0.5;}return v;}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.15;
      // Warp the weave subtly
      vec2 warp=vec2(fbm(p+t*0.2),fbm(p+vec2(4.0,2.0)-t*0.15))*0.3;
      vec2 wp=p*10.0+warp*3.0;
      // Weave pattern: horizontal and vertical threads
      float hThread=abs(sin(wp.y*3.14159))*0.5+0.5;
      float vThread=abs(sin(wp.x*3.14159))*0.5+0.5;
      // Which thread is on top (weave pattern)
      float cellX=floor(wp.x);
      float cellY=floor(wp.y);
      float weave=mod(cellX+cellY,2.0);
      float thread=mix(hThread,vThread,weave);
      // Thread shadow
      float shadow=mix(vThread,hThread,weave)*0.3;
      // Thread fiber texture
      float fiber=noise(wp*vec2(1.0,8.0)*(1.0-weave)+wp*vec2(8.0,1.0)*weave)*0.2;
      // Compose
      float lum=thread*0.3+0.04+fiber-shadow*0.15;
      vec3 col=vec3(lum*0.9,lum*0.85,lum*0.8);
      // Slight color variation per thread
      col+=vec3(0.02,0.0,-0.01)*hash(vec2(cellX,cellY));
      col*=1.0-length(vUv-0.5)*0.45;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 8 — Caustics: underwater light caustics with fluid motion
  const S8 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.4;
      // Multiple wave layers creating caustic pattern
      float c=0.0;
      for(int i=0;i<4;i++){
        float fi=float(i);
        vec2 q=p*3.0*(1.0+fi*0.5);
        q=rot(fi*0.7+t*0.05)*q;
        // Two perpendicular wave sets
        float w1=sin(q.x*6.0+sin(q.y*3.0+t*(1.0+fi*0.3))*1.5);
        float w2=sin(q.y*6.0+sin(q.x*3.0-t*(0.8+fi*0.2))*1.5);
        // Caustic = concentrated where waves align
        c+=pow(abs(w1*w2),0.6)*0.25;
      }
      // Base color — deep blue-green
      vec3 deep=vec3(0.01,0.04,0.06);
      vec3 light=vec3(0.08,0.2,0.18);
      vec3 bright=vec3(0.15,0.35,0.3);
      vec3 col=deep;
      col+=light*c;
      col+=bright*pow(c,3.0)*2.0;
      // Subtle grain
      col+=hash(vUv*t*0.3)*0.015;
      col*=1.0-length(vUv-0.5)*0.45;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  // 9 — Terrain erosion: geological strata with erosion patterns
  const S9 = COMMON + `
    float hash(vec2 p){p=fract(p*vec2(443.897,441.423));p+=dot(p,p+19.19);return fract(p.x*p.y);}
    float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
    float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<7;i++){v+=a*noise(p);p=rot(0.45)*p*2.05+vec2(1.7,9.2);a*=0.49;}return v;}
    float ridged(vec2 p){float v=0.0,a=0.5;for(int i=0;i<6;i++){float n=abs(noise(p)*2.0-1.0);n=1.0-n;n=n*n;v+=a*n;p=rot(0.5)*p*2.1+vec2(3.7,1.2);a*=0.5;}return v;}
    void main(){
      vec2 p=-1.0+2.0*vUv;
      p+=(u_mouse-0.5)*0.4;
      p*=vec2(1.5,1.0);
      float t=time*0.1;
      // Base terrain
      float terrain=fbm(p*1.5+t*0.3);
      float erosion=ridged(p*2.0+terrain*1.5+t*0.2);
      // Strata layers
      float strata=terrain*8.0;
      float band=abs(fract(strata)-0.5)*2.0;
      band=smoothstep(0.0,0.1,band);
      // Erosion reveals lower layers
      float eroded=mix(terrain,erosion,0.4);
      // Color by depth
      vec3 rock1=vec3(0.08,0.07,0.06);
      vec3 rock2=vec3(0.12,0.1,0.08);
      vec3 rock3=vec3(0.06,0.05,0.05);
      vec3 col=mix(rock1,rock2,smoothstep(0.3,0.6,eroded));
      col=mix(col,rock3,smoothstep(0.6,0.9,eroded));
      // Strata lines
      col=mix(col*0.7,col,band);
      // Oxidation — subtle warm/cool variation
      float oxide=fbm(p*4.0+vec2(7.0,3.0))*0.5;
      col+=vec3(0.04,0.02,0.0)*smoothstep(0.4,0.7,oxide);
      col+=vec3(0.0,0.02,0.03)*smoothstep(0.5,0.8,1.0-oxide);
      col*=1.0-length(vUv-0.5)*0.45;
      gl_FragColor=vec4(col,1.0);
    }
  `;

  const shaderList = [S0, S1, S2, S3, S4, S5, S6, S7, S8, S9];

  // ═══ Compilation ═══════════════════════════════════
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("Shader compile error:", gl.getShaderInfoLog(s)); gl.deleteShader(s); return null;
    }
    return s;
  }
  function build(fs) {
    const v = compile(gl.VERTEX_SHADER, VS), f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error("Program link error:", gl.getProgramInfoLog(p)); return null; }
    return p;
  }

  const programs = shaderList.map(build);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);

  let active = programs[0];
  function use(prog) {
    active = prog; if (!active) return;
    gl.useProgram(active);
    const a = gl.getAttribLocation(active, "a_position");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  }
  use(programs[0]);

  // ═══ Render loop ═══════════════════════════════════
  function render(t) {
    if (!active) { requestAnimationFrame(render); return; }
    smoothX += (mouseX - smoothX) * 0.03;
    smoothY += (mouseY - smoothY) * 0.03;
    const ut = gl.getUniformLocation(active, "time");
    const um = gl.getUniformLocation(active, "u_mouse");
    gl.uniform1f(ut, t * 0.001);
    gl.uniform2f(um, smoothX, smoothY);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // ═══ "o" — cycle shaders ═══════════════════════════
  const letterO = document.querySelector(".letter-o");
  if (letterO) {
    letterO.addEventListener("click", () => {
      clickCount++;
      use(programs[clickCount % 10]);
    });
  }

  // ═══ "t" — font cycling ════════════════════════════
  const goodFonts = [
    '"Helvetica Neue", Arial, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Courier New", Courier, monospace',
    'Impact, "Arial Black", sans-serif',
    'Verdana, Geneva, sans-serif',
  ];
  const chaosPool = [
    '"Helvetica Neue", Arial, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Courier New", Courier, monospace',
    'Impact, "Arial Black", sans-serif',
    'Verdana, Geneva, sans-serif',
    '"Trebuchet MS", sans-serif',
    '"Palatino Linotype", Palatino, serif',
    '"Lucida Console", Monaco, monospace',
    '"Segoe UI", Tahoma, sans-serif',
    '"Times New Roman", serif',
    'Garamond, serif',
    '"Arial Black", sans-serif',
  ];
  let fontClicks = 0;
  const title = document.getElementById("title");
  const letterT = document.querySelector(".letter-t");
  const allSpans = title ? title.querySelectorAll("span") : [];
  if (letterT && title) {
    letterT.addEventListener("click", () => {
      fontClicks++;
      if (fontClicks <= 13) {
        title.style.fontFamily = goodFonts[(fontClicks - 1) % goodFonts.length];
        allSpans.forEach((s) => { s.style.fontFamily = ""; s.style.fontStyle = ""; });
      } else {
        allSpans.forEach((s) => {
          s.style.fontFamily = chaosPool[Math.floor(Math.random() * chaosPool.length)];
          s.style.fontStyle = Math.random() > 0.5 ? "italic" : "normal";
        });
      }
    });
  }
})();

/* ── Scroll Reveal ───────────────────────────────── */
const sections = document.querySelectorAll(".about, .projects, .contact");
const observer = new IntersectionObserver(
  (entries) => { entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add("visible"); }); },
  { threshold: 0.15 }
);
sections.forEach((s) => observer.observe(s));

/* ── Smooth nav scroll ───────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (e) => {
    const t = document.querySelector(link.getAttribute("href"));
    if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
  });
});
