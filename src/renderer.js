import { createContext, Program, createTarget, deleteTarget, bindTarget, bindTex, createPathTexture } from './gl.js';
import * as SH from './shaders.js';
import { generate, lineSets } from './shapes.js';
import { rng } from './math.js';

const STRIDE = 9 * 4;

export class Renderer {
  constructor(canvas, { particles = 131072, preserve = false } = {}) {
    this.canvas = canvas;
    const { gl, floatRT } = createContext(canvas, { preserve });
    this.gl = gl;
    this.floatRT = floatRT;
    this.N = particles;
    this.progs = {
      particle: new Program(gl, SH.PARTICLE_VS, SH.PARTICLE_FS),
      line: new Program(gl, SH.LINE_VS, SH.LINE_FS),
      bg: new Program(gl, SH.FULLSCREEN_VS, SH.BG_FS),
      pre: new Program(gl, SH.FULLSCREEN_VS, SH.BLOOM_PRE_FS),
      down: new Program(gl, SH.FULLSCREEN_VS, SH.BLOOM_DOWN_FS),
      up: new Program(gl, SH.FULLSCREEN_VS, SH.BLOOM_UP_FS),
      comp: new Program(gl, SH.FULLSCREEN_VS, SH.COMPOSITE_FS),
    };
    this.emptyVAO = gl.createVertexArray();
    this.pVAO = gl.createVertexArray();
    this.lVAO = gl.createVertexArray();

    const R = rng(7);
    const seeds = new Float32Array(this.N * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = R();
    this.seedBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);

    this.dummyPath = createPathTexture(gl, []);
    this.shapeCache = new Map();
    this.lineCache = new Map();

    this.uiTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.uiTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.targets = null;
  }

  resize(w, h) {
    if (this.targets && this.targets.w === w && this.targets.h === h) return;
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.targets) {
      deleteTarget(gl, this.targets.scene);
      this.targets.down.forEach(t => deleteTarget(gl, t));
      this.targets.up.forEach(t => deleteTarget(gl, t));
    }
    const scene = createTarget(gl, w, h, this.floatRT);
    const down = [], up = [];
    let cw = w >> 1, ch = h >> 1;
    for (let i = 0; i < 6 && cw > 4 && ch > 4; i++) {
      down.push(createTarget(gl, cw, ch, this.floatRT));
      if (i > 0) up.push(createTarget(gl, down[i - 1].w, down[i - 1].h, this.floatRT));
      cw >>= 1; ch >>= 1;
    }
    this.targets = { w, h, scene, down, up };
  }

  // shapes are generated lazily and kept in a small LRU (each is N*36 bytes on the GPU)
  shape(desc) {
    const key = desc.kind + JSON.stringify(desc.args || {});
    let s = this.shapeCache.get(key);
    if (s) {
      this.shapeCache.delete(key);
      this.shapeCache.set(key, s);
      return s;
    }
    const gl = this.gl;
    const g = generate(desc.kind, this.N, desc.args || {});
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.STATIC_DRAW);
    const path = g.paths && g.paths.length ? createPathTexture(gl, g.paths) : null;
    s = { buf, path, center: g.center || [0, 0, 0] };
    this.shapeCache.set(key, s);
    while (this.shapeCache.size > 10) {
      const [k, old] = this.shapeCache.entries().next().value;
      gl.deleteBuffer(old.buf);
      if (old.path) gl.deleteTexture(old.path.tex);
      this.shapeCache.delete(k);
    }
    return s;
  }

  lines(name) {
    let l = this.lineCache.get(name);
    if (l) return l;
    const gl = this.gl;
    const data = lineSets[name]();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    l = { buf, count: data.length / 7 };
    this.lineCache.set(name, l);
    return l;
  }

  fullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(F, uiCanvas) {
    const gl = this.gl;
    const T = this.targets;
    const P = this.progs;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // --- scene
    bindTarget(gl, T.scene);
    gl.disable(gl.BLEND);
    P.bg.use().setAll({
      uRes: [T.w, T.h], uTime: F.time, uBeat: F.beat,
      uHorizon: F.bg.horizon, uGrid: F.bg.grid, uSky: F.bg.sky, uStars: F.bg.stars, uSpeed: F.bg.speed,
      uMoon: F.bg.moon, uSkyScroll: F.bg.skyScroll, uHaze: F.bg.haze,
      uTop: F.bg.top, uBot: F.bg.bot, uGlow: F.bg.glow, uGridCol: F.bg.gridCol,
    });
    this.fullscreen();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    for (const L of F.lines) {
      if (L.alpha <= 0.001) continue;
      const ls = this.lines(L.name);
      P.line.use().setAll({ uVP: L.vp || F.vp, uReveal: L.reveal, uAlpha: L.alpha });
      gl.bindVertexArray(this.lVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, ls.buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(gl.LINES, 0, ls.count);
    }

    if (F.particles && F.particles.alpha > 0.001) {
      const pf = F.particles;
      const A = this.shape(pf.a), B = this.shape(pf.b);
      gl.bindVertexArray(this.pVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      const bindSlot = (buf, base) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(base);
        gl.vertexAttribPointer(base, 4, gl.FLOAT, false, STRIDE, 0);
        gl.enableVertexAttribArray(base + 1);
        gl.vertexAttribPointer(base + 1, 4, gl.FLOAT, false, STRIDE, 16);
        gl.enableVertexAttribArray(base + 2);
        gl.vertexAttribPointer(base + 2, 1, gl.FLOAT, false, STRIDE, 32);
      };
      bindSlot(A.buf, 1);
      bindSlot(B.buf, 4);
      P.particle.use().setAll({
        uVP: F.vp, uCam: F.cam, uTime: F.time, uTA: pf.ta, uTB: pf.tb, uMix: pf.mix,
        uScatter: pf.scatter, uTurb: pf.turb, uBeat: F.beat, uPointScale: F.pointScale,
        uAlpha: pf.alpha, uSizeMul: pf.size, uSwirl: pf.swirl,
        uPathA: bindTex(gl, 0, (A.path || this.dummyPath).tex),
        uPathB: bindTex(gl, 1, (B.path || this.dummyPath).tex),
        uCenterA: A.center, uCenterB: B.center,
      });
      gl.drawArrays(gl.POINTS, 0, this.N);
    }

    gl.disable(gl.BLEND);

    // --- bloom
    const D = T.down, U = T.up;
    bindTarget(gl, D[0]);
    P.pre.use().setAll({ uTex: bindTex(gl, 0, T.scene.tex), uTexel: [1 / T.w, 1 / T.h], uThreshold: F.post.threshold, uKnee: 0.45 });
    this.fullscreen();
    for (let i = 1; i < D.length; i++) {
      bindTarget(gl, D[i]);
      P.down.use().setAll({ uTex: bindTex(gl, 0, D[i - 1].tex), uTexel: [1 / D[i - 1].w, 1 / D[i - 1].h] });
      this.fullscreen();
    }
    let src = D[D.length - 1];
    for (let i = D.length - 2; i >= 0; i--) {
      const dst = U[i];
      bindTarget(gl, dst);
      P.up.use().setAll({ uTex: bindTex(gl, 0, src.tex), uBase: bindTex(gl, 1, D[i].tex), uTexel: [1 / src.w, 1 / src.h], uSpread: 1.0 });
      this.fullscreen();
      src = dst;
    }

    // --- composite (the 2D overlay is layered here, after bloom, so text stays crisp)
    gl.bindTexture(gl.TEXTURE_2D, this.uiTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, uiCanvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    bindTarget(gl, null);
    const po = F.post;
    P.comp.use().setAll({
      uScene: bindTex(gl, 0, T.scene.tex), uBloom: bindTex(gl, 1, src.tex), uUI: bindTex(gl, 2, this.uiTex),
      uUIGain: po.uiGain, uUIGlow: po.uiGlow,
      uRes: [T.w, T.h], uTime: F.time, uBloomK: po.bloom, uChroma: po.chroma, uGlitch: po.glitch,
      uScan: po.scan, uVig: po.vignette, uGrain: po.grain, uExposure: po.exposure, uInvert: po.invert,
      uFlash: po.flash, uFlashCol: po.flashCol, uSat: po.sat, uTint: po.tint, uRaw: po.raw,
    });
    this.fullscreen();
  }
}
