// Particle formations. Each generator fills N particles × 9 floats:
//   [p0 p1 p2 p3 | r g b size | kind]
// kinds: 0 hidden · 1 static(xyz, jitter) · 2 path(row, u0, speed, spread) · 3 camera rain(xyz, speed)
//        4 tunnel(angle, z0, radius, speed) · 5 orbit(radius, angle0, y, angSpeed) · 6 drift(xyz, amp)
//        7 glyph rain(xyz, speed)
import { rng, hashStr, lerp, TAU, hexRGB, hash1 } from './math.js';
import { resamplePath } from './gl.js';
import { FONT } from './fonts.js';
import { WARDS, RAILS, STATIONS, LANDMARKS } from './data/tokyo.js';

export const C = {
  teal: [0.2, 1.0, 0.86],
  miku: [0.22, 0.77, 0.73],
  cyan: [0.1, 0.75, 1.0],
  pink: [1.0, 0.16, 0.62],
  violet: [0.52, 0.28, 1.0],
  white: [1.0, 1.0, 1.0],
  amber: [1.0, 0.62, 0.16],
  red: [1.0, 0.1, 0.18],
  orange: [1.0, 0.32, 0.06],
};
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

class Writer {
  constructor(N) {
    this.N = N;
    this.d = new Float32Array(N * 9);
    this.i = 0;
  }
  get left() { return this.N - this.i; }
  push(kind, x, y, z, w, c, s) {
    if (this.i >= this.N) return false;
    const o = this.i++ * 9, d = this.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w;
    d[o + 4] = c[0]; d[o + 5] = c[1]; d[o + 6] = c[2]; d[o + 7] = s;
    d[o + 8] = kind;
    return true;
  }
}

// ------------------------------------------------------------------ text rasterising
const raster = document.createElement('canvas');
const rctx = raster.getContext('2d', { willReadFrequently: true });

export function rasterText(lines, opt = {}) {
  const W = opt.w || 2048, H = opt.h || 1024;
  raster.width = W; raster.height = H;
  rctx.clearRect(0, 0, W, H);
  rctx.fillStyle = '#fff';
  rctx.textAlign = 'center';
  rctx.textBaseline = 'middle';
  const font = opt.font || FONT.dela;
  const weight = opt.weight || 400;
  const pad = opt.pad || 0.9;
  const gap = opt.gap || 1.08;
  if (opt.vertical) {
    // columns read right-to-left, characters top-to-bottom
    const cols = lines.length, rows = Math.max(...lines.map(l => [...l].length));
    const size = Math.min((H * pad) / (rows * gap), (W * pad) / (cols * 1.15));
    rctx.font = `${weight} ${size}px ${font}`;
    lines.forEach((l, ci) => {
      const x = W / 2 + ((cols - 1) / 2 - ci) * size * 1.15;
      [...l].forEach((ch, ri) => rctx.fillText(ch, x, H / 2 + (ri - (rows - 1) / 2) * size * gap));
    });
  } else {
    let size = 200;
    rctx.font = `${weight} ${size}px ${font}`;
    const maxW = Math.max(...lines.map(l => rctx.measureText(l).width + (opt.spacing || 0) * [...l].length * size));
    size *= Math.min((W * pad) / maxW, (H * pad) / (lines.length * size * gap));
    rctx.font = `${weight} ${size}px ${font}`;
    lines.forEach((l, i) => {
      const y = H / 2 + (i - (lines.length - 1) / 2) * size * gap;
      if (opt.spacing) {
        const chars = [...l];
        const widths = chars.map(ch => rctx.measureText(ch).width + opt.spacing * size);
        let x = W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
        chars.forEach((ch, k) => { rctx.fillText(ch, x + widths[k] / 2, y); x += widths[k]; });
      } else rctx.fillText(l, W / 2, y);
    });
  }
  return scan(W, H, opt.step || 2);
}

function scan(W, H, step) {
  const img = rctx.getImageData(0, 0, W, H).data;
  const A = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : img[(y * W + x) * 4 + 3]);
  const fill = [], edge = [];
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (let y = 0; y < H; y += step)
    for (let x = 0; x < W; x += step) {
      const o = (y * W + x) * 4;
      if (img[o + 3] < 128) continue;
      const e = A(x - 3, y) < 128 || A(x + 3, y) < 128 || A(x, y - 3) < 128 || A(x, y + 3) < 128;
      (e ? edge : fill).push(x, y);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  return { fill, edge, bounds: [x0, y0, x1, y1], W, H, img };
}

// map raster pixels into a world-space rectangle
function fitter(r, width, maxH, cx = 0, cy = 0) {
  const [x0, y0, x1, y1] = r.bounds;
  const s = Math.min(width / Math.max(1, x1 - x0), maxH / Math.max(1, y1 - y0));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return (px, py) => [cx + (px - mx) * s, cy - (py - my) * s, s];
}

// ------------------------------------------------------------------ fillers
function dust(w, R, n, box, amp, colorFn) {
  for (let k = 0; k < n; k++) {
    const c = colorFn ? colorFn(R) : mul(R() < 0.5 ? C.teal : R() < 0.5 ? C.pink : C.violet, 0.12 + R() * 0.25);
    w.push(6, (R() - 0.5) * box[0], (R() - 0.5) * box[1], (R() - 0.5) * box[2], amp * (0.5 + R()), c, 0.04 + R() * 0.07);
  }
}

function tunnel(w, R, n, rMin = 13, rMax = 24, palette = [C.teal, C.pink]) {
  for (let k = 0; k < n; k++) {
    const z0 = R() * 160;
    const ring = Math.floor(z0 / 6);
    const c = mul(palette[ring % palette.length], 0.35 + R() * 0.6);
    const seg = Math.floor(R() * 48);
    const a = (seg + R() * 0.6) / 48 * TAU;
    w.push(4, a, z0, rMin + Math.pow(R(), 2) * (rMax - rMin), 26 + R() * 6, c, 0.08 + R() * 0.1);
  }
}

function textInto(w, R, n, r, place, opt) {
  const edgeShare = opt.edgeShare ?? 0.5;
  const nf = r.fill.length / 2, ne = r.edge.length / 2;
  if (!nf && !ne) return;
  const [x0, , x1] = r.bounds;
  for (let k = 0; k < n; k++) {
    const useEdge = (R() < edgeShare && ne) || !nf;
    const arr = useEdge ? r.edge : r.fill;
    const j = Math.floor(R() * (arr.length / 2)) * 2;
    const px = arr[j] + (R() - 0.5) * 2, py = arr[j + 1] + (R() - 0.5) * 2;
    const [x, y, s] = place(px, py);
    const t = (arr[j] - x0) / Math.max(1, x1 - x0);
    let c = opt.colorAt ? opt.colorAt(t, px, py, R) : mix(opt.c0 || C.teal, opt.c1 || C.pink, t);
    c = mul(c, (useEdge ? opt.edgeK ?? 0.9 : opt.fillK ?? 0.32) * (0.7 + R() * 0.6));
    if (R() < 0.015) c = mul(C.white, 1.6);
    const z = (opt.z || 0) + (R() - 0.5) * (opt.depth ?? 0.8);
    w.push(1, x, y, z, opt.jitter ?? 0.02, c, (opt.size ?? 0.085) * (0.7 + R() * 0.6) * (useEdge ? 1 : 0.9));
  }
}

// ------------------------------------------------------------------ generators
const GEN = {};

GEN.boot = (N, R) => {
  const w = new Writer(N);
  dust(w, R, Math.floor(N * 0.6), [90, 50, 60], 2.5);
  return { data: w.d };
};

// big glowing word(s) + optional tunnel / dust around
GEN.text = (N, R, a) => {
  const w = new Writer(N);
  const tunnelShare = a.tunnel ?? 0.22, dustShare = a.dust ?? 0.1;
  const r = rasterText(a.lines, { font: a.font, vertical: a.vertical, spacing: a.spacing, weight: a.weight });
  const place = fitter(r, a.width || 34, a.height || 17, a.x || 0, a.y || 0);
  textInto(w, R, Math.floor(N * (1 - tunnelShare - dustShare)), r, place, a);
  tunnel(w, R, Math.floor(N * tunnelShare), 13, 26, a.tunnelPalette);
  dust(w, R, w.left, [80, 46, 50], 2.0);
  return { data: w.d };
};

GEN.map = (N, R, a) => {
  const w = new Writer(N);
  const paths = [];
  const railInfo = RAILS.map((rl, idx) => {
    const pts = rl.pts.map(([x, z]) => [x, 0, z]);
    const rs = resamplePath(pts, rl.loop);
    paths.push(rs);
    const hot = rl.name === 'Yamanote';
    return { idx, rs, color: hot ? C.miku : hexRGB(rl.color), hot };
  });
  const totalLen = railInfo.reduce((s, r) => s + r.rs.length * (r.hot ? 2 : 1), 0);

  // traffic: "trains" are short bright comets running along each line, both ways
  const nFlow = Math.floor(N * 0.36);
  for (const ri of railInfo) {
    const len = ri.rs.length;
    const n = Math.floor(nFlow * (len * (ri.hot ? 2 : 1)) / totalLen);
    const trains = Math.max(2, Math.round(len / (ri.hot ? 1.2 : 2.6)));
    const tr = Array.from({ length: trains }, (_, j) => ({ u: R(), dir: j % 2 ? -1 : 1, v: (0.55 + R() * 0.5) / len }));
    const tail = 0.9 / len;
    for (let k = 0; k < n; k++) {
      const t = tr[Math.floor(R() * trains)];
      const d = Math.pow(R(), 1.8) * tail;
      const b = 1 - d / tail;
      const c = mul(mix(ri.color, C.white, b * b * 0.5), 0.12 + b * 0.85);
      w.push(2, ri.idx, t.u - d * t.dir, t.v * t.dir, 0.05 + (1 - b) * 0.08, c, 0.05 + b * 0.06);
    }
  }
  // the tracks themselves as faint dotted lines
  const nTrack = Math.floor(N * 0.14);
  for (let k = 0; k < nTrack; k++) {
    const ri = railInfo[Math.floor(R() * railInfo.length)];
    const s = Math.floor(R() * 255), f = R();
    const d = ri.rs.data;
    const x = lerp(d[s * 4], d[s * 4 + 4], f), z = lerp(d[s * 4 + 2], d[s * 4 + 6], f);
    w.push(1, x, 0, z, 0.0, mul(ri.color, 0.16), 0.04);
  }
  // ward boundaries
  const segs = [];
  let segTotal = 0;
  for (const wd of WARDS)
    for (const ring of wd.rings)
      for (let i = 0; i < ring.length - 1; i++) {
        const l = Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
        segs.push([ring[i], ring[i + 1], segTotal]);
        segTotal += l;
      }
  const nWard = Math.floor(N * 0.16);
  for (let k = 0; k < nWard; k++) {
    const target = R() * segTotal;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m][2] <= target) lo = m; else hi = m - 1; }
    const [p, q] = segs[lo];
    const f = R();
    w.push(1, lerp(p[0], q[0], f), 0, lerp(p[1], q[1], f), 0, mul(mix(C.violet, C.cyan, R() * 0.4), 0.22), 0.045);
  }
  // stations + light pillars for interchange hubs
  const nSt = Math.floor(N * 0.1);
  const hubs = STATIONS.filter(s => s.n >= 3);
  for (let k = 0; k < nSt; k++) {
    if (k % 3 === 0 && hubs.length) {
      const s = hubs[Math.floor(R() * hubs.length)];
      const h = R() * s.n * 0.42;
      const top = h / (s.n * 0.42);
      w.push(1, s.p[0] + (R() - 0.5) * 0.06, h, s.p[1] + (R() - 0.5) * 0.06, 0.01, mul(mix(C.teal, C.pink, top), 0.12 + top * 0.45), 0.05);
    } else {
      const s = STATIONS[Math.floor(R() * STATIONS.length)];
      w.push(1, s.p[0] + (R() - 0.5) * 0.12, 0.02, s.p[1] + (R() - 0.5) * 0.12, 0.015, mul(C.white, 0.22 + R() * 0.3), 0.05);
    }
  }
  // landmark beams
  for (const lm of LANDMARKS) {
    const H = lm.h ? lm.h * 9 : 1.2;
    for (let k = 0; k < 900; k++) {
      const y = Math.pow(R(), 0.7) * H;
      w.push(1, lm.p[0] + (R() - 0.5) * 0.05, y, lm.p[1] + (R() - 0.5) * 0.05, 0.01, mul(lm.h ? C.red : C.amber, 0.5 + (y / H) * 1.2), 0.06);
    }
  }
  dust(w, R, Math.floor(N * 0.06), [44, 8, 40], 0.8, R2 => mul(C.teal, 0.08 + R2() * 0.15));
  return { data: w.d, paths };
};

export function mapLines() {
  const v = [];
  const push = (a, b, c, k) => v.push(a[0], a[1], a[2], c[0], c[1], c[2], k, b[0], b[1], b[2], c[0], c[1], c[2], k);
  for (const wd of WARDS)
    for (const ring of wd.rings)
      for (let i = 0; i < ring.length - 1; i++) {
        const p = ring[i], q = ring[i + 1];
        const k = Math.min(1, Math.hypot(p[0], p[1]) / 20);
        push([p[0], 0, p[1]], [q[0], 0, q[1]], mul(C.violet, 0.28), k);
      }
  for (const rl of RAILS) {
    const c = rl.name === 'Yamanote' ? mul(C.miku, 0.9) : hexRGB(rl.color, 0.35);
    for (let i = 0; i < rl.pts.length - 1; i++) {
      const p = rl.pts[i], q = rl.pts[i + 1];
      push([p[0], 0, p[1]], [q[0], 0, q[1]], c, Math.min(1, Math.hypot(p[0], p[1]) / 20));
    }
  }
  return new Float32Array(v);
}

// --------------------------------------------------------------- neon city flythrough
const SIGN_WORDS = ['カラオケ', 'ラーメン', 'ホテル', '居酒屋', 'ゲーム', '幽霊', '東京', 'ネオン', '占い', '営業中', '喫茶', 'バー', '二十四時', '電脳', '亡霊', '夜行'];

function cityLayout(seed) {
  const R = rng(seed);
  const B = [];
  for (const side of [-1, 1])
    for (let row = 0; row < 2; row++) {
      let z = 50;
      while (z > -640) {
        const d = 5 + R() * 9, gap = 0.8 + R() * 2.2, width = 5 + R() * 8;
        const x0 = side * (row === 0 ? 7.5 + R() * 1.5 : 22 + R() * 6);
        let h = row === 0 ? 5 + Math.pow(R(), 2) * 42 : 22 + Math.pow(R(), 1.6) * 90;
        if (R() < 0.08) h += 45 + R() * 60;
        B.push({ side, row, x0, x1: x0 + side * width, z0: z, z1: z - d, h, theme: Math.floor(R() * 4), id: B.length });
        z -= d + gap;
      }
    }
  return B;
}

GEN.city = (N, R) => {
  const w = new Writer(N);
  const B = cityLayout(1234);
  const themes = [[C.amber, C.white], [C.teal, C.cyan], [C.pink, C.violet], [C.white, C.teal]];
  // windows (area-weighted)
  const faces = [];
  let tot = 0;
  for (const b of B) {
    const aFront = Math.abs(b.z1 - b.z0) * b.h, aEnd = Math.abs(b.x1 - b.x0) * b.h;
    const wgt = b.row ? 0.45 : 1;
    faces.push({ b, f: 0, acc: (tot += aFront * wgt) });
    faces.push({ b, f: 1, acc: (tot += aEnd * 0.4 * wgt) });
  }
  const nWin = Math.floor(N * 0.5);
  for (let k = 0; k < nWin; k++) {
    const t = R() * tot;
    let lo = 0, hi = faces.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (faces[m].acc < t) lo = m + 1; else hi = m; }
    const { b, f } = faces[lo];
    const floors = Math.max(1, Math.floor(b.h / 1.15));
    const span = f === 0 ? Math.abs(b.z1 - b.z0) : Math.abs(b.x1 - b.x0);
    const cols = Math.max(1, Math.floor(span / 0.95));
    const fl = Math.floor(R() * floors), cl = Math.floor(R() * cols);
    const hsh = hash1(b.id * 977 + fl * 31 + cl * 7 + f * 13);
    if (hsh > 0.3) { k--; continue; } // unlit window: resample
    const th = themes[b.theme];
    const col = mul(hsh < 0.06 ? C.pink : th[hsh < 0.18 ? 0 : 1], (b.row ? 0.55 : 0.8) * (0.6 + R() * 0.8));
    const y = (fl + 0.5) * 1.15 + (R() - 0.5) * 0.5;
    const along = (cl + 0.5) / cols + (R() - 0.5) * 0.7 / cols;
    const ws = b.row ? 0.26 : 0.17;
    if (f === 0) w.push(1, b.x0, y, lerp(b.z0, b.z1, along), 0, col, ws);
    else w.push(1, lerp(b.x0, b.x1, along), y, b.z0, 0, col, ws);
  }
  // protruding vertical neon signs facing the avenue
  const fronts = B.filter(b => b.row === 0 && b.h > 14);
  const nSign = Math.floor(N * 0.12);
  const signs = 18;
  for (let s = 0; s < signs; s++) {
    const b = fronts[Math.floor((s / signs) * fronts.length + R() * 2) % fronts.length];
    const word = SIGN_WORDS[s % SIGN_WORDS.length];
    const r = rasterText([word], { font: s % 2 ? FONT.dela : FONT.dot, vertical: true, w: 256, h: 1024, step: 2 });
    const hgt = Math.min(b.h - 4, 4 + [...word].length * 2.2);
    const cx = b.x0 - b.side * 1.6, cy = 3 + R() * Math.max(0.5, b.h - hgt - 4) + hgt / 2, zc = (b.z0 + b.z1) / 2;
    const place = fitter(r, 2.2, hgt, 0, 0);
    const pal = [[C.pink, C.violet], [C.teal, C.cyan], [C.amber, C.red], [C.cyan, C.white]][s % 4];
    const n = Math.floor(nSign / signs);
    for (let k = 0; k < n; k++) {
      const edge = R() < 0.55 && r.edge.length;
      const arr = edge ? r.edge : r.fill;
      if (!arr.length) break;
      const j = Math.floor(R() * (arr.length / 2)) * 2;
      const [x, y] = place(arr[j], arr[j + 1]);
      w.push(1, cx + x, cy + y, zc + (R() - 0.5) * 0.2, 0.004, mul(mix(pal[0], pal[1], R() * 0.3), edge ? 1.7 : 0.7), 0.07);
    }
  }
  // traffic: two lights per car, white coming toward camera, red going away
  const paths = [];
  const lanes = [-4.3, -1.7, 1.7, 4.3];
  lanes.forEach(x => {
    for (const dx of [-0.45, 0.45]) {
      const pts = x < 0 ? [[x + dx, 0.3, 50], [x + dx, 0.3, -640]] : [[x + dx, 0.3, -640], [x + dx, 0.3, 50]];
      paths.push(resamplePath(pts, false));
    }
  });
  const nCar = Math.floor(N * 0.12);
  const cars = Array.from({ length: 90 }, (_, j) => ({ lane: j % 4, u: R(), v: (14 + R() * 18) / 690 }));
  for (let k = 0; k < nCar; k++) {
    const car = cars[Math.floor(R() * cars.length)];
    const row = car.lane * 2 + (R() < 0.5 ? 0 : 1);
    const d = Math.pow(R(), 2) * 0.012;
    const b = 1 - d / 0.012;
    const c = lanes[car.lane] < 0 ? mul(C.red, 0.4 + b * 1.6) : mul(mix(C.white, C.cyan, 0.2), 0.3 + b * 1.5);
    w.push(2, row, car.u - d, car.v, 0.02, c, 0.05 + b * 0.05);
  }
  // road markings
  for (let k = 0; k < Math.floor(N * 0.03); k++) {
    const z = 50 - R() * 690;
    if (Math.floor(z / 3) % 2) continue;
    const x = [-3, 0, 3][Math.floor(R() * 3)];
    w.push(1, x + (R() - 0.5) * 0.12, 0.02, z, 0, mul(x === 0 ? C.amber : C.white, 0.18), 0.05);
  }
  // rain streaks around the camera
  const nRain = Math.floor(N * 0.08);
  for (let k = 0; k < nRain; k += 3) {
    const x = (R() - 0.5) * 70, y = (R() - 0.5) * 46, z = (R() - 0.5) * 70, sp = 26 + R() * 10;
    for (let j = 0; j < 3; j++) w.push(3, x, y + j * 0.3, z, sp, mul([0.55, 0.8, 1.0], 0.5 * (1 - j * 0.3)), 0.045);
  }
  dust(w, R, w.left, [60, 40, 700], 1.2, R2 => mul(C.violet, 0.05 + R2() * 0.12));
  // shift dust along the avenue
  return { data: w.d, paths };
};

export function cityLines() {
  const B = cityLayout(1234);
  const v = [];
  const seg = (a, b, c) => v.push(...a, ...c, 0, ...b, ...c, 0);
  for (const b of B) {
    const c = b.row ? mul(C.violet, 0.22) : mul(b.id % 3 ? C.cyan : C.pink, 0.45);
    const P = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
    for (let i = 0; i < 4; i++) {
      const p = P[i], q = P[(i + 1) % 4];
      seg([p[0], b.h, p[1]], [q[0], b.h, q[1]], mul(c, 1.6));
      if (b.row === 0 || i === 0) seg([p[0], 0, p[1]], [p[0], b.h, p[1]], c);
    }
  }
  return new Float32Array(v);
}

// --------------------------------------------------------------- Tokyo Tower (333 m)
function towerSegments() {
  const S = 0.09, Y0 = -15;
  const hw = h => 40 * Math.pow(Math.max(0, 1 - h / 333), 2.2) + 2.2;
  const corner = (h, i, extra = 0) => {
    const r = hw(h) + extra;
    return [(i === 0 || i === 3 ? -1 : 1) * r * S, Y0 + h * S, (i < 2 ? -1 : 1) * r * S];
  };
  const segs = [];
  const band = h => (Math.floor(h / 28) % 2 ? 'w' : 'o');
  const add = (a, b, tag) => segs.push({ a, b, tag });
  for (let h = 0; h < 250; h += 5) for (let i = 0; i < 4; i++) add(corner(h, i), corner(h + 5, i), band(h));
  const lv = [0, 14, 28, 42, 56, 70, 84, 98, 112, 126, 145, 160, 176, 192, 208, 223, 238, 250];
  for (let k = 0; k < lv.length; k++)
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      add(corner(lv[k], i), corner(lv[k], j), band(lv[k]));
      if (k < lv.length - 1) {
        add(corner(lv[k], i), corner(lv[k + 1], j), band(lv[k]));
        add(corner(lv[k], j), corner(lv[k + 1], i), band(lv[k]));
      }
    }
  // base arches
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    let prev = null;
    for (let s = 0; s <= 24; s++) {
      const u = s / 24, h = 52 * Math.pow(Math.sin(Math.PI * u), 0.75);
      const a = corner(h, i), b = corner(h, j);
      const p = [lerp(a[0], b[0], u), a[1], lerp(a[2], b[2], u)];
      if (prev) add(prev, p, 'o');
      prev = p;
    }
  }
  // observation decks
  for (const [h0, h1, ex] of [[145, 160, 7], [223, 236, 3.5]]) {
    for (const h of [h0, (h0 + h1) / 2, h1]) for (let i = 0; i < 4; i++) add(corner(h, i, ex), corner(h, (i + 1) % 4, ex), 'd');
    for (let i = 0; i < 4; i++) add(corner(h0, i, ex), corner(h1, i, ex), 'd');
  }
  // antenna
  for (let h = 250; h < 333; h += 6) add([0, Y0 + h * S, 0], [0, Y0 + Math.min(333, h + 6) * S, 0], h > 300 ? 'o' : 'w');
  for (const h of [260, 280, 300]) for (let i = 0; i < 4; i++) add(corner(h, i, -1.2), corner(h, (i + 1) % 4, -1.2), 'w');
  return segs;
}

const TOWER_COL = { o: mul(C.orange, 1.5), w: mul([1, 0.92, 0.88], 1.0), d: mul(C.teal, 1.6) };

GEN.tower = (N, R) => {
  const w = new Writer(N);
  const segs = towerSegments();
  let tot = 0;
  const acc = segs.map(s => (tot += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2])));
  const n = Math.floor(N * 0.55);
  for (let k = 0; k < n; k++) {
    const t = R() * tot;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (acc[m] < t) lo = m + 1; else hi = m; }
    const s = segs[lo], f = R();
    const c = mul(TOWER_COL[s.tag], 0.35 + R() * 0.5);
    w.push(1, lerp(s.a[0], s.b[0], f), lerp(s.a[1], s.b[1], f), lerp(s.a[2], s.b[2], f), 0.01, c, 0.06);
  }
  // ghost wisps orbiting the tower
  for (let k = 0; k < Math.floor(N * 0.18); k++) {
    const r = 5 + Math.pow(R(), 0.8) * 16;
    const c = mul(R() < 0.6 ? C.teal : C.pink, 0.2 + R() * 0.5);
    w.push(5, r, R() * TAU, -14 + R() * 32, (0.2 + R() * 0.5) * (R() < 0.85 ? 1 : -1) * (8 / r), c, 0.05 + R() * 0.07);
  }
  // ground grid
  for (let k = 0; k < Math.floor(N * 0.1); k++) {
    const gx = Math.round((R() - 0.5) * 40), gz = (R() - 0.5) * 80;
    const sw = R() < 0.5;
    w.push(1, sw ? gx : gz, -15, sw ? gz : gx, 0, mul(C.violet, 0.12 + R() * 0.08), 0.045);
  }
  dust(w, R, w.left, [70, 50, 70], 2);
  return { data: w.d, center: [0, 0, 0] };
};

export function towerLines() {
  const v = [];
  for (const s of towerSegments()) {
    const c = mul(TOWER_COL[s.tag], 0.35);
    const k = (s.a[1] + 15) / 31;
    v.push(...s.a, ...c, k, ...s.b, ...c, k);
  }
  return new Float32Array(v);
}

// --------------------------------------------------------------- Shibuya scramble (top-down)
const RW = 8;
function crosswalks() {
  // [center, direction-of-walk, half-length, half-width]
  const cw = [
    [[0, 0, -RW - 2], [1, 0, 0], RW, 1.6],
    [[0, 0, RW + 2], [1, 0, 0], RW, 1.6],
    [[-RW - 2, 0, 0], [0, 0, 1], RW, 1.6],
    [[RW + 2, 0, 0], [0, 0, 1], RW, 1.6],
    [[0, 0, 0], [Math.SQRT1_2, 0, Math.SQRT1_2], RW * 1.45, 1.5],
    [[0, 0, 0], [Math.SQRT1_2, 0, -Math.SQRT1_2], RW * 1.45, 1.5],
  ];
  return cw;
}

GEN.scramble = (N, R) => {
  const w = new Writer(N);
  const cws = crosswalks();
  // zebra stripes: crisp bars across each crosswalk
  for (let k = 0; k < Math.floor(N * 0.2); k++) {
    const [c, d, hl, hwid] = cws[Math.floor(R() * cws.length)];
    const along = (R() * 2 - 1) * hl;
    if (Math.floor((along + 100) / 1.0) % 2) { k--; continue; }
    const across = (R() * 2 - 1) * hwid;
    const n = [-d[2], 0, d[0]];
    w.push(1, c[0] + d[0] * along + n[0] * across, 0, c[2] + d[2] * along + n[2] * across, 0, mul(C.white, 0.16 + R() * 0.08), 0.06);
  }
  // pedestrians: compact ghost comets walking in lanes across every crosswalk, both ways
  const paths = [];
  const lanes = 5;
  cws.forEach(([c, d, hl, hwid]) => {
    const n = [-d[2], 0, d[0]];
    for (let l = 0; l < lanes; l++) {
      const o = ((l + 0.5) / lanes * 2 - 1) * hwid * 0.85;
      const a = [c[0] - d[0] * (hl + 2) + n[0] * o, 0.1, c[2] - d[2] * (hl + 2) + n[2] * o];
      const b = [c[0] + d[0] * (hl + 2) + n[0] * o, 0.1, c[2] + d[2] * (hl + 2) + n[2] * o];
      paths.push({ rs: resamplePath(l % 2 ? [a, b] : [b, a], false), len: 2 * (hl + 2) });
    }
  });
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const e = RW + 1.2, f = 46;
    paths.push({ rs: resamplePath([[sx * e, 0.1, sz * f], [sx * e, 0.1, sz * e], [sx * f, 0.1, sz * e]], false), len: 2 * (f - e) });
    paths.push({ rs: resamplePath([[sx * f, 0.1, sz * (e + 1)], [sx * (e + 1), 0.1, sz * (e + 1)], [sx * (e + 1), 0.1, sz * f]], false), len: 2 * (f - e) });
  }
  const crossRows = cws.length * lanes;
  const nPed = Math.floor(N * 0.3);
  const peds = Array.from({ length: 1800 }, () => {
    const row = R() < 0.8 ? Math.floor(R() * crossRows) : crossRows + Math.floor(R() * 8);
    const len = paths[row].len;
    return { row, u: R(), v: (1.4 + R() * 1.4) / len, len, pink: R() < 0.16 };
  });
  for (let k = 0; k < nPed; k++) {
    const p = peds[Math.floor(R() * peds.length)];
    const tail = 1.3 / p.len;
    const d = Math.pow(R(), 2.4) * tail;
    const b = 1 - d / tail;
    const c = mul(p.pink ? C.pink : mix(C.teal, C.white, b * 0.7), 0.12 + b * b * 1.3);
    w.push(2, p.row, p.u - d, p.v, 0.12, c, 0.05 + b * 0.06);
  }
  // waiting crowds at the corners
  for (let k = 0; k < Math.floor(N * 0.04); k++) {
    const sx = R() < 0.5 ? -1 : 1, sz = R() < 0.5 ? -1 : 1;
    w.push(1, sx * (RW + 1.5 + R() * 3), 0.1, sz * (RW + 1.5 + R() * 3), 0.06, mul(C.teal, 0.2 + R() * 0.35), 0.05);
  }
  // lit windows on the surrounding buildings (same boxes as the wireframe)
  const boxes = scrambleBoxes();
  let area = 0;
  const acc = boxes.map(bx => (area += (bx.w + bx.d) * bx.h));
  for (let k = 0; k < Math.floor(N * 0.16); k++) {
    const t = R() * area;
    let lo = 0, hi = boxes.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (acc[m] < t) lo = m + 1; else hi = m; }
    const bx = boxes[lo];
    const fl = Math.floor(R() * bx.h / 0.9), cl = Math.floor(R() * 40);
    if (hash1(lo * 131 + fl * 17 + cl * 3) > 0.35) { k--; continue; }
    const y = (fl + 0.5) * 0.9 + (R() - 0.5) * 0.4;
    const onX = R() < bx.w / (bx.w + bx.d);
    const fx = ((cl % 20) + 0.5) / 20 + (R() - 0.5) * 0.03;
    const p = onX ? [bx.x0 + bx.sx * bx.w * fx, y, bx.z0] : [bx.x0, y, bx.z0 + bx.sz * bx.d * fx];
    w.push(1, p[0], p[1], p[2], 0, mul(lo % 3 ? C.amber : C.cyan, 0.5 + R() * 0.5), 0.07);
  }
  // giant street screen facing the crossing
  const r = rasterText(['GHOST', 'CITY'], { font: FONT.orb, weight: 900 });
  const place = fitter(r, 12, 6, 0, 0);
  for (let k = 0; k < Math.floor(N * 0.06); k++) {
    const arr = R() < 0.5 && r.edge.length ? r.edge : r.fill;
    const j = Math.floor(R() * (arr.length / 2)) * 2;
    const [x, y] = place(arr[j], arr[j + 1]);
    w.push(1, -20 + x, 8 + y, -RW - 12, 0.01, mul(mix(C.pink, C.teal, (x + 6) / 12), 0.7), 0.07);
  }
  dust(w, R, w.left, [100, 20, 100], 1.0, R2 => mul(C.violet, 0.05 + R2() * 0.1));
  return { data: w.d, paths: paths.map(p => p.rs) };
};

function scrambleBoxes() {
  const R = rng(99);
  const out = [];
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
    for (let k = 0; k < 9; k++) {
      const x0 = sx * (RW + 4 + R() * 30), z0 = sz * (RW + 4 + R() * 30);
      out.push({ sx, sz, x0, z0, w: 4 + R() * 8, d: 4 + R() * 8, h: 3 + R() * 16, k });
    }
  return out;
}

export function scrambleLines() {
  const v = [];
  const seg = (a, b, c) => v.push(...a, ...c, 0, ...b, ...c, 0);
  for (const bx of scrambleBoxes()) {
    const { sx, sz, x0, z0, w: wdt, d: dep, h } = bx;
    const P = [[x0, z0], [x0 + sx * wdt, z0], [x0 + sx * wdt, z0 + sz * dep], [x0, z0 + sz * dep]];
    const c = mul(bx.k % 2 ? C.cyan : C.pink, 0.6);
    for (let i = 0; i < 4; i++) {
      const p = P[i], q = P[(i + 1) % 4];
      seg([p[0], h, p[1]], [q[0], h, q[1]], c);
      seg([p[0], 0, p[1]], [q[0], 0, q[1]], mul(c, 0.5));
      seg([p[0], 0, p[1]], [p[0], h, p[1]], mul(c, 0.7));
    }
  }
  // curbs
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    seg([sx * RW, 0, sz * RW], [sx * RW, 0, sz * 50], mul(C.white, 0.25));
    seg([sx * RW, 0, sz * RW], [sx * 50, 0, sz * RW], mul(C.white, 0.25));
  }
  // the screen frame
  seg([-27, 4.5, -RW - 12], [-13, 4.5, -RW - 12], mul(C.teal, 0.8));
  seg([-27, 11.5, -RW - 12], [-13, 11.5, -RW - 12], mul(C.teal, 0.8));
  return new Float32Array(v);
}

// --------------------------------------------------------------- katakana rain
const KATA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789幽霊東京';

GEN.glyphRain = (N, R, a) => {
  const w = new Writer(N);
  const cols = 30;
  const W = 2048, H = 1024;
  raster.width = W; raster.height = H;
  rctx.clearRect(0, 0, W, H);
  rctx.fillStyle = '#fff';
  rctx.textAlign = 'center';
  rctx.textBaseline = 'middle';
  const size = 30;
  rctx.font = `400 ${size}px ${FONT.dot}`;
  const colInfo = [];
  for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * (W / cols);
    for (let y = size / 2; y < H; y += size * 1.05) rctx.fillText(KATA[Math.floor(R() * KATA.length)], x, y);
    colInfo.push({ speed: 4 + R() * 9, z: -14 + R() * 20, pink: R() < 0.35, off: R() * 48 });
  }
  const r = scan(W, H, 2);
  const nG = Math.floor(N * (1 - (a.textShare || 0)) * 0.85);
  const all = r.fill.concat(r.edge);
  for (let k = 0; k < nG; k++) {
    const j = Math.floor(R() * (all.length / 2)) * 2;
    const px = all[j], py = all[j + 1];
    const ci = Math.min(cols - 1, Math.floor(px / (W / cols)));
    const info = colInfo[ci];
    const x = (px / W - 0.5) * 64, y = (0.5 - py / H) * 48 + info.off;
    const head = ((y % 12) + 12) % 12 / 12;
    const c = mul(info.pink ? C.pink : C.teal, 0.12 + Math.pow(1 - head, 4) * 1.4);
    w.push(7, x, y, info.z, info.speed, c, 0.06);
  }
  if (a.textShare) {
    const rt = rasterText(a.lines, { font: a.font || FONT.dela, vertical: a.vertical });
    const place = fitter(rt, a.width || 14, a.height || 18, 0, 0);
    textInto(w, R, Math.floor(N * a.textShare), rt, place, { c0: C.white, c1: C.teal, z: 6, edgeK: 1.0, fillK: 0.35 });
  }
  dust(w, R, w.left, [80, 50, 40], 1.5);
  return { data: w.d };
};

// --------------------------------------------------------------- ghost figure (twin tails)
function drawGhostFigure(g) {
  const tail = (pts, w0, w1) => {
    // tapered stroke along a cubic bezier
    const [p0, p1, p2, p3] = pts;
    const B = (t, i) => (1 - t) ** 3 * p0[i] + 3 * (1 - t) ** 2 * t * p1[i] + 3 * (1 - t) * t * t * p2[i] + t ** 3 * p3[i];
    for (let k = 0; k < 60; k++) {
      const t0 = k / 60, t1 = (k + 1) / 60;
      g.lineWidth = lerp(w0, w1, t0);
      g.beginPath();
      g.moveTo(B(t0, 0), B(t0, 1));
      g.lineTo(B(t1, 0), B(t1, 1));
      g.stroke();
    }
  };
  g.lineCap = 'round';
  // twin tails (red channel = hair)
  g.strokeStyle = 'rgb(255,0,0)';
  tail([[425, 235], [300, 330], [300, 640], [205, 960]], 74, 10);
  tail([[599, 235], [724, 330], [730, 620], [835, 950]], 74, 10);
  // body (green channel)
  g.fillStyle = 'rgb(0,255,0)';
  g.strokeStyle = 'rgb(0,255,0)';
  g.beginPath(); g.ellipse(512, 300, 76, 86, 0, 0, TAU); g.fill();
  g.fillRect(496, 370, 32, 46);
  g.beginPath(); g.moveTo(448, 410); g.lineTo(576, 410); g.lineTo(588, 560); g.lineTo(436, 560); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(436, 556); g.lineTo(588, 556); g.lineTo(648, 690); g.lineTo(376, 690); g.closePath(); g.fill();
  g.lineWidth = 30;
  g.beginPath(); g.moveTo(454, 424); g.quadraticCurveTo(410, 520, 402, 628); g.stroke();
  g.beginPath(); g.moveTo(570, 424); g.quadraticCurveTo(640, 470, 700, 380); g.stroke();
  tail([[482, 690], [480, 760], [474, 840], [470, 940]], 34, 6);
  tail([[542, 690], [544, 760], [550, 840], [556, 940]], 34, 6);
  // hair cap + bangs over the head
  g.fillStyle = 'rgb(255,0,0)';
  g.beginPath(); g.ellipse(512, 282, 86, 84, 0, Math.PI * 0.98, Math.PI * 2.02); g.fill();
  g.beginPath(); g.moveTo(428, 280); g.lineTo(470, 330); g.lineTo(490, 285); g.lineTo(512, 340); g.lineTo(536, 285); g.lineTo(556, 332); g.lineTo(596, 280); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(432, 270); g.quadraticCurveTo(420, 360, 438, 420); g.lineTo(452, 300); g.fill();
  g.beginPath(); g.moveTo(592, 270); g.quadraticCurveTo(604, 360, 586, 420); g.lineTo(572, 300); g.fill();
  // accents (blue channel): hair ties + tie
  g.fillStyle = 'rgb(0,0,255)';
  g.fillRect(400, 214, 40, 40);
  g.fillRect(584, 214, 40, 40);
  g.beginPath(); g.moveTo(502, 416); g.lineTo(522, 416); g.lineTo(530, 500); g.lineTo(512, 520); g.lineTo(494, 500); g.closePath(); g.fill();
}

GEN.ghost = (N, R) => {
  const w = new Writer(N);
  const W = 1024, H = 1024;
  raster.width = W; raster.height = H;
  rctx.clearRect(0, 0, W, H);
  drawGhostFigure(rctx);
  const r = scan(W, H, 2);
  const place = fitter(r, 30, 26, 0, 0.5);
  const nFig = Math.floor(N * 0.62);
  for (let k = 0; k < nFig; k++) {
    const useEdge = R() < 0.5;
    const arr = useEdge ? r.edge : r.fill;
    if (!arr.length) continue;
    const j = Math.floor(R() * (arr.length / 2)) * 2;
    const px = arr[j], py = arr[j + 1];
    const o = (py * W + px) * 4;
    const rr = r.img[o], gg = r.img[o + 1], bb = r.img[o + 2];
    let c = rr > gg && rr > bb ? C.teal : bb > gg ? C.pink : mix([0.75, 0.8, 1.0], C.violet, 0.25);
    c = mul(c, (useEdge ? 0.9 : 0.28) * (0.7 + R() * 0.6));
    const [x, y] = place(px + (R() - 0.5) * 2, py + (R() - 0.5) * 2);
    const low = Math.max(0, (py - 700) / 300) + (rr > gg ? Math.max(0, (py - 600) / 400) : 0);
    if (low > 0.05 && R() < low) w.push(6, x, y, (R() - 0.5) * 1.5, 0.4 + low * 2.5, mul(c, 0.8), 0.07);
    else w.push(1, x, y, (R() - 0.5) * 0.8, 0.015, c, 0.075 * (0.7 + R() * 0.6));
  }
  // halo of slow orbiting motes
  for (let k = 0; k < Math.floor(N * 0.2); k++) {
    const rad = 10 + Math.pow(R(), 0.6) * 22;
    w.push(5, rad, R() * TAU, -14 + R() * 30, (0.05 + R() * 0.15) * (R() < 0.5 ? 1 : -1), mul(R() < 0.7 ? C.teal : C.white, 0.08 + R() * 0.3), 0.05 + R() * 0.05);
  }
  dust(w, R, w.left, [90, 50, 50], 2.5, R2 => mul(C.teal, 0.04 + R2() * 0.12));
  return { data: w.d, center: [0, 0, 0] };
};

// --------------------------------------------------------------- spiral vortex
GEN.vortex = (N, R, a) => {
  const w = new Writer(N);
  const share = a.textShare || 0;
  const nV = Math.floor(N * (1 - share) * 0.92);
  for (let k = 0; k < nV; k++) {
    const arm = Math.floor(R() * 3);
    const rad = 1.5 + Math.pow(R(), 1.4) * 34;
    const ang = arm * (TAU / 3) + rad * 0.22 + (R() - 0.5) * 0.7;
    const t = rad / 36;
    const c = mul(mix(mix(C.white, C.teal, Math.min(1, t * 3)), C.pink, Math.max(0, t * 1.4 - 0.4)), (0.15 + R() * 0.45) * (1.3 - t));
    w.push(5, rad, ang, (R() - 0.5) * (1.2 + rad * 0.08), 1.6 / Math.sqrt(rad + 1), c, 0.05 + R() * 0.06);
  }
  if (share) {
    const r = rasterText(a.lines, { font: a.font || FONT.dela });
    const place = fitter(r, a.width || 34, a.height || 14, 0, 0);
    textInto(w, R, Math.floor(N * share), r, place, { c0: C.teal, c1: C.pink, z: 0, edgeK: 1.0 });
  }
  dust(w, R, w.left, [90, 50, 60], 2);
  return { data: w.d, center: [0, 0, 0] };
};

export function generate(kind, N, args = {}, key = '') {
  const gen = GEN[kind];
  if (!gen) throw new Error('unknown shape ' + kind);
  return gen(N, rng(hashStr(kind + key + JSON.stringify(args))), args);
}

export const lineSets = { map: mapLines, city: cityLines, tower: towerLines, scramble: scrambleLines };
