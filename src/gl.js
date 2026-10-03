// Minimal WebGL2 helpers: programs with reflected uniforms, render targets, path textures.

export function createContext(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: !!opts.preserve,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  const floatRT = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_float_blend');
  return { gl, floatRT };
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join('\n');
    throw new Error(`Shader compile error:\n${log}\n${lines}`);
  }
  return s;
}

export class Program {
  constructor(gl, vs, fs) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.u[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
  }
  use() {
    this.gl.useProgram(this.p);
    return this;
  }
  set(name, v) {
    const u = this.u[name];
    if (!u) return this;
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT: gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
      case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: gl.uniform1i(u.loc, v); break;
      default: throw new Error('unsupported uniform type for ' + name);
    }
    return this;
  }
  setAll(obj) {
    for (const k in obj) this.set(k, obj[k]);
    return this;
  }
}

export function createTarget(gl, w, h, float) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    if (float) return createTarget(gl, w, h, false);
    throw new Error('framebuffer incomplete');
  }
  return { tex, fb, w, h };
}

export function deleteTarget(gl, t) {
  if (!t) return;
  gl.deleteFramebuffer(t.fb);
  gl.deleteTexture(t.tex);
}

export function bindTarget(gl, t) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
  gl.viewport(0, 0, t ? t.w : gl.drawingBufferWidth, t ? t.h : gl.drawingBufferHeight);
}

export function bindTex(gl, unit, tex) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  return unit;
}

// Paths are resampled to K evenly spaced (arc-length) points and packed one path per row
// into an RGBA32F texture: xyz = position, w = 1 for closed loops.
export const PATH_SAMPLES = 256;

export function resamplePath(pts, closed, K = PATH_SAMPLES) {
  const P = closed && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][2] !== pts[pts.length - 1][2]) ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const L = cum[cum.length - 1] || 1;
  const out = new Float32Array(K * 4);
  let j = 0;
  for (let k = 0; k < K; k++) {
    const d = (k / (K - 1)) * L;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.min(1, Math.max(0, (d - cum[j]) / seg));
    const a = P[j], b = P[j + 1] || a;
    out[k * 4] = a[0] + (b[0] - a[0]) * t;
    out[k * 4 + 1] = a[1] + (b[1] - a[1]) * t;
    out[k * 4 + 2] = a[2] + (b[2] - a[2]) * t;
    out[k * 4 + 3] = closed ? 1 : 0;
  }
  return { data: out, length: L };
}

export function createPathTexture(gl, paths) {
  const K = PATH_SAMPLES;
  const rows = Math.max(1, paths.length);
  const data = new Float32Array(K * rows * 4);
  paths.forEach((p, i) => data.set(p.data, i * K * 4));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, K, rows, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, rows };
}
