/* ══════════════════════════════════════════════════════
   yatroph — site engine
   ══════════════════════════════════════════════════════ */
(function () {
  const canvas = document.getElementById("bg");
  const gl = canvas.getContext("webgl");
  if (!gl) return;

  // Check for float texture support (needed for displacement FBOs)
  const extFloat = gl.getExtension("OES_texture_float");
  const extHalfFloat = gl.getExtension("OES_texture_half_float");
  const useFloat = !!extFloat;
  const useHalfFloat = !useFloat && !!extHalfFloat;

  let mouseX = 0.5, mouseY = 0.5;
  let smoothX = 0.5, smoothY = 0.5;
  let prevSmoothX = 0.5, prevSmoothY = 0.5;
  let velX = 0.0, velY = 0.0;
  let mouseDown = false;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Resize displacement FBOs
    initFBOs();
  }
  window.addEventListener("resize", resize);

  document.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    mouseY = Math.max(0, Math.min(1, 1.0 - (e.clientY - rect.top) / rect.height));
  });
  document.addEventListener("mousedown", () => { mouseDown = true; });
  document.addEventListener("mouseup", () => { mouseDown = false; });

  // ═══ Fullscreen Quad ═════════════════════════════════
  const VS = `
    attribute vec2 a_position;
    varying vec2 vUv;
    void main() {
      vUv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // ═══════════════════════════════════════════════════════
  // DISPLACEMENT ACCUMULATION SHADER
  // Reads previous displacement, adds mouse drag, applies
  // spring-back relaxation. Ping-ponged each frame.
  // RG = displacement XY, BA = velocity XY (damped oscillator)
  // ═══════════════════════════════════════════════════════
  const FS_DISP = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D u_prevDisp;
    uniform vec2 u_mouse;
    uniform vec2 u_velocity;
    uniform vec2 u_resolution;
    uniform float u_mouseDown;

    void main() {
      vec4 prev = texture2D(u_prevDisp, vUv);
      vec2 disp = prev.rg;
      vec2 vel  = prev.ba;

      float ar = u_resolution.x / u_resolution.y;
      vec2 p = (vUv - 0.5) * vec2(ar, 1.0);
      vec2 mp = (u_mouse - 0.5) * vec2(ar, 1.0);

      float dist = length(p - mp);

      // Radial influence falloff — wide so the pull is visible
      float influence = smoothstep(0.35, 0.0, dist);
      influence *= influence; // Sharper center, softer edges

      // Drag force: mouse velocity pushes the displacement field
      vec2 dragForce = u_velocity * influence * 0.8;

      // Press dimple: when mouse is down, push inward
      vec2 toMouse = normalize(p - mp + vec2(0.0001));
      float pressForceMag = influence * u_mouseDown * 0.003;

      // Add asymmetric ridge/valley effect:
      // Pixels ahead of drag direction bunch up more
      vec2 dragDir = length(u_velocity) > 0.001 ? normalize(u_velocity) : vec2(0.0);
      float ahead = dot(toMouse, dragDir);
      float asymmetry = 0.5 + smoothstep(-0.3, 0.8, ahead) * 0.8;
      dragForce *= asymmetry;

      // Damped oscillator spring physics
      float springConst = 6.0;
      float dampConst = 4.5; // Slightly underdamped (~0.85 ratio) = fleshy
      float dt = 0.016; // ~60fps

      vec2 springForce = -springConst * disp;
      vec2 dampForce = -dampConst * vel;

      vel += (springForce + dampForce + dragForce / dt) * dt;
      vel += toMouse * pressForceMag;
      disp += vel * dt;

      // Clamp to prevent blowup
      disp = clamp(disp, vec2(-0.15), vec2(0.15));

      gl_FragColor = vec4(disp, vel);
    }
  `;

  // ═══════════════════════════════════════════════════════
  // SKIN SHADER — Research-backed techniques:
  //
  //  1. Pore rim+center profile (Jimenez GDC 2013)
  //     — raised rim catches specular, depressed center is dark
  //  2. Cavity-based specular suppression inside pores
  //  3. Sinusoidal micro-roughness on specular normal
  //  4. Fresnel-based pore fade at grazing angles (UE approach)
  //  5. GPU Gems per-channel wrap lighting
  //  6. Quilez two-pass Voronoi for cell borders
  //  7. Pink-shifted color from hemoglobin science
  //  8. Persistent displacement field from FBO for drag
  //  9. USC anisotropic stretch from accumulated displacement
  // ═══════════════════════════════════════════════════════
  const FS = `
    precision highp float;
    varying vec2 vUv;
    uniform float time;
    uniform vec2 u_mouse;
    uniform vec2 u_resolution;
    uniform sampler2D u_dispMap;

    // ── Hash ──
    vec2 h2(vec2 p){
      p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
      return -1.0 + 2.0*fract(sin(p)*43758.5453123);
    }
    vec2 hash2(vec2 p){
      return fract(sin(vec2(
        dot(p,vec2(127.1,311.7)),
        dot(p,vec2(269.5,183.3))
      ))*43758.5453);
    }

    // ── Gradient noise ──
    float gnoise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(dot(h2(i+vec2(0,0)),f-vec2(0,0)),
                     dot(h2(i+vec2(1,0)),f-vec2(1,0)),u.x),
                 mix(dot(h2(i+vec2(0,1)),f-vec2(0,1)),
                     dot(h2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);
    }

    // ── Quilez two-pass Voronoi: returns (F1 dist, border dist) ──
    vec2 voronoi2(vec2 x){
      vec2 n = floor(x);
      vec2 f = fract(x);

      vec2 mr;
      vec2 mb;
      float res = 8.0;
      for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
        vec2 b = vec2(float(i),float(j));
        vec2 r = b + hash2(n+b) - f;
        float d = dot(r,r);
        if(d < res){
          res = d;
          mr = r;
          mb = b;
        }
      }

      float f1 = sqrt(res);

      res = 8.0;
      for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
        vec2 b = mb + vec2(float(i),float(j));
        vec2 r = b + hash2(n+b) - f;
        if(dot(mr-r,mr-r) > 0.00001){
          float d = dot(0.5*(mr+r), normalize(r-mr));
          res = min(res, d);
        }
      }

      return vec2(f1, res);
    }

    void main(){
      vec2 uv = vUv;
      float ar = u_resolution.x / u_resolution.y;
      vec2 p = (uv - 0.5) * vec2(ar, 1.0);
      float t = time;

      // ── Read persistent displacement field ──
      vec4 dispData = texture2D(u_dispMap, uv);
      vec2 storedDisp = dispData.rg;
      float dispMag = length(storedDisp);
      vec2 dispDir = dispMag > 0.001 ? storedDisp / dispMag : vec2(0.0);

      // ── Breathing ──
      float breath = sin(t * 0.35) * 0.0006 + sin(t * 0.13) * 0.0004;
      p *= 1.0 + breath;

      // ══════════════════════════════════════════════════
      // DISPLACEMENT: use accumulated field for UV offset
      // This is what makes the drag feel PHYSICAL — the skin
      // stays displaced and springs back organically
      // ══════════════════════════════════════════════════

      // Apply displacement to texture coordinates
      vec2 pTex = p - storedDisp * 0.8;

      // USC Anisotropic stretch from accumulated displacement:
      // Stretch opens furrows along displacement direction,
      // compress bunches them perpendicular
      float stretchAmount = dispMag * 8.0;
      float projDisp = dot(pTex, dispDir);
      vec2 perpDisp = pTex - projDisp * dispDir;
      float stretchFactor = 1.0 / (1.0 + stretchAmount * 0.5);
      float compressFactor = 1.0 + stretchAmount * 0.3;
      vec2 pDeformed = projDisp * dispDir * stretchFactor + perpDisp * compressFactor;
      pTex = mix(pTex, pDeformed, smoothstep(0.0, 0.04, dispMag));

      // Local stretch factor for pore/furrow scaling
      float localStretch = 1.0 + dispMag * 4.0;

      // ══════════════════════════════════════════════════
      // ANATOMICAL 3D SURFACE
      // ══════════════════════════════════════════════════

      float dome = 1.0 - length(p * 0.7 + vec2(0.05, -0.03));
      dome = clamp(dome, 0.0, 1.0);
      dome = smoothstep(0.0, 1.0, dome);

      float bone1 = exp(-pow(length(p - vec2(-0.3, 0.15)), 2.0) * 4.0);
      float bone2 = exp(-pow(length(p - vec2(0.25, -0.1)), 2.0) * 3.0);
      float muscle = exp(-pow(length(p), 2.0) * 2.0) * 0.5;

      float macroHeight = dome * 0.5 + bone1 * 0.2 + bone2 * 0.15 + muscle * 0.15;

      // ══════════════════════════════════════════════════
      // SKIN MICRO-TEXTURE
      //
      // Jimenez GDC 2013 key insights:
      // 1. Pores have a RAISED RIM and DEPRESSED CENTER
      // 2. Specular is SUPPRESSED inside pore centers (cavity)
      // 3. Micro-roughness breaks specular into alive glints
      // 4. Pores fade at grazing angles (UE approach)
      // ══════════════════════════════════════════════════

      // Primary furrows — Quilez two-pass
      float furrowScale = 200.0;
      vec2 fv = voronoi2(pTex * furrowScale);
      float furrowBorder = fv.y;
      float furrow = 1.0 - smoothstep(0.0, 0.03, furrowBorder);

      // Secondary furrows
      float secScale = 380.0;
      vec2 sv = voronoi2(pTex * secScale * localStretch);
      float secFurrow = 1.0 - smoothstep(0.0, 0.025, sv.y);

      // ── PORES — rim+center profile (Jimenez) ──
      float poreScale = 280.0;
      vec2 pv = voronoi2(pTex * poreScale * localStretch);
      float poreF1 = pv.x;  // distance to nearest cell center

      // Pore profile: raised rim + depressed center
      // The rim is a ring at ~0.12 distance from cell center
      // The center is a depression at distance < 0.06
      float poreRim = smoothstep(0.0, 0.10, poreF1) * smoothstep(0.20, 0.10, poreF1);
      float poreCenter = smoothstep(0.08, 0.0, poreF1);

      // Combined height: rim raises surface, center depresses it
      float poreHeight = poreRim * 0.3 - poreCenter * 1.0;

      // Cavity map: 0 inside pore centers, 1 on surface
      // Used to suppress specular inside pores (Jimenez)
      float cavity = smoothstep(0.0, 0.10, poreF1);

      // More visible near furrow junctions
      float nearJunction = smoothstep(0.08, 0.02, furrowBorder);
      poreHeight *= (0.7 + nearJunction * 0.3);

      // Crosshatch micro-texture
      float tex1 = gnoise(pTex * 600.0 * localStretch);
      float tex2 = gnoise(pTex * 600.0 * localStretch + vec2(37.0, 73.0));
      float crosshatch = (tex1 * tex2) * 0.5 + 0.5;
      crosshatch = pow(crosshatch, 0.5) * 0.008;

      float micro = gnoise(pTex * 1100.0) * 0.003;

      // Full micro relief height map
      float microRelief = 1.0 - furrow * 0.03 - secFurrow * 0.01 + poreHeight * 0.12;

      // ══════════════════════════════════════════════════
      // NORMALS — two-scale approach
      // ══════════════════════════════════════════════════

      // Macro normals (3D curvature)
      float macroEps = 0.01;
      vec2 pMR = p + vec2(macroEps, 0.0);
      vec2 pMU = p + vec2(0.0, macroEps);

      float dome_R = smoothstep(0.0,1.0,clamp(1.0-length(pMR*0.7+vec2(0.05,-0.03)),0.0,1.0));
      float dome_U = smoothstep(0.0,1.0,clamp(1.0-length(pMU*0.7+vec2(0.05,-0.03)),0.0,1.0));
      float mhR = dome_R*0.5
                 +exp(-pow(length(pMR-vec2(-0.3,0.15)),2.0)*4.0)*0.2
                 +exp(-pow(length(pMR-vec2(0.25,-0.1)),2.0)*3.0)*0.15
                 +exp(-pow(length(pMR),2.0)*2.0)*0.5*0.15;
      float mhU = dome_U*0.5
                 +exp(-pow(length(pMU-vec2(-0.3,0.15)),2.0)*4.0)*0.2
                 +exp(-pow(length(pMU-vec2(0.25,-0.1)),2.0)*3.0)*0.15
                 +exp(-pow(length(pMU),2.0)*2.0)*0.5*0.15;

      vec3 macroNorm = normalize(vec3(
        (macroHeight - mhR) / macroEps * 1.5,
        (macroHeight - mhU) / macroEps * 1.5,
        1.0
      ));

      // Micro normals — pore rim+center creates clear normal perturbation
      float microEps = 0.0002;
      vec2 pR2 = pTex + vec2(microEps, 0.0);
      vec2 pU2 = pTex + vec2(0.0, microEps);

      // Neighbor pore heights — match rim+center profile
      vec2 pvR = voronoi2(pR2 * poreScale * localStretch);
      vec2 pvU = voronoi2(pU2 * poreScale * localStretch);
      float poreHeightR = smoothstep(0.0,0.10,pvR.x)*smoothstep(0.20,0.10,pvR.x)*0.3
                        - smoothstep(0.08,0.0,pvR.x)*1.0;
      float poreHeightU = smoothstep(0.0,0.10,pvU.x)*smoothstep(0.20,0.10,pvU.x)*0.3
                        - smoothstep(0.08,0.0,pvU.x)*1.0;

      // Neighbor furrow heights
      vec2 fvR = voronoi2(pR2 * furrowScale);
      vec2 fvU = voronoi2(pU2 * furrowScale);
      float hR2 = 1.0 - (1.0-smoothstep(0.0,0.03,fvR.y))*0.03 + poreHeightR*0.12;
      float hU2 = 1.0 - (1.0-smoothstep(0.0,0.03,fvU.y))*0.03 + poreHeightU*0.12;

      vec3 microNorm = normalize(vec3(
        (microRelief - hR2) / microEps * 0.2,
        (microRelief - hU2) / microEps * 0.2,
        1.0
      ));

      // ── Sinusoidal micro-roughness (Jimenez) ──
      // Simple sin waves that break up specular into alive glints
      // These replace the need for 298MB micro-displacement maps
      float microBump = sin(pTex.x * 900.0) * sin(pTex.y * 900.0) * 0.5
                      + sin(pTex.x * 1300.0 + pTex.y * 500.0) * 0.3
                      + sin(pTex.y * 1100.0 + pTex.x * 400.0) * 0.2;
      microBump *= 0.015;

      // ── Fresnel-based pore fade (Unreal Engine approach) ──
      // Pores are shallow, so at grazing angles they become less visible
      float viewDotN = max(0.0, macroNorm.z); // simplified for 2D: view is +Z
      float poreFade = smoothstep(0.15, 0.5, viewDotN);

      // Diffuse normal: smooth (SSS blurs micro-detail)
      vec3 normalDiffuse = normalize(macroNorm + (microNorm - vec3(0,0,1)) * 0.12 * poreFade);

      // Specular normal: sharp (shows pores + micro-roughness)
      vec3 microNormSpec = microNorm;
      microNormSpec.xy += vec2(microBump, microBump * 0.7); // Add sinusoidal breakup
      microNormSpec = normalize(microNormSpec);
      vec3 normalSpec = normalize(macroNorm + (microNormSpec - vec3(0,0,1)) * 0.8 * poreFade);

      // ══════════════════════════════════════════════════
      // LIGHTING — pink-shifted, hemoglobin-based SSS
      // ══════════════════════════════════════════════════

      vec3 lightDir = normalize(vec3(
        0.35 + (u_mouse.x - 0.5) * 0.5,
        0.5 + (u_mouse.y - 0.5) * 0.35,
        0.75
      ));
      vec3 viewDir = vec3(0.0, 0.0, 1.0);

      float NdotL = dot(normalDiffuse, lightDir);

      // Per-channel wrap lighting (GPU Gems)
      float diffR = max(0.0, (NdotL + 0.7) / 1.7);
      float diffG = max(0.0, (NdotL + 0.45) / 1.45);
      float diffB = max(0.0, (NdotL + 0.2) / 1.2);
      vec3 wrapDiff = vec3(diffR, diffG, diffB);

      // Specular — dual lobe with cavity suppression
      vec3 halfDir = normalize(lightDir + viewDir);
      float specNdotH = max(0.0, dot(normalSpec, halfDir));

      // Lobe 1: sharp oily sheen
      float specSharp = pow(specNdotH, 80.0);
      // Lobe 2: broad rough surface — pore rims break this up
      float specBroad = pow(specNdotH, 16.0);

      // Cavity suppression: specular is reduced inside pore centers
      float cavitySpec = mix(0.25, 1.0, cavity);

      // Fresnel
      float fresnel = pow(1.0 - max(0.0, dot(normalDiffuse, viewDir)), 3.0);

      // ══════════════════════════════════════════════════
      // COLOR — pink-shifted, hemoglobin-dominant
      // Key: G-B gap determines pink vs orange
      //   G ≈ B = pink, G >> B = orange
      // ══════════════════════════════════════════════════

      vec3 albedoBase  = vec3(0.84, 0.62, 0.56);
      vec3 albedoPink  = vec3(0.85, 0.56, 0.55);
      vec3 albedoPeach = vec3(0.88, 0.70, 0.60);
      vec3 albedoGold  = vec3(0.82, 0.68, 0.54);
      vec3 albedoCool  = vec3(0.74, 0.58, 0.58);

      // Anatomical regions
      float cheekFlush = exp(-pow(length(p - vec2(-0.15, 0.05)), 2.0) * 6.0);
      float browArea = exp(-pow(length(p - vec2(0.1, 0.25)), 2.0) * 5.0);
      float jawArea = exp(-pow(length(p - vec2(0.0, -0.3)), 2.0) * 3.0);
      float tZone = exp(-(p.x*p.x*8.0 + (p.y-0.1)*(p.y-0.1)*2.0) * 2.0);

      vec3 albedo = albedoBase;
      albedo = mix(albedo, albedoPink, cheekFlush * 0.5);
      albedo = mix(albedo, albedoCool, browArea * 0.3);
      albedo = mix(albedo, albedoGold, tZone * 0.25);
      albedo = mix(albedo, albedoPeach, jawArea * 0.2);

      // Melanin variation
      float melanin1 = gnoise(p * 12.0 + vec2(4.1, 7.3)) * 0.5 + 0.5;
      float melanin2 = gnoise(p * 25.0 + vec2(1.7, 9.2)) * 0.5 + 0.5;
      albedo += vec3(0.02, 0.01, -0.01) * melanin1 * 0.3;
      albedo -= vec3(0.01, 0.005, 0.0) * melanin2 * 0.15;

      // Furrows — barely change albedo
      albedo -= vec3(0.004, 0.003, 0.002) * furrow;
      albedo -= vec3(0.002, 0.001, 0.001) * secFurrow;

      // Pores — slight reddish tint in centers (blood visible in dimple)
      albedo -= vec3(0.015, 0.008, 0.005) * poreCenter;
      // Pore rims are very slightly lighter (stretched skin over rim)
      albedo += vec3(0.005, 0.003, 0.002) * poreRim;

      // ══════════════════════════════════════════════════
      // COMBINE LIGHTING
      // ══════════════════════════════════════════════════

      // Neutral ambient — let the albedo's own pink tone show
      vec3 ambient = albedo * vec3(0.48, 0.44, 0.43);

      // Soft diffuse with per-channel wrap
      vec3 col = ambient + albedo * wrapDiff * 0.50;

      // ── Subsurface scattering glow ──
      // Hemoglobin red — saturated, not brown
      float shadowAmount = 1.0 - max(0.0, NdotL);
      vec3 sssColor = vec3(0.40, 0.06, 0.06);
      float sssFactor = pow(shadowAmount, 1.5) * 0.18;
      sssFactor *= (1.0 + cheekFlush * 0.8 + browArea * 0.5);
      col += sssColor * sssFactor;

      // Deep shadow translucency — clean red
      col += vec3(0.06, 0.01, 0.01) * pow(shadowAmount, 3.0);

      // ── Fresnel rim — slightly pink ──
      col += vec3(0.16, 0.08, 0.07) * fresnel * 0.4;

      // ── Specular — dual lobe with cavity suppression ──
      // Pore rims CREATE bright spots, pore centers SUPPRESS them
      float fresnelSpec = 0.04 + 0.96 * pow(1.0 - max(0.0, dot(halfDir, viewDir)), 5.0);

      // Sharp lobe (skin oil)
      col += vec3(1.0, 0.97, 0.92) * specSharp * fresnelSpec * 0.12 * cavitySpec;
      // Broad lobe (rough surface — pore rims break this up into glints)
      col += vec3(0.95, 0.88, 0.82) * specBroad * fresnelSpec * 0.14 * cavitySpec;

      // Crosshatch + micro grain
      col += vec3(0.003) * crosshatch;
      col += micro * 0.2;

      // ══════════════════════════════════════════════════
      // DRAG RESPONSE — from persistent displacement field
      // Stretched skin shows blood, gets more translucent
      // ══════════════════════════════════════════════════

      float dragRedness = dispMag * 4.0;
      col += vec3(0.18, 0.04, 0.02) * min(dragRedness, 0.15);
      // Stretched skin = slightly lighter/more translucent
      col += vec3(0.04, 0.02, 0.01) * min(dispMag * 2.0, 0.08);

      // ══════════════════════════════════════════════════
      // PRESS RESPONSE (from displacement field center)
      // ══════════════════════════════════════════════════

      vec2 mp = (u_mouse - 0.5) * vec2(ar, 1.0);
      float md = length(p - mp);
      float pressure = exp(-md * md * 90.0);

      float blanch = pressure * 0.12;
      float blushRing = exp(-md * md * 25.0) * (1.0 - pressure) * 0.04;
      col = mix(col, vec3(0.90, 0.76, 0.70), blanch);
      col += vec3(0.06, 0.015, 0.008) * blushRing;
      col *= 1.0 - pressure * 0.03;

      // ══════════════════════════════════════════════════
      // FINAL
      // ══════════════════════════════════════════════════

      // ── Mouse-driven rotating gradient ──
      // Maps mouse position to an angle, sweeps a warm↔cool gradient
      // across the entire surface with a very large, soft radius
      float gradAngle = atan(u_mouse.y - 0.5, u_mouse.x - 0.5) + t * 0.03;
      vec2 gradDir = vec2(cos(gradAngle), sin(gradAngle));
      float gradT = dot(p, gradDir) * 0.8; // -1..1 range across canvas
      gradT = gradT * 0.5 + 0.5;           // remap to 0..1

      // Warm side: slightly more hemoglobin flush
      // Cool side: slightly more blue/purple undertone
      vec3 gradWarm = vec3(0.025, 0.008, 0.002);
      vec3 gradCool = vec3(0.005, 0.008, 0.022);
      col += mix(gradWarm, gradCool, gradT);

      // Warm vignette (subtle)
      float vig = 1.0 - length(uv - 0.5) * 0.2;
      col *= vig;
      col += vec3(0.010, 0.004, 0.002) * (1.0 - vig);

      // Ultra-fine grain
      float grain = gnoise(pTex * 2500.0 + t * 0.3) * 0.003;
      col += grain;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // ═══ Shader Compilation ══════════════════════════════
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("Shader compile error:", gl.getShaderInfoLog(s));
      gl.deleteShader(s); return null;
    }
    return s;
  }

  function createProgram(vsSrc, fsSrc) {
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("Link error:", gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  // ═══ Create programs ═════════════════════════════════
  const dispProg = createProgram(VS, FS_DISP);
  const mainProg = createProgram(VS, FS);
  if (!dispProg || !mainProg) return;

  // ═══ Fullscreen quad buffer ══════════════════════════
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);

  // Get attribute locations
  const aPosDisp = gl.getAttribLocation(dispProg, "a_position");
  const aPosMain = gl.getAttribLocation(mainProg, "a_position");

  // ═══ Displacement program uniforms ═══════════════════
  const dU = {
    prevDisp: gl.getUniformLocation(dispProg, "u_prevDisp"),
    mouse:    gl.getUniformLocation(dispProg, "u_mouse"),
    velocity: gl.getUniformLocation(dispProg, "u_velocity"),
    resolution: gl.getUniformLocation(dispProg, "u_resolution"),
    mouseDown: gl.getUniformLocation(dispProg, "u_mouseDown"),
  };

  // ═══ Main program uniforms ═══════════════════════════
  const mU = {
    time:    gl.getUniformLocation(mainProg, "time"),
    mouse:   gl.getUniformLocation(mainProg, "u_mouse"),
    resolution: gl.getUniformLocation(mainProg, "u_resolution"),
    dispMap: gl.getUniformLocation(mainProg, "u_dispMap"),
  };

  // ═══ Ping-Pong Framebuffers ══════════════════════════
  let fbo0, fbo1, tex0, tex1;
  let fboWidth = 0, fboHeight = 0;

  function createFBOTex(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    // Use the best format available
    if (useFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);
    } else if (useHalfFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, extHalfFloat.HALF_FLOAT_OES, null);
    } else {
      // Fallback: UNSIGNED_BYTE — we'll encode displacement centered at 0.5
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    return { tex, fbo };
  }

  function initFBOs() {
    // Use lower resolution for displacement (performance + smoother)
    const w = Math.max(1, Math.floor(canvas.width / 2));
    const h = Math.max(1, Math.floor(canvas.height / 2));

    if (w === fboWidth && h === fboHeight) return;
    fboWidth = w;
    fboHeight = h;

    // Clean up old
    if (tex0) gl.deleteTexture(tex0);
    if (tex1) gl.deleteTexture(tex1);
    if (fbo0) gl.deleteFramebuffer(fbo0);
    if (fbo1) gl.deleteFramebuffer(fbo1);

    const a = createFBOTex(w, h);
    const b = createFBOTex(w, h);
    tex0 = a.tex; fbo0 = a.fbo;
    tex1 = b.tex; fbo1 = b.fbo;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Initial setup
  resize();

  let pingPong = 0;

  // ═══ Render loop ═════════════════════════════════════
  function render(t) {
    smoothX += (mouseX - smoothX) * 0.08;
    smoothY += (mouseY - smoothY) * 0.08;

    velX += ((smoothX - prevSmoothX) - velX) * 0.15;
    velY += ((smoothY - prevSmoothY) - velY) * 0.15;
    prevSmoothX = smoothX;
    prevSmoothY = smoothY;

    const scaledVelX = velX * 120.0;
    const scaledVelY = velY * 120.0;

    // ── Pass 1: Update displacement field ──
    const readTex  = pingPong === 0 ? tex0 : tex1;
    const writeFbo = pingPong === 0 ? fbo1 : fbo0;
    const writeTex = pingPong === 0 ? tex1 : tex0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
    gl.viewport(0, 0, fboWidth, fboHeight);

    gl.useProgram(dispProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPosDisp);
    gl.vertexAttribPointer(aPosDisp, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readTex);
    gl.uniform1i(dU.prevDisp, 0);
    gl.uniform2f(dU.mouse, smoothX, smoothY);
    gl.uniform2f(dU.velocity, scaledVelX, scaledVelY);
    gl.uniform2f(dU.resolution, canvas.width, canvas.height);
    gl.uniform1f(dU.mouseDown, mouseDown ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ── Pass 2: Render skin with displacement ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.useProgram(mainProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(aPosMain);
    gl.vertexAttribPointer(aPosMain, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, writeTex);
    gl.uniform1i(mU.dispMap, 0);
    gl.uniform1f(mU.time, t * 0.001);
    gl.uniform2f(mU.mouse, smoothX, smoothY);
    gl.uniform2f(mU.resolution, canvas.width, canvas.height);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    pingPong = 1 - pingPong;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // ═══ "t" — font cycling ════════════════════════════
  const goodFonts = [
    '"Helvetica Neue", Arial, sans-serif',
    '"Courier New", Courier, monospace',
    '"Palatino Linotype", Palatino, serif',
    'Verdana, Geneva, sans-serif',
    '"Trebuchet MS", sans-serif',
  ];
  const chaosPool = [
    '"Helvetica Neue", Arial, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Courier New", Courier, monospace',
    'Verdana, Geneva, sans-serif',
    '"Trebuchet MS", sans-serif',
    '"Palatino Linotype", Palatino, serif',
    '"Lucida Console", Monaco, monospace',
    '"Segoe UI", Tahoma, sans-serif',
    '"Times New Roman", serif',
    'Garamond, serif',
    'Futura, "Century Gothic", sans-serif',
    '"Book Antiqua", Palatino, serif',
  ];
  let fontClicks = 0;
  const title = document.getElementById("title");
  const letterT = document.querySelector(".letter-t");
  const allSpans = title ? title.querySelectorAll("span") : [];
  // Color chaos — kicked in after 30 clicks
  const colorPool = [
    "#e84040", "#e8a040", "#40e870", "#40a0e8", "#a040e8",
    "#e840c0", "#e8e040", "#40e8d0", "#e86040", "#8040e8",
    "#ff6b6b", "#ffa94d", "#69db7c", "#4dabf7", "#da77f2",
    "#f783ac", "#ffd43b", "#63e6be", "#ff8787", "#748ffc",
  ];

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

      // After 30 clicks — start randomizing colors per letter
      if (fontClicks >= 30) {
        allSpans.forEach((s) => {
          s.style.color = colorPool[Math.floor(Math.random() * colorPool.length)];
          s.style.textShadow = "none"; // kill the matte shadow so colors pop
        });
      }
    });
  }

  // ═══ Letter physics: fear tremor, drag, fling, wall bounce, gravity ═══
  // Letters tremble subtly as mouse approaches. Hold to grab, fling on release.
  // Letters bounce off viewport walls, fall with gravity, and rest at the bottom.
  // After resting a while, they slowly crawl back home.

  const heroEl = document.getElementById("hero");

  // Global mouse position for fear detection
  let pageMX = -9999, pageMY = -9999;
  document.addEventListener("mousemove", (e) => {
    pageMX = e.clientX;
    pageMY = e.clientY;
  });

  // Shared fear animation loop
  let fearRunning = false;
  const letterStates = [];

  const fearDelay = 4000; // ms mouse must linger before trembling starts

  function fearLoop() {
    let anyFear = false;
    const now = performance.now();

    for (const st of letterStates) {
      if (st.dragging || st.flung) continue;

      const rect = st.span.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = pageMX - cx;
      const dy = pageMY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Larger fear zone: 200px radius
      const fearRadius = 200;
      const fear = Math.max(0, 1 - dist / fearRadius);

      if (fear > 0.01) {
        // Track how long mouse has been near this letter
        if (st.fearEnterTime === 0) st.fearEnterTime = now;
        const dwellTime = now - st.fearEnterTime;

        // Only tremble after 4 seconds of proximity
        if (dwellTime >= fearDelay) {
          anyFear = true;
          // Ramp up over 2 seconds after delay
          const ramp = Math.min(1, (dwellTime - fearDelay) / 2000);
          const amp = fear * fear * 0.8 * ramp;
          const speed = 0.22 + fear * 0.12;
          st.fearX = Math.sin(now * speed + st.phase) * amp;
          st.fearY = Math.cos(now * speed * 1.3 + st.phase * 2.1) * amp * 0.6;
          st.fearRot = Math.sin(now * speed * 0.9 + st.phase * 0.7) * amp * 0.3;
        } else {
          // Waiting — keep checking
          anyFear = true;
        }
      } else {
        // Mouse left — reset dwell timer
        st.fearEnterTime = 0;
        st.fearX *= 0.85;
        st.fearY *= 0.85;
        st.fearRot *= 0.85;
        if (Math.abs(st.fearX) > 0.02 || Math.abs(st.fearY) > 0.02) anyFear = true;
      }

      if (!st.animating) {
        if (Math.abs(st.fearX) > 0.02 || Math.abs(st.fearY) > 0.02 || Math.abs(st.fearRot) > 0.02) {
          st.span.style.transform = `translate(${st.fearX.toFixed(1)}px, ${st.fearY.toFixed(1)}px) rotate(${st.fearRot.toFixed(1)}deg)`;
        } else {
          st.fearX = 0; st.fearY = 0; st.fearRot = 0;
          st.span.style.transform = "";
        }
      }
    }

    if (anyFear) {
      requestAnimationFrame(fearLoop);
    } else {
      fearRunning = false;
    }
  }

  function ensureFearRunning() {
    if (!fearRunning) {
      fearRunning = true;
      requestAnimationFrame(fearLoop);
    }
  }

  document.addEventListener("mousemove", ensureFearRunning);

  allSpans.forEach((span, idx) => {
    const st = {
      span,
      x: 0, y: 0,
      vx: 0, vy: 0,
      rot: 0, vr: 0,
      dragging: false,
      animating: false,
      flung: false,
      resting: false,        // sitting on the floor
      crawling: false,       // actively crawling back home
      restTimer: null,        // countdown to crawl home
      fearX: 0, fearY: 0, fearRot: 0,
      fearEnterTime: 0,              // when mouse first entered fear radius
      phase: idx * 2.7 + Math.random() * 4,
      lastMouseX: 0, lastMouseY: 0,
      mouseVX: 0, mouseVY: 0,
      homeX: 0, homeY: 0,    // cached home position (center of span in viewport)
    };
    letterStates.push(st);

    const gravity = 0.5;        // pixels per frame^2
    const airFriction = 0.997;  // very little air drag — letters fly far
    const bounceDamp = 0.72;    // bouncier — keeps more energy on bounce
    const rotFriction = 0.985;  // rotation slows gradually
    const restDelay = 3000;     // ms to wait on floor before crawling home
    const crawlSpeed = 0.02;    // lerp factor for crawl back

    function getHomePosAndBounds() {
      // Use the span's actual bounding box for silhouette-accurate collisions
      const rect = span.getBoundingClientRect();
      const halfW = rect.width / 2;
      const halfH = rect.height / 2;
      // Home center = where span sits when offset is (0,0)
      const homeCX = rect.left + halfW - st.x;
      const homeCY = rect.top + halfH - st.y;
      const heroRect = heroEl.getBoundingClientRect();
      return {
        left:   heroRect.left   - homeCX + halfW,
        right:  heroRect.right  - homeCX - halfW,
        top:    heroRect.top    - homeCY + halfH,
        // Extra padding so letters sit flush on the floor (no gap)
        bottom: heroRect.bottom - homeCY - halfH + 8,
      };
    }

    function applyTransform() {
      span.style.transform = `translate(${st.x.toFixed(1)}px, ${st.y.toFixed(1)}px) rotate(${st.rot.toFixed(1)}deg)`;
    }

    function startCrawlHome() {
      st.restTimer = setTimeout(() => {
        st.resting = false;
        st.restTimer = null;
        st.crawling = true;
        // crawl phase — animate back to 0,0
        function crawl() {
          // If user grabbed us mid-crawl, abort
          if (!st.crawling) return;

          st.x += (0 - st.x) * crawlSpeed;
          st.y += (0 - st.y) * crawlSpeed;
          st.rot += (0 - st.rot) * crawlSpeed;

          applyTransform();

          if (Math.abs(st.x) < 0.5 && Math.abs(st.y) < 0.5 && Math.abs(st.rot) < 0.3) {
            st.x = 0; st.y = 0; st.rot = 0;
            st.vx = 0; st.vy = 0; st.vr = 0;
            span.style.transform = "";
            st.animating = false;
            st.flung = false;
            st.crawling = false;
            ensureFearRunning();
            return;
          }

          requestAnimationFrame(crawl);
        }
        requestAnimationFrame(crawl);
      }, restDelay);
    }

    function physics() {
      if (st.dragging) {
        st.vr += (st.mouseVX * 0.3 - st.vr) * 0.1;
        st.rot += st.vr;
        applyTransform();
        st.animating = true;
        requestAnimationFrame(physics);
        return;
      }

      if (st.resting) return; // sitting on floor, waiting to crawl

      // Gravity
      st.vy += gravity;

      // Air friction (very light)
      st.vx *= airFriction;
      st.vy *= airFriction;
      st.vr *= rotFriction;

      // Integrate
      st.x += st.vx;
      st.y += st.vy;
      st.rot += st.vr;

      // Wall/floor bouncing
      const bounds = getHomePosAndBounds();

      // Floor (bottom of hero)
      if (st.y > bounds.bottom) {
        st.y = bounds.bottom;
        st.vy = -st.vy * bounceDamp;
        st.vr += st.vx * 0.08; // gentle spin from floor contact
        st.vx *= 0.97; // light floor friction — letters slide along

        // If barely bouncing, stay on floor and slide
        if (Math.abs(st.vy) < 3.0) {
          st.vy = 0;
          st.vx *= 0.96; // sliding friction (gentle deceleration)
          st.vr *= 0.95;

          // Fully stopped on floor?
          if (Math.abs(st.vx) < 0.3 && Math.abs(st.vr) < 0.2) {
            st.vx = 0;
            st.vr = 0;
            st.resting = true;
            applyTransform();
            startCrawlHome();
            return;
          }
        }
      }

      // Ceiling (top of hero)
      if (st.y < bounds.top) {
        st.y = bounds.top;
        st.vy = -st.vy * bounceDamp;
      }

      // Left wall — bounce hard, keep vertical momentum
      if (st.x < bounds.left) {
        st.x = bounds.left;
        st.vx = Math.abs(st.vx) * bounceDamp; // always bounce RIGHT
        st.vr -= st.vy * 0.15; // spin from wall friction
      }

      // Right wall — bounce hard, keep vertical momentum
      if (st.x > bounds.right) {
        st.x = bounds.right;
        st.vx = -Math.abs(st.vx) * bounceDamp; // always bounce LEFT
        st.vr += st.vy * 0.15;
      }

      applyTransform();
      requestAnimationFrame(physics);
    }

    function startAnim() {
      // Cancel any pending crawl home or active crawl
      if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
      st.resting = false;
      st.crawling = false; // interrupts crawl rAF loop

      if (!st.animating) {
        st.animating = true;
        st.flung = true;
        requestAnimationFrame(physics);
      }
    }

    // Track mousedown but don't start dragging until mouse actually moves
    // This way a simple click (e.g. "t" font cycle) doesn't trigger a fling
    let mouseIsDown = false;
    let downX = 0, downY = 0;
    const dragThreshold = 4; // pixels of movement before it counts as a drag

    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      mouseIsDown = true;
      downX = e.clientX;
      downY = e.clientY;
      st.lastMouseX = e.clientX;
      st.lastMouseY = e.clientY;
      st.mouseVX = 0;
      st.mouseVY = 0;

      // Interrupt crawl-home or resting state so letter can be grabbed
      if (st.crawling || st.resting) {
        st.crawling = false;
        st.resting = false;
        st.animating = false; // reset so startAnim() can kick off physics again
        if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!mouseIsDown && !st.dragging) return;

      // Check if we've moved enough to start dragging
      if (mouseIsDown && !st.dragging) {
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        if (Math.sqrt(dx * dx + dy * dy) < dragThreshold) return;

        // Start drag
        st.dragging = true;
        span.style.cursor = "grabbing";
        st.vx = 0; st.vy = 0;
        st.fearX = 0; st.fearY = 0; st.fearRot = 0;
        startAnim();
      }

      if (!st.dragging) return;

      st.mouseVX = (e.clientX - st.lastMouseX) * 0.6 + st.mouseVX * 0.4;
      st.mouseVY = (e.clientY - st.lastMouseY) * 0.6 + st.mouseVY * 0.4;
      st.lastMouseX = e.clientX;
      st.lastMouseY = e.clientY;

      const rect = span.getBoundingClientRect();
      const homeX = rect.left + rect.width / 2 - st.x;
      const homeY = rect.top + rect.height / 2 - st.y;
      st.x = e.clientX - homeX;
      st.y = e.clientY - homeY;
    });

    document.addEventListener("mouseup", () => {
      mouseIsDown = false;
      if (!st.dragging) return;
      st.dragging = false;
      span.style.cursor = "";

      // FLING — transfer mouse velocity
      st.vx = st.mouseVX * 2.2;
      st.vy = st.mouseVY * 2.2;
      st.vr = (st.mouseVX + st.mouseVY) * 0.5;

      startAnim();
    });
  });
})();

/* ── Scroll Reveal ───────────────────────────────── */
const sections = document.querySelectorAll(".about, .projects, .contact");
const observer = new IntersectionObserver(
  (entries) => { entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add("visible"); }); },
  { threshold: 0.15 }
);
sections.forEach((s) => observer.observe(s));

/* ── Glint lines — light behind the page ─────────── */
(function () {
  const glintEls = [
    ...document.querySelectorAll(".section-label"),
    document.querySelector("footer"),
  ].filter(Boolean);

  let gmx = -9999, gmy = -9999;

  document.addEventListener("mousemove", (e) => {
    gmx = e.clientX;
    gmy = e.clientY;
  });

  // Track per-element smoothed opacity
  const glintOpacity = glintEls.map(() => 0);

  function updateGlints() {
    for (let i = 0; i < glintEls.length; i++) {
      const el = glintEls[i];
      const rect = el.getBoundingClientRect();

      // Y distance from mouse to the line itself
      // section-label: line is at bottom; footer: line is at top
      const isFooter = el.tagName === "FOOTER";
      const lineY = isFooter ? rect.top : rect.bottom;
      const dy = Math.abs(gmy - lineY);

      // Fade in within 150px, fully bright within ~30px
      const proximity = Math.max(0, 1 - dy / 150);
      const target = proximity * proximity; // quadratic falloff

      // Smooth towards target
      glintOpacity[i] += (target - glintOpacity[i]) * 0.12;

      const pct = ((gmx - rect.left) / rect.width) * 100;
      el.style.setProperty("--glint-x", pct + "%");
      el.style.setProperty("--glint-opacity", glintOpacity[i].toFixed(3));
    }
    requestAnimationFrame(updateGlints);
  }
  requestAnimationFrame(updateGlints);
})();

/* ── Peel-away interaction ───────────────────────── */
(function () {
  const peelPage = document.getElementById("peel-page");
  const peelTab = document.getElementById("peel-tab");
  const unpeelBtn = document.getElementById("unpeel-btn");
  const peelMenu = document.getElementById("peel-menu");
  if (!peelPage || !peelMenu) return;

  let peeled = false;

  function setPeel(shouldPeel) {
    peeled = shouldPeel;
    peelPage.classList.toggle("peeled", peeled);

    if (peeled) {
      setTimeout(() => {
        peelMenu.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 200);
    }
  }

  // Corner tab triggers peel
  if (peelTab) {
    peelTab.addEventListener("click", () => setPeel(true));
  }

  // Red "back" button unpeels
  if (unpeelBtn) {
    unpeelBtn.addEventListener("click", () => {
      setPeel(false);
      // Scroll back to content
      setTimeout(() => {
        peelPage.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 200);
    });
  }

  // Menu links with data-unpeel also close the peel
  peelMenu.querySelectorAll("[data-unpeel]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      setPeel(false);
      const href = link.getAttribute("href");
      setTimeout(() => {
        const target = document.querySelector(href);
        if (target) target.scrollIntoView({ behavior: "smooth" });
      }, 400);
    });
  });

  // Escape to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && peeled) setPeel(false);
  });
})();

/* ── Smooth nav scroll ───────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (e) => {
    const t = document.querySelector(link.getAttribute("href"));
    if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
  });
});
