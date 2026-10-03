// GLSL ES 3.00 sources.

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const HASH = `
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

// ---------------------------------------------------------------- particles
// Every particle carries two "slots" (A = previous shape, B = next shape) and morphs between
// them. A slot is (params vec4, color+size vec4, kind float); the kind decides how params
// turn into a position, so animated formations (rail traffic, tunnels, rain) live on the GPU.
export const PARTICLE_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec4 aSeed;
layout(location = 1) in vec4 aPA;
layout(location = 2) in vec4 aCA;
layout(location = 3) in float aKA;
layout(location = 4) in vec4 aPB;
layout(location = 5) in vec4 aCB;
layout(location = 6) in float aKB;

uniform mat4 uVP;
uniform vec3 uCam;
uniform float uTime, uTA, uTB, uMix, uScatter, uTurb, uBeat, uPointScale, uAlpha, uSizeMul, uSwirl;
uniform sampler2D uPathA, uPathB;
uniform vec3 uCenterA, uCenterB;

out vec3 vCol;

const float K = 256.0;

vec3 pathAt(sampler2D tex, float row, float u, out float closed) {
  float x = u * (K - 1.0);
  float i0 = floor(x);
  vec4 a = texelFetch(tex, ivec2(int(i0), int(row)), 0);
  vec4 b = texelFetch(tex, ivec2(int(min(i0 + 1.0, K - 1.0)), int(row)), 0);
  closed = a.w;
  return mix(a.xyz, b.xyz, x - i0);
}

vec3 slotPos(float kind, vec4 P, float t, sampler2D tex, vec3 center, out float fade) {
  fade = 1.0;
  if (kind < 0.5) { fade = 0.0; return (aSeed.xyz - 0.5) * 160.0; }
  if (kind < 1.5) {
    vec3 j = vec3(sin(uTime * 1.7 + aSeed.y * 40.0), sin(uTime * 1.3 + aSeed.z * 40.0), sin(uTime * 1.1 + aSeed.w * 40.0));
    return P.xyz + j * P.w;
  }
  if (kind < 2.5) {
    float u = fract(P.y + P.z * t);
    float closed;
    vec3 p = pathAt(tex, P.x, u, closed);
    if (closed < 0.5) fade = smoothstep(0.0, 0.03, u) * smoothstep(1.0, 0.97, u);
    return p + (aSeed.yzw - 0.5) * P.w;
  }
  if (kind < 3.5) {
    vec3 box = vec3(70.0, 46.0, 70.0);
    vec3 p = P.xyz;
    p.y -= P.w * t;
    vec3 q = mod(p - uCam + box * 0.5, box) - box * 0.5;
    fade = smoothstep(35.0, 20.0, length(q.xz));
    return uCam + q;
  }
  if (kind < 4.5) {
    float L = 160.0;
    float z = 12.0 - L + mod(P.y + P.w * t, L);
    float a = P.x + z * 0.012 + t * 0.22;
    float r = P.z * (1.0 + 0.12 * uBeat);
    fade = smoothstep(12.0 - L, 32.0 - L, z) * smoothstep(12.0, 2.0, z);
    return vec3(cos(a) * r, sin(a) * r, z);
  }
  if (kind < 5.5) {
    float a = P.y + P.w * t;
    return center + vec3(cos(a) * P.x, P.z + sin(t * 0.6 + P.y * 3.0) * 0.8, sin(a) * P.x);
  }
  if (kind < 6.5) {
    vec3 p = P.xyz;
    float s = t * 0.35;
    p += P.w * vec3(sin(p.y * 0.21 + s + aSeed.x * 6.28), sin(p.z * 0.17 + s * 1.3 + aSeed.y * 6.28), sin(p.x * 0.19 + s * 0.9 + aSeed.z * 6.28));
    return p;
  }
  float H = 48.0, top = 24.0;
  vec3 p = P.xyz;
  p.y = top - mod(top - (p.y - P.w * t), H);
  fade = smoothstep(top - H, top - H + 8.0, p.y) * smoothstep(top, top - 4.0, p.y);
  return p;
}

void main() {
  float fA, fB;
  vec3 pA = slotPos(aKA, aPA, uTA, uPathA, uCenterA, fA);
  vec3 pB = slotPos(aKB, aPB, uTB, uPathB, uCenterB, fB);

  float m = clamp(uMix * 1.6 - aSeed.x * 0.6, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  float mid = sin(m * 3.14159265);
  vec3 p = mix(pA, pB, m);
  vec3 dir = normalize(aSeed.yzw - 0.5 + 1e-4);
  p += dir * mid * uScatter * (0.35 + aSeed.x);
  float sw = mid * uSwirl * (0.5 + aSeed.w);
  p.xz = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * p.xz;
  p += uTurb * vec3(sin(p.y * 0.45 + uTime * 1.9 + aSeed.y * 6.28), sin(p.z * 0.45 + uTime * 1.7 + aSeed.z * 6.28), sin(p.x * 0.45 + uTime * 1.3 + aSeed.w * 6.28));

  vec4 cA = aCA, cB = aCB;
  if (aKA < 0.5) cA = vec4(cB.rgb, 0.0);
  if (aKB < 0.5) cB = vec4(cA.rgb, 0.0);
  vec4 c = mix(cA, cB, m);
  float fade = mix(fA, fB, m);

  vec4 clip = uVP * vec4(p, 1.0);
  gl_Position = clip.w < 0.05 ? vec4(2.0, 2.0, 2.0, 1.0) : clip;

  float size = c.w * uSizeMul * (1.0 + uBeat * 0.6 * step(0.7, aSeed.w));
  float ps = size * uPointScale / max(clip.w, 0.05);
  float a = fade * uAlpha;
  if (ps < 1.5) { a *= ps / 1.5; ps = 1.5; }
  if (ps > 6.0) { a *= 6.0 / ps; }
  gl_PointSize = min(ps, 64.0);
  vCol = c.rgb * a * (1.0 - mid * 0.45);
}`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  o = vec4(vCol * (exp(-r2 * 5.0) + (1.0 - r2) * 0.25), 1.0);
}`;

// ---------------------------------------------------------------- lines
export const LINE_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uVP;
out vec3 vCol;
out float vK;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  vCol = aCol.rgb;
  vK = aCol.a;
}`;

export const LINE_FS = `#version 300 es
precision highp float;
in vec3 vCol;
in float vK;
uniform float uReveal, uAlpha;
out vec4 o;
void main() {
  if (vK > uReveal) discard;
  float edge = smoothstep(uReveal - 0.05, uReveal, vK);
  o = vec4(vCol * uAlpha * (1.0 + edge * 5.0), 1.0);
}`;

// ---------------------------------------------------------------- background
export const BG_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;
uniform float uTime, uBeat, uHorizon, uGrid, uSky, uStars, uSpeed, uMoon, uSkyScroll, uHaze;
uniform vec3 uTop, uBot, uGlow, uGridCol;
${HASH}
vec3 skyline(vec2 uv, float asp, vec3 col) {
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float dens = 46.0 - fl * 14.0;
    float x = uv.x * asp * dens / asp * 1.0 + fl * 57.3 + uTime * uSkyScroll * (0.4 + fl * 0.6);
    float id = floor(x), fx = fract(x);
    float r = h11(id * 1.37 + fl * 71.0);
    float hgt = (0.03 + 0.22 * pow(r, 2.2)) * (0.65 + fl * 0.45);
    float tower = step(0.93, h11(id * 3.1 + fl * 13.0));
    hgt += tower * (0.1 + 0.08 * fl);
    float top = uHorizon + hgt;
    float w = 0.62 + 0.3 * h11(id + 9.0 + fl);
    float inside = step(fx, w) * step(uv.y, top) * step(uHorizon - 0.002, uv.y);
    // antenna
    float ant = tower * step(abs(fx - w * 0.5), 0.012) * step(uv.y, top + 0.05) * step(top, uv.y);
    if (inside > 0.5) {
      float fog = 1.0 - fl / 2.0;
      vec3 b = mix(vec3(0.004, 0.003, 0.012), uGlow * 0.10, fog * 0.6);
      float cols = 3.0 + floor(h11(id + 4.0) * 4.0);
      vec2 wc = vec2(floor(fx / w * cols), floor((uv.y - uHorizon) * (160.0 - fl * 40.0)));
      vec2 wf = vec2(fract(fx / w * cols), fract((uv.y - uHorizon) * (160.0 - fl * 40.0)));
      float lit = step(0.62, h12(wc + id * 13.1 + fl * 7.0));
      lit *= step(0.18, wf.x) * step(wf.x, 0.82) * step(0.25, wf.y) * step(wf.y, 0.75);
      float blink = step(0.5, sin(uTime * (1.0 + h12(wc + id) * 3.0) + h12(wc) * 30.0)) * 0.5 + 0.5;
      float pick = h12(wc + id * 2.0);
      vec3 wcol = pick < 0.45 ? vec3(0.25, 0.95, 0.9) : pick < 0.75 ? vec3(1.0, 0.25, 0.75) : vec3(1.0, 0.75, 0.4);
      col = b + wcol * lit * blink * (0.25 + fl * 0.35);
      float rim = smoothstep(0.004, 0.0, abs(uv.y - top)) * (0.3 + fl * 0.4);
      col += mix(uGlow, vec3(1.0), 0.2) * rim * (1.0 + uBeat);
    }
    col += ant * uGlow * 0.6;
    // red aircraft lights on towers
    float bl = tower * step(length(vec2((fx - w * 0.5) * 0.02 * dens, uv.y - top - 0.05)), 0.004) * step(0.5, fract(uTime * 0.8 + id * 0.37));
    col += vec3(1.5, 0.1, 0.1) * bl;
  }
  return col;
}

void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  vec3 col = mix(uBot, uTop, smoothstep(0.0, 1.0, uv.y));
  float hd = uv.y - uHorizon;
  col += uGlow * exp(-abs(hd) * 9.0) * 0.55 * (1.0 + uBeat * 0.4);

  if (uStars > 0.0) {
    vec2 g = floor(vec2(uv.x * asp, uv.y) * 240.0);
    float r = h12(g);
    float tw = 0.5 + 0.5 * sin(uTime * 2.5 + r * 60.0);
    col += vec3(0.6, 0.9, 1.0) * step(0.9965, r) * tw * uStars * smoothstep(uHorizon, uHorizon + 0.3, uv.y);
  }
  if (uMoon > 0.0) {
    vec2 c = vec2(0.5 * asp + 0.33, uHorizon + 0.36);
    float d = length(vec2(uv.x * asp, uv.y) - c);
    float disc = smoothstep(0.125, 0.12, d);
    float n = h12(floor(vec2(uv.x * asp, uv.y) * 90.0));
    col = mix(col, vec3(0.75, 1.0, 0.98) * (0.85 + 0.15 * n), disc * uMoon);
    col += vec3(0.2, 0.9, 0.85) * exp(-max(d - 0.12, 0.0) * 14.0) * 0.35 * uMoon;
  }
  if (uSky > 0.0) {
    vec3 s = skyline(uv, asp, col);
    col = mix(col, s, uSky);
  }
  if (uGrid > 0.0 && uv.y < uHorizon) {
    float d = uHorizon - uv.y;
    float z = 0.22 / d;
    vec2 gp = vec2((uv.x - 0.5) * asp * z * 2.0, z * 1.0 + uTime * uSpeed);
    vec2 gw = fwidth(gp);
    vec2 gl = abs(fract(gp - 0.5) - 0.5) / max(gw, 1e-4);
    float line = 1.0 - min(min(gl.x, gl.y), 1.0);
    float fade = exp(-z * 0.12);
    col += uGridCol * line * fade * uGrid * (1.0 + uBeat * 1.2);
    col += uGlow * 0.2 * exp(-d * 6.0) * uGrid;
  }
  // haze
  float n = h12(floor(uv * uRes * 0.5) + floor(uTime * 24.0));
  col += (n - 0.5) * 0.012 * uHaze;
  o = vec4(max(col, 0.0), 1.0);
}`;

// ---------------------------------------------------------------- bloom (dual filter)
export const BLOOM_PRE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
void main() {
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  c = min(c, vec3(40.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  o = vec4(c * max(soft, br - uThreshold) / max(br, 1e-4), 1.0);
}`;

export const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec3 s = texture(uTex, vUv).rgb * 4.0;
  s += texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

export const BLOOM_UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex, uBase;
uniform vec2 uTexel;
uniform float uSpread;
void main() {
  vec2 h = uTexel * uSpread;
  vec3 s = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0 + texture(uBase, vUv).rgb, 1.0);
}`;

// ---------------------------------------------------------------- final composite
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene, uBloom, uUI;
uniform vec2 uRes;
uniform float uUIGain, uUIGlow;
uniform float uTime, uBloomK, uChroma, uGlitch, uScan, uVig, uGrain, uExposure, uInvert, uFlash, uSat, uRaw;
uniform vec3 uFlashCol, uTint;
${HASH}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 fetch(vec2 uv) { return texture(uScene, uv).rgb + texture(uBloom, uv).rgb * uBloomK; }
vec4 ui(vec2 uv) { return texture(uUI, vec2(uv.x, 1.0 - uv.y)); }
void main() {
  vec2 uv = vUv;
  float gt = floor(uTime * 16.0);
  float band = floor(uv.y * 28.0 + h11(gt) * 7.0);
  float r = h12(vec2(band, gt));
  float slice = step(r, uGlitch * 0.3);
  uv.x += slice * (h12(vec2(band, gt + 3.0)) - 0.5) * 0.18 * uGlitch;
  vec2 blk = floor(uv * vec2(18.0, 10.0));
  float rb = h12(blk + gt * 1.7);
  float blockOn = step(1.0 - uGlitch * 0.07, rb);
  uv += blockOn * (vec2(h12(blk + gt + 1.0), h12(blk + gt + 2.0)) - 0.5) * 0.06;

  vec2 dc = uv - 0.5;
  vec2 off = dc * uChroma * 0.012 + vec2(uGlitch * 0.012 * (slice + blockOn), 0.0);
  vec3 col;
  col.r = fetch(uv + off).r;
  col.g = fetch(uv).g;
  col.b = fetch(uv - off).b;
  col *= uExposure;
  col = mix(aces(col), clamp(col, 0.0, 1.0), uRaw);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSat) * uTint;
  // 2D overlay: crisp, chromatic-split, with its own small neon halo instead of bloom
  vec4 u0 = ui(uv);
  vec3 uc = vec3(ui(uv + off).r, u0.g, ui(uv - off).b) * uUIGain;
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a)) / uRes;
    glow += ui(uv + d * 4.0).rgb + ui(uv + d * 11.0).rgb * 0.6;
  }
  col = col * (1.0 - u0.a) + uc + glow / 12.8 * uUIGlow;
  col = mix(col, vec3(1.0) - col, uInvert);
  if (blockOn > 0.5) col = mix(col, vec3(col.g, col.b, col.r) * 1.4, 0.6);
  float sc = 0.5 + 0.5 * sin(vUv.y * uRes.y * 1.5708);
  col *= 1.0 - uScan * (1.0 - sc) * 0.6;
  float v = smoothstep(1.25, 0.35, length(dc * vec2(uRes.x / uRes.y, 1.0)));
  col *= mix(1.0, v, uVig);
  col += (h12(vUv * uRes + fract(uTime * 7.13) * 400.0) - 0.5) * uGrain;
  col += uFlashCol * uFlash;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
