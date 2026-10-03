// The director: scene list, particle keyframes, cameras, post settings and overlays.
// Everything is a pure function of the song time t, so the PV can be scrubbed and
// rendered offline frame-by-frame with identical results.
import { mat4, clamp, lerp, smooth, ease, fract, noise1, project, v3 } from './math.js';
import { RAILS, STATIONS, LANDMARKS, ORIGIN } from './data/tokyo.js';
import { COL, DW, DH, scrambleText } from './ui.js';
import { FONT } from './fonts.js';
import { resamplePath } from './gl.js';
import { C } from './shapes.js';

export const BPM = 124;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const TOTAL_BARS = 108;
export const DURATION = TOTAL_BARS * BAR;

const KX = Math.cos((ORIGIN[0] * Math.PI) / 180) * 111.32, KY = 110.57;
const latlng = p => `${(ORIGIN[0] - p[1] / KY).toFixed(4)}N ${(ORIGIN[1] + p[0] / KX).toFixed(4)}E`;
const station = ja => STATIONS.find(s => s.ja === ja);
const tc = t => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

// ------------------------------------------------------------------ particle keyframes
// [bar, shape, morph length in bars, extras]
const T = (lines, o = {}) => ({ kind: 'text', args: { lines, ...o } });
const ORB = { font: FONT.orb, weight: 900, width: 40, height: 12 };
const PINK_TEAL = { c0: C.pink, c1: C.teal };
const TEAL_WHITE = { c0: C.teal, c1: C.white };
const VIOLET_PINK = { c0: C.violet, c1: C.pink };
const KEYS = [
  [0, { kind: 'boot' }, 0.01],
  [2, T(['幽霊東京'], { width: 40, height: 12, tunnel: 0, dust: 0.3 }), 1.5, { swirl: 1.2 }],
  [8, { kind: 'map' }, 1.5, { scatter: 14 }],
  [24, { kind: 'city' }, 0.6, { scatter: 8 }],
  [32, T(['幽霊']), 0.35, { scatter: 22 }],
  [34, T(['東京'], PINK_TEAL), 0.35, { scatter: 12 }],
  [36, T(['GHOST'], { ...ORB, ...TEAL_WHITE }), 0.35, { scatter: 12 }],
  [38, T(['CITY'], { ...ORB, ...PINK_TEAL }), 0.35, { scatter: 12 }],
  [40, T(['ネオン'], VIOLET_PINK), 0.35, { scatter: 12 }],
  [42, T(['亡霊'], TEAL_WHITE), 0.35, { scatter: 12 }],
  [44, T(['夜行'], PINK_TEAL), 0.35, { scatter: 12 }],
  [46, T(['幽霊', '東京'], { width: 22, height: 22 }), 0.35, { scatter: 16 }],
  [48, { kind: 'tower' }, 1, { scatter: 10, swirl: 1.5 }],
  [52, { kind: 'scramble' }, 1, { scatter: 10 }],
  [64, { kind: 'glyphRain', args: { textShare: 0.22, lines: ['電脳'], vertical: true } }, 0.75, { scatter: 8 }],
  [70, T(['東京'], TEAL_WHITE), 0.35, { scatter: 22 }],
  [72, T(['幽霊'], PINK_TEAL), 0.35, { scatter: 12 }],
  [74, T(['新宿'], { c0: C.teal, c1: C.violet }), 0.35, { scatter: 12 }],
  [76, T(['渋谷'], PINK_TEAL), 0.35, { scatter: 12 }],
  [78, T(['池袋'], VIOLET_PINK), 0.35, { scatter: 12 }],
  [80, T(['秋葉原'], TEAL_WHITE), 0.35, { scatter: 12 }],
  [82, T(['GHOST', 'CITY'], { ...ORB, width: 30, height: 18, ...PINK_TEAL }), 0.35, { scatter: 12 }],
  [84, { kind: 'ghost' }, 2.5, { scatter: 6, swirl: 0.8 }],
  [92, { kind: 'map' }, 0.5, { scatter: 18 }],
  [96, T(['幽霊'], TEAL_WHITE), 0.35, { scatter: 20 }],
  [98, T(['東京'], PINK_TEAL), 0.35, { scatter: 12 }],
  [100, T(['GHOST', 'CITY', 'TOKYO'], { ...ORB, width: 26, height: 22, ...TEAL_WHITE }), 0.35, { scatter: 12 }],
  [102, { kind: 'vortex', args: { textShare: 0.4, lines: ['幽霊東京'], width: 34, height: 10 } }, 2, { scatter: 6, swirl: 2 }],
].map(([bar, shape, morph, x = {}]) => ({ t: bar * BAR, bar, shape, morph: morph * BAR, scatter: x.scatter || 0, swirl: x.swirl || 0 }));

export const PRELOAD = KEYS.map(k => k.shape);

// ------------------------------------------------------------------ one-beat cut-ins
// [bar, beat, text, bg, fg, font]
const CUTINS = [
  [6, 0, '幽', COL.teal], [6, 1, '霊', COL.pink], [6, 2, '東', COL.white], [6, 3, '京', COL.teal],
  [7, 0, 'GHOST', COL.pink, COL.ink, FONT.orb], [7, 1, 'CITY', COL.white, COL.ink, FONT.orb], [7, 2, 'TOKYO', COL.teal, COL.ink, FONT.orb],
  [31, 0, '幽', COL.pink], [31, 1, '霊', COL.teal], [31, 2, '東', COL.white], [31, 3, '京', COL.pink],
  [47, 2, 'ゴースト', COL.teal], [47, 3, 'シティ', COL.pink],
  [69, 0, '3', COL.white, COL.ink, FONT.orb], [69, 1, '2', COL.teal, COL.ink, FONT.orb], [69, 2, '1', COL.pink, COL.ink, FONT.orb], [69, 3, '0', COL.yellow, COL.ink, FONT.orb],
  [91, 1, '再', COL.teal], [91, 2, '起', COL.pink], [91, 3, '動', COL.white],
  [95, 0, '幽', COL.teal], [95, 1, '霊', COL.pink], [95, 2, '東', COL.white], [95, 3, '京', COL.teal],
  [101, 0, 'お', COL.white], [101, 1, 'や', COL.teal], [101, 2, 'す', COL.pink], [101, 3, 'み', COL.white],
].map(([bar, beat, text, bg, fg = COL.ink, font = FONT.dela]) => ({ t: (bar * 4 + beat) * BEAT, text, bg, fg, font }));

function activeCutin(t) {
  for (const c of CUTINS) if (t >= c.t && t < c.t + BEAT * 0.92) return { ...c, lt: (t - c.t) / BEAT };
  return null;
}

// ------------------------------------------------------------------ helpers
const DEFAULT_BG = {
  top: [0.025, 0.012, 0.07], bot: [0.0, 0.0, 0.012], glow: [0.55, 0.08, 0.5], gridCol: [0.15, 0.85, 1.0],
  horizon: 0.36, grid: 0, sky: 0, stars: 0, speed: 0, moon: 0, skyScroll: 0,
};
const DEFAULT_POST = {
  bloom: 1.1, threshold: 0.85, chroma: 0.35, glitch: 0, scan: 0.1, vignette: 0.7, grain: 0.04, exposure: 1.0,
  invert: 0, flash: 0, flashCol: [1, 1, 1], sat: 1.12, tint: [1, 1, 1], uiGain: 1.0, uiGlow: 0.9, raw: 0,
};

const yamanote = (() => {
  const r = RAILS.find(x => x.name === 'Yamanote');
  const res = resamplePath(r.pts.map(([x, z]) => [x, 0, z]), true, 512);
  return { at: u => {
    const f = fract(u) * 511, i = Math.floor(f), k = f - i, d = res.data;
    const j = Math.min(511, i + 1);
    return [lerp(d[i * 4], d[j * 4], k), 0, lerp(d[i * 4 + 2], d[j * 4 + 2], k)];
  }, length: res.length };
})();

function hud(u, S, a, section) {
  if (a <= 0.01) return;
  const m = 46;
  u.brackets(m, m, DW - 2 * m, DH - 2 * m, 30, COL.teal, 2, a * 0.7);
  u.text('幽霊東京', m + 22, m + 50, { size: 30, font: FONT.zen, weight: 900, alpha: a });
  u.text('GHOST CITY TOKYO', m + 162, m + 46, { size: 15, font: FONT.orb, weight: 900, color: COL.teal, alpha: a, spacing: 6 });
  u.text(`${BPM} BPM / C MINOR / 4:4`, DW - m - 22, m + 46, { size: 17, font: FONT.mono, align: 'right', alpha: a * 0.85, spacing: 2 });
  if (fract(S.t * 0.9) < 0.6) u.rect(DW - m - 120, m + 64, 11, 11, COL.pink, a);
  u.text('LIVE', DW - m - 22, m + 75, { size: 15, font: FONT.mono, color: COL.pink, align: 'right', alpha: a, spacing: 4 });
  u.text(tc(S.t), m + 22, DH - m - 22, { size: 30, font: FONT.mono, alpha: a });
  u.text(`BAR ${String(S.bar + 1).padStart(3, '0')}.${S.beatInBar + 1}`, m + 22, DH - m - 62, { size: 15, font: FONT.mono, color: COL.teal, alpha: a, spacing: 3 });
  u.text(section, m + 232, DH - m - 24, { size: 19, font: FONT.dot, color: COL.teal, alpha: a });
  u.spectrum(DW - m - 262, DH - m - 76, 240, 52, S.bands, COL.teal, a * 0.85);
  for (let i = 0; i < 4; i++) u.rect(DW - m - 262 + i * 18, DH - m - 96, 12, 6, i === S.beatInBar ? COL.pink : COL.white, a * (i === S.beatInBar ? 1 : 0.3));
  u.barcode(DW - m - 140, DH - m - 98, 118, 10, Math.floor(S.t * 4), COL.white, a * 0.5);
}

function lyrics(u, S, style = 'bottom', a = 1) {
  const L = S.lyric;
  if (!L || a <= 0.01) return;
  const age = S.t - L.t;
  const out = L.end != null ? clamp((L.end - S.t) / 0.25) : 1;
  const chars = [...L.text];
  const big = style === 'center';
  const size = big ? 92 : 58;
  const y = big ? DH * 0.8 : DH - 150;
  const g = u.g;
  g.save();
  g.font = `900 ${size}px ${FONT.zen}`;
  const widths = chars.map(c => g.measureText(c).width);
  g.restore();
  const total = widths.reduce((p, q) => p + q, 0);
  let x = DW / 2 - total / 2;
  chars.forEach((ch, i) => {
    const k = clamp((age - i * 0.045) / 0.18);
    if (k <= 0) { x += widths[i]; return; }
    const pop = ease.outBack(k);
    const cx = x + widths[i] / 2;
    const yy = y + (1 - pop) * 30;
    u.text(ch, cx + 5, yy + 5, { size, font: FONT.zen, weight: 900, color: COL.pink, align: 'center', alpha: a * out * k * 0.9 });
    u.text(ch, cx, yy, { size, font: FONT.zen, weight: 900, color: COL.white, align: 'center', alpha: a * out * k, stroke: 6, strokeColor: '#0a0614' });
    x += widths[i];
  });
}

const env = (lt, len, fin = 0.4, fout = 0.4) => clamp(lt / fin) * clamp((len - lt) / fout);
const pulseAt = (S, every = 1) => Math.exp(-fract(S.beat / every) * 5);

// ------------------------------------------------------------------ scenes
const SCENES = [
  {
    id: 'intro', from: 0, to: 8, section: 'BOOT // 起動',
    bg: (lt, S) => ({ stars: 0.6 * smooth(2, 6, S.barF), glow: [0.2, 0.05, 0.3] }),
    cam: lt => ({ eye: [Math.sin(lt * 0.1) * 3, 1 + Math.sin(lt * 0.13), 40 - lt * 0.35], target: [0, 0, 0], fov: 45 }),
    post: (lt, S) => ({
      scan: 0.3, grain: 0.08, bloom: 1.25,
      glitch: Math.max(0, 1 - Math.abs(S.barF - 2) * 3) * 0.8 + (S.barF < 2 ? 0.05 : 0),
      flash: Math.exp(-Math.max(0, S.barF - 2) * 6) * (S.barF >= 2 ? 0.6 : 0),
      flashCol: [0.3, 1, 0.9],
    }),
    particles: (lt, S) => ({ alpha: smooth(0, 1.5, S.barF), turb: S.barF < 2 ? 0.25 : 0.02 }),
    hud: S => smooth(5, 6, S.barF) * 0.9,
    ui(u, lt, S) {
      const bf = S.barF;
      const log = [
        '> GHOST_CITY.SYS  v2.0.19  booting',
        '> mount /dev/tokyo ............... ok',
        `> wards: 23   stations: ${STATIONS.length}   lines: ${RAILS.length}`,
        `> clock: ${BPM}.000 BPM   key: C minor`,
        '> scanning for ghosts ............ found',
      ];
      const la = 1 - smooth(1.8, 2.2, bf);
      log.forEach((l, i) => {
        const start = i * 0.32 * BAR;
        const n = Math.floor(clamp((lt - start) * 46, 0, l.length));
        if (n <= 0) return;
        const typing = n < l.length || i === log.length - 1 || lt < (i + 1) * 0.32 * BAR;
        const cursor = typing && fract(S.t * 3) < 0.6 ? '█' : '';
        u.text(l.slice(0, n) + cursor, 160, 300 + i * 54, { size: 32, font: FONT.mono, color: i === 4 ? COL.pink : COL.teal, alpha: la });
      });
      if (bf > 2) {
        const k = ease.outExpo(clamp((bf - 2.3) / 1.5));
        const a = smooth(2.2, 3, bf) * (1 - smooth(5.8, 6, bf));
        u.line(DW / 2 - 640 * k, DH * 0.69, DW / 2 + 640 * k, DH * 0.69, COL.teal, 2, a);
        u.text(scrambleText('GHOST CITY TOKYO', (bf - 2.5) * 0.8, S.t), DW / 2, DH * 0.69 + 62, { size: 46, font: FONT.orb, weight: 900, align: 'center', spacing: 18, alpha: a });
        u.text(scrambleText('Ayase feat. 初音ミク', (bf - 3.3) * 0.8, S.t, 9), DW / 2, DH * 0.69 + 118, { size: 30, font: FONT.zen, weight: 900, color: COL.teal, align: 'center', spacing: 4, alpha: a });
        u.text('UNOFFICIAL FAN-MADE PARTICLE PV', DW / 2, DH * 0.69 + 160, { size: 15, font: FONT.mono, align: 'center', spacing: 6, alpha: a * 0.6 * smooth(4, 4.5, bf) });
        u.text('ゴーストシティトーキョー', DW / 2, DH * 0.24, { size: 24, font: FONT.dot, color: COL.pink, align: 'center', spacing: 14, alpha: a * smooth(3.5, 4, bf) });
      }
    },
  },
  {
    id: 'map', from: 8, to: 24, section: 'RAILNET // 鉄道網',
    bg: () => ({ glow: [0.25, 0.05, 0.35], horizon: 0.5 }),
    cam(lt) {
      const k = ease.inOutSine(clamp(lt / (16 * BAR)));
      const a = -0.75 + k * 1.25;
      const R = lerp(30, 21, k), H = lerp(44, 15, k);
      return { eye: [Math.sin(a) * R, H, Math.cos(a) * R], target: [0, 0, 1.5 - k * 2], fov: 50 };
    },
    lines: lt => [{ name: 'map', alpha: 0.9, reveal: clamp(lt / (3 * BAR)) * 1.05 }],
    post: (lt, S) => ({ flash: Math.exp(-lt * 5) * 0.8, flashCol: [0.3, 1, 0.9], glitch: Math.exp(-lt * 4) * 0.6 }),
    particles: () => ({ size: 1.0 }),
    hud: () => 0.9,
    ui(u, lt, S) {
      const list = ['新宿', '渋谷', '池袋', '東京', '上野', '秋葉原', '品川', '六本木', '原宿', '銀座', '浅草', '押上', '中野', '恵比寿'];
      list.forEach((name, i) => {
        const st = station(name);
        if (!st) return;
        const t0 = (1 + i) * BAR * 1.0, local = lt - t0;
        if (local < 0 || local > BAR * 3.2) return;
        const scr = S.proj([st.p[0], 0, st.p[1]]);
        if (!scr) return;
        const a = clamp(local / 0.15) * clamp((BAR * 3.2 - local) / 0.4);
        u.callout(scr[0], scr[1], st.ja, st.en, { color: i % 2 ? COL.pink : COL.teal, alpha: a, side: scr[0] > DW / 2 ? 1 : -1, p: local / 0.6, sub: latlng(st.p) });
      });
      const pa = env(lt, 16 * BAR, 1, 1);
      u.vtext('東京都区部', 120, 170, { size: 56, font: FONT.dela, color: COL.white, alpha: pa * 0.9 });
      u.vtext('鉄道網・二十三区', 196, 176, { size: 22, font: FONT.dot, color: COL.teal, alpha: pa * 0.8 });
      const rows = [`LINES     ${RAILS.length}`, `STATIONS  ${STATIONS.length}`, 'WARDS     23', `山手線    ${yamanote.length.toFixed(1)} km`];
      rows.forEach((r, i) => u.text(scrambleText(r, (lt - 1 - i * 0.3) * 1.5, S.t, i), DW - 380, 200 + i * 34, { size: 20, font: FONT.mono, color: i === 3 ? COL.teal : COL.white, alpha: pa * 0.85 }));
      lyrics(u, S, 'bottom');
    },
  },
  {
    id: 'city', from: 24, to: 32, section: 'NEON AVENUE // 夜行',
    bg: (lt, S) => ({ sky: 0.0, glow: [0.4, 0.05, 0.45], horizon: 0.42, top: [0.02, 0.0, 0.05] }),
    cam(lt) {
      const z = 48 - lt * 33 - Math.pow(Math.max(0, lt - 12), 2) * 3;
      const y = 5.5 + Math.sin(lt * 0.5) * 2 + Math.max(0, lt - 10) * 1.2;
      const x = Math.sin(lt * 0.7) * 1.3;
      return { eye: [x, y, z], target: [x + Math.sin(lt * 0.4) * 4, y - 1.5, z - 30], fov: 60 + smooth(10, 15.5, lt) * 18, roll: Math.sin(lt * 0.6) * 0.07 };
    },
    lines: () => [{ name: 'city', alpha: 0.75, reveal: 2 }],
    post: (lt, S) => ({ chroma: 0.5 + smooth(10, 15.5, lt) * 1.2, bloom: 1.3, glitch: S.beatInBar === 3 && fract(S.beat) > 0.5 ? 0.25 : 0, flash: Math.exp(-lt * 6) * 0.5 }),
    particles: () => ({ size: 0.9 }),
    hud: () => 0.85,
    ui(u, lt, S) {
      const a = env(lt, 8 * BAR, 0.3, 0.2);
      for (let c = 0; c < 2; c++) {
        const x = c ? DW - 120 : 120;
        const off = fract(S.t * (0.6 + c * 0.3)) * 46;
        for (let i = -1; i < 22; i++) {
          const ch = scrambleText('カ', 0, S.t * 0.5 + i * 0.37, c * 50 + i);
          u.text(ch, x, 160 + i * 46 + off, { size: 32, font: FONT.dot, color: c ? COL.pink : COL.teal, align: 'center', alpha: a * 0.35 });
        }
      }
      const kmh = Math.floor(124 + lt * 18 + Math.pow(Math.max(0, lt - 12), 2) * 40);
      u.text(`${kmh}`, DW - 300, DH / 2 + 20, { size: 72, font: FONT.orb, weight: 900, align: 'right', alpha: a * 0.9 });
      u.text('km/h', DW - 290, DH / 2 + 20, { size: 22, font: FONT.mono, color: COL.teal, alpha: a });
      u.text('VELOCITY', DW - 300, DH / 2 - 52, { size: 16, font: FONT.mono, color: COL.teal, align: 'right', alpha: a, spacing: 6 });
      if (S.barF > 30) {
        const k = smooth(30, 30.2, S.barF);
        u.stripes(0, 90, DW, 54, COL.yellow, k * 0.9, S.t * 2);
        u.stripes(0, DH - 144, DW, 54, COL.yellow, k * 0.9, -S.t * 2);
        u.text('注意  CAUTION  GHOST SIGNAL APPROACHING  注意', DW / 2, 230, { size: 34, font: FONT.zen, weight: 900, color: COL.yellow, align: 'center', alpha: k * (fract(S.beat * 2) < 0.5 ? 1 : 0.4), spacing: 4 });
      }
      lyrics(u, S, 'bottom');
    },
  },
  chorus({ id: 'chorus1', from: 32, to: 48, section: 'CHORUS // 幽霊東京', palette: [COL.teal, COL.pink] }),
  {
    id: 'tower', from: 48, to: 52, section: 'TOKYO TOWER // 333m',
    bg: () => ({ stars: 0.7, glow: [0.6, 0.15, 0.08], horizon: 0.18, top: [0.03, 0.01, 0.06] }),
    cam(lt) {
      const a = 0.4 + lt * 0.28;
      return { eye: [Math.sin(a) * 32, -9 + lt * 0.8, Math.cos(a) * 32], target: [0, 3, 0], fov: 55 };
    },
    lines: lt => [{ name: 'tower', alpha: 0.8, reveal: clamp(lt / (2 * BAR)) * 1.05 }],
    post: lt => ({ tint: [1.06, 0.97, 0.95], flash: Math.exp(-lt * 5) * 0.7, flashCol: [1, 0.5, 0.2] }),
    hud: () => 0.8,
    ui(u, lt, S) {
      const a = env(lt, 4 * BAR, 0.4, 0.3);
      const top = S.proj([0, 15, 0]);
      if (top) u.callout(top[0], top[1], '東京タワー', 'Tokyo Tower', { color: COL.pink, alpha: a, side: 1, dy: -40, p: lt / 0.8, sub: '333m · 1958 · 35.6586N 139.7454E' });
      const x = DW - 170;
      u.line(x, 220, x, 860, COL.white, 1.5, a * 0.6);
      for (let h = 0; h <= 333; h += 37) {
        const y = 860 - (h / 333) * 640;
        u.line(x - 14, y, x, y, COL.white, 1.5, a * 0.6);
        u.text(`${h}`, x - 22, y + 6, { size: 15, font: FONT.mono, align: 'right', alpha: a * 0.6 });
      }
      const mh = (fract(lt / (2 * BAR)) * 333);
      const my = 860 - (mh / 333) * 640;
      u.rect(x + 6, my - 2, 40, 4, COL.pink, a);
      u.text(`${mh.toFixed(0)}m`, x + 52, my + 6, { size: 18, font: FONT.mono, color: COL.pink, alpha: a });
      lyrics(u, S, 'bottom');
    },
  },
  {
    id: 'scramble', from: 52, to: 64, section: 'SHIBUYA // 交差点',
    bg: () => ({ glow: [0.15, 0.05, 0.3], horizon: 0.5 }),
    cam(lt) {
      const r = lt * 0.06;
      const k = ease.inOutCubic(smooth(10, 20, lt));
      const top = [Math.sin(r) * 0.5, 62 - lt * 0.6, Math.cos(r) * 0.5];
      const tilt = [Math.sin(r + 0.6) * 40, 26, Math.cos(r + 0.6) * 40];
      const up = v3.norm(v3.lerp([-Math.sin(r), 0, -Math.cos(r)], [0, 1, 0], k));
      return { eye: v3.lerp(top, tilt, k), target: [0, 0, 0], up, fov: 52 };
    },
    lines: lt => [{ name: 'scramble', alpha: 0.75, reveal: clamp(lt / BAR) * 1.05 }],
    post: lt => ({ sat: 1.0, tint: [0.95, 1.02, 1.06], flash: Math.exp(-lt * 5) * 0.6 }),
    hud: () => 0.9,
    ui(u, lt, S) {
      const a = env(lt, 12 * BAR, 0.5, 0.4);
      u.text('渋谷スクランブル交差点', 110, 200, { size: 52, font: FONT.dela, alpha: a });
      u.text('SHIBUYA SCRAMBLE CROSSING · 35.6595N 139.7005E', 112, 240, { size: 18, font: FONT.mono, color: COL.teal, alpha: a, spacing: 3 });
      const n = Math.floor(lt * 233 + Math.sin(lt) * 20);
      u.text('GHOSTS CROSSING', 112, 300, { size: 16, font: FONT.mono, color: COL.white, alpha: a * 0.7, spacing: 4 });
      u.text(n.toLocaleString('en-US').padStart(6, ' '), 112, 360, { size: 60, font: FONT.orb, weight: 900, color: COL.white, alpha: a });
      const green = fract(lt / (4 * BAR)) < 0.75;
      u.rect(112, 392, 24, 24, green ? COL.teal : COL.pink, a * (green || fract(S.beat) < 0.5 ? 1 : 0.3));
      u.text(green ? '歩行者信号 · 青' : '歩行者信号 · 赤', 150, 412, { size: 22, font: FONT.zen, weight: 900, color: green ? COL.teal : COL.pink, alpha: a });
      lyrics(u, S, 'bottom');
    },
  },
  {
    id: 'glyph', from: 64, to: 70, section: 'DATA RAIN // 電脳',
    bg: () => ({ glow: [0.05, 0.25, 0.25], horizon: 0.2, top: [0.0, 0.02, 0.03] }),
    cam: lt => ({ eye: [Math.sin(lt * 0.2) * 3, 0, 32 - lt * 0.5], target: [0, 0, 0], fov: 55, roll: Math.sin(lt * 0.3) * 0.05 }),
    post: (lt, S) => ({ invert: S.beatInBar === 3 && fract(S.beat) < 0.25 && S.barF < 69 && Math.floor(S.barF) % 2 ? 1 : 0, flash: Math.exp(-lt * 6) * 0.5, chroma: 0.6 }),
    hud: () => 0.6,
    ui(u, lt, S) {
      const a = env(lt, 6 * BAR, 0.4, 0.3);
      u.vtext('電脳亡霊', DW - 160, 170, { size: 64, font: FONT.dela, color: COL.white, alpha: a * 0.85 });
      u.vtext('でんのうぼうれい', DW - 240, 176, { size: 22, font: FONT.dot, color: COL.teal, alpha: a * 0.7 });
      lyrics(u, S, 'bottom');
    },
  },
  chorus({ id: 'chorus2', from: 70, to: 84, section: 'CHORUS II // 東京', palette: [COL.pink, COL.teal], stations: true }),
  {
    id: 'bridge', from: 84, to: 92, section: 'BRIDGE // 幽',
    bg: () => ({ stars: 0.5, moon: 0.9, glow: [0.05, 0.3, 0.3], horizon: 0.12, top: [0.01, 0.02, 0.05] }),
    cam: lt => ({ eye: [Math.sin(lt * 0.15) * 5, 2, 44 - lt * 0.55], target: [0, 1.5, 0], fov: 45 }),
    post: (lt, S) => {
      const lost = smooth(89.9, 90, S.barF) * (1 - smooth(91, 91.05, S.barF));
      return { sat: lerp(0.75, 0, lost), bloom: 1.4, chroma: 0.15 + lost * 1.5, grain: 0.1 + lost * 0.1, scan: 0.25, glitch: lost * 0.5, exposure: 1 - lost * 0.4 };
    },
    particles: (lt, S) => ({ turb: 0.03 + smooth(89, 90, S.barF) * 0.6, alpha: 1 - smooth(90, 90.5, S.barF) * 0.75 }),
    hud: () => 0.35,
    ui(u, lt, S) {
      const bf = S.barF;
      const a = env(lt, 8 * BAR, 1, 0.1);
      // heartbeat monitor that slowly flatlines
      const g = u.g;
      const y0 = DH * 0.86;
      const amp = 1 - smooth(88, 90, bf);
      g.save();
      g.globalAlpha = a * 0.85;
      g.strokeStyle = bf > 90 ? COL.pink : COL.teal;
      g.lineWidth = 3;
      g.beginPath();
      for (let x = 0; x <= DW; x += 6) {
        const tb = S.beat - (DW - x) / DW * 4;
        const ph = fract(tb);
        const spike = ph < 0.06 ? Math.sin(ph / 0.06 * Math.PI) * -90 : ph < 0.1 ? Math.sin((ph - 0.06) / 0.04 * Math.PI) * 40 : 0;
        const y = y0 + spike * amp * (0.6 + 0.4 * noise1(Math.floor(tb) * 1.3));
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.restore();
      if (bf > 90 && bf < 91.25) {
        u.text('SIGNAL LOST', DW / 2, DH / 2 + 20, { size: 96, font: FONT.orb, weight: 900, color: COL.pink, align: 'center', spacing: 14, alpha: fract(S.beat * 2) < 0.7 ? 1 : 0.2 });
        u.text('信号消失', DW / 2, DH / 2 + 90, { size: 40, font: FONT.zen, weight: 900, align: 'center', spacing: 20 });
      }
      u.text('— 幽 —', DW / 2, 160, { size: 30, font: FONT.zen, weight: 900, color: COL.teal, align: 'center', alpha: a * 0.6 * (1 - smooth(89, 90, bf)), spacing: 20 });
      lyrics(u, S, 'bottom', 1 - smooth(89.5, 90, bf));
    },
  },
  {
    id: 'final', from: 92, to: 102, section: 'FINAL // 終点',
    bg: (lt, S) => (S.barF < 96 ? { glow: [0.3, 0.05, 0.4], horizon: 0.55, stars: 0.4 } : { grid: 0.8, speed: 6, horizon: 0.3, glow: [0.6, 0.05, 0.5] }),
    cam(lt, S) {
      if (S.barF < 96) {
        const u = 0.05 + (lt / (4 * BAR)) * 0.85;
        const p = yamanote.at(u), q = yamanote.at(u + 0.04);
        return { eye: [p[0], 3.2, p[2]], target: [q[0], 0.2, q[2]], fov: 68, roll: Math.sin(lt * 1.3) * 0.06 };
      }
      return chorusCam(S.t - 96 * BAR, S);
    },
    lines: (lt, S) => (S.barF < 96 ? [{ name: 'map', alpha: 1, reveal: 2 }] : []),
    post: (lt, S) => {
      const p = pulseAt(S);
      const restored = Math.exp(-lt * 3);
      const fly = S.barF < 96;
      return { flash: restored * 1.2 + (fly ? 0 : Math.exp(-fract(S.barF) * 6) * 0.25), flashCol: [0.3, 1, 0.9], chroma: fly ? 0.3 + p * 0.5 : 0.5 + p * 1.2, bloom: 1.3, exposure: 1 + p * 0.12, glitch: Math.exp(-lt * 2) * 0.6 };
    },
    particles: (lt, S) => ({ size: S.barF < 96 ? 0.55 : 1, turb: S.barF >= 96 ? 0.02 + pulseAt(S) * 0.12 : 0 }),
    hud: S => (S.barF < 96 ? 0.9 : 0.5),
    ui(u, lt, S) {
      if (S.barF < 92.6) {
        const k = smooth(92, 92.1, S.barF) * (1 - smooth(92.45, 92.6, S.barF));
        u.text('SIGNAL RESTORED', DW / 2, DH / 2, { size: 84, font: FONT.orb, weight: 900, color: COL.teal, align: 'center', spacing: 12, alpha: k });
      }
      if (S.barF < 96) {
        const a = env(lt, 4 * BAR, 0.5, 0.2);
        u.text('JR山手線', 110, 200, { size: 56, font: FONT.dela, alpha: a });
        u.text(`YAMANOTE LINE · LOOP ${yamanote.length.toFixed(1)} km · 30 STATIONS`, 112, 240, { size: 18, font: FONT.mono, color: COL.teal, alpha: a, spacing: 3 });
        const r = RAILS.find(x => x.name === 'Yamanote');
        r.pts.forEach((p, i) => {
          const scr = S.proj([p[0], 0, p[1]]);
          if (!scr || scr[2] > 9 || scr[2] < 0.5) return;
          const al = clamp((9 - scr[2]) / 3) * clamp((scr[2] - 0.5) / 1);
          const st = station(r.st[i]);
          u.callout(scr[0], scr[1], r.st[i], st ? st.en : '', { color: i % 2 ? COL.pink : COL.teal, alpha: al * a, side: scr[0] > DW / 2 ? 1 : -1, dy: -110, p: 1 });
        });
      } else {
        chorusUI(u, S.t - 96 * BAR, S, [COL.teal, COL.pink], ['幽霊', '東京', 'GHOST CITY TOKYO'], 96);
      }
      lyrics(u, S, S.barF < 96 ? 'bottom' : 'center');
    },
  },
  {
    id: 'outro', from: 102, to: 108, section: 'END // おやすみ',
    bg: () => ({ stars: 0.8, glow: [0.3, 0.05, 0.4], horizon: 0.25 }),
    cam: lt => ({ eye: [Math.sin(lt * 0.05) * 4, 9 + lt * 0.25, 40 + lt * 0.6], target: [0, -1, 0], fov: 50 }),
    post: (lt, S) => ({ exposure: 1 - smooth(106.5, 108, S.barF), flash: Math.exp(-lt * 3) * 0.8, flashCol: [1, 1, 1], bloom: 1.35 }),
    particles: (lt, S) => ({ alpha: 1 - smooth(106.5, 108, S.barF) }),
    hud: S => 0.5 * (1 - smooth(105, 106, S.barF)),
    ui(u, lt, S) {
      const a = smooth(103, 104, S.barF) * (1 - smooth(106.8, 107.8, S.barF));
      const rows = [
        ['幽霊東京 / GHOST CITY TOKYO', 30, FONT.zen, COL.white],
        ['MUSIC & LYRICS  Ayase      VOCAL  初音ミク', 18, FONT.mono, COL.teal],
        ['UNOFFICIAL FAN-MADE PARTICLE PV', 15, FONT.mono, COL.white],
        ['MAP 地球地図日本 (GSI) · STATIONS ekidata.jp / japan-train-data', 13, FONT.mono, COL.white],
        ['FONTS Dela Gothic One · DotGothic16 · Zen Kaku Gothic New · Orbitron · Share Tech Mono (OFL)', 13, FONT.mono, COL.white],
      ];
      rows.forEach(([s, size, font, color], i) => u.text(s, DW / 2, DH * 0.74 + i * 38, { size, font, weight: 900, color, align: 'center', spacing: size < 20 ? 4 : 6, alpha: a * (i ? 0.75 : 1) }));
      lyrics(u, S, 'bottom');
    },
  },
];

function chorusCam(lt, S) {
  const word = Math.floor(lt / (2 * BAR));
  const wl = lt - word * 2 * BAR;
  const push = ease.outExpo(clamp(wl / (0.5 * BAR)));
  const dir = word % 2 ? 1 : -1;
  const a = dir * (0.22 - wl * 0.03);
  const d = lerp(48, 36, push) - wl * 0.4;
  return { eye: [Math.sin(a) * d, 1.5 + Math.sin(lt * 0.5) * 1.5, Math.cos(a) * d], target: [0, 0, 0], fov: 48 - pulseAt(S) * 2.5, roll: dir * 0.03 };
}

function chorusUI(u, lt, S, pal, words, fromBar) {
  const word = Math.floor(lt / (2 * BAR));
  const key = KEYS.filter(k => k.bar >= fromBar)[word];
  const txt = key && key.shape.args && key.shape.args.lines ? key.shape.args.lines.join('') : words[word % words.length];
  const wl = lt - word * 2 * BAR;
  const a = 1;
  // giant drifting outline behind everything
  u.outline(txt, DW / 2 + (word % 2 ? -1 : 1) * (wl * 60 - 120), DH / 2, { size: /^[A-Z ]+$/.test(txt) ? 420 : 760, font: /^[A-Z ]+$/.test(txt) ? FONT.orb : FONT.dela, color: pal[word % 2], width: 2.5, alpha: 0.22 * a, rot: -0.06 });
  // downbeat ring bursts
  const bp = fract(S.beat / 4);
  const g = u.g;
  g.save();
  g.globalAlpha = (1 - bp) * 0.6;
  g.strokeStyle = pal[0];
  g.lineWidth = 4 * (1 - bp) + 1;
  g.beginPath();
  g.arc(DW / 2, DH / 2, 120 + ease.outCubic(bp) * 900, 0, Math.PI * 2);
  g.stroke();
  g.restore();
  // marquee bands on alternate 4-bar phrases
  const phrase = Math.floor(lt / (4 * BAR));
  if (phrase % 2 === 0) {
    u.marquee(0, 56, 'GHOST CITY TOKYO ✦ 幽霊東京 ✦ ', S.t, 220, { bg: pal[0], alpha: 0.95, font: FONT.zen });
    u.marquee(DH - 56, 56, '✦ 124BPM ✦ C MINOR ✦ ゴーストシティ ', S.t, -220, { bg: pal[1], alpha: 0.95, font: FONT.zen });
  } else {
    u.stripes(0, 0, DW, 24, pal[1], 0.9, S.t);
    u.stripes(0, DH - 24, DW, 24, pal[0], 0.9, -S.t);
  }
  // word tag
  const tagA = clamp(wl / 0.3);
  u.text(`WORD ${String(word + 1).padStart(2, '0')}`, 120, 170, { size: 16, font: FONT.mono, color: pal[0], alpha: tagA, spacing: 6 });
  u.text(scrambleText(txt, wl * 3, S.t, word), 120, 230, { size: 52, font: FONT.zen, weight: 900, alpha: tagA });
  const st = station(txt);
  if (st) u.text(`${st.en.toUpperCase()} · ${latlng(st.p)}`, 122, 266, { size: 16, font: FONT.mono, color: COL.white, alpha: tagA * 0.7, spacing: 3 });
}

function chorus({ id, from, to, section, palette, stations }) {
  return {
    id, from, to, section,
    bg: (lt, S) => ({ grid: 0.9, speed: 4 + pulseAt(S) * 2, horizon: 0.3, glow: stations ? [0.6, 0.05, 0.35] : [0.1, 0.5, 0.5], gridCol: stations ? [1.0, 0.2, 0.6] : [0.15, 0.85, 1.0], sky: 0.0 }),
    cam: (lt, S) => chorusCam(lt, S),
    post(lt, S) {
      const p = pulseAt(S);
      const word = fract(lt / (2 * BAR));
      return {
        chroma: 0.5 + p * 1.4, bloom: 1.25 + p * 0.2, exposure: 1 + p * 0.12,
        flash: Math.exp(-fract(S.barF) * 7) * 0.22 + Math.exp(-lt * 5) * 0.9,
        flashCol: stations ? [1, 0.3, 0.7] : [0.3, 1, 0.9],
        glitch: word < 0.03 ? 0.7 : word > 0.985 ? 0.4 : 0,
      };
    },
    particles: (lt, S) => ({ turb: 0.015 + pulseAt(S) * 0.1 }),
    hud: () => 0.55,
    ui(u, lt, S) {
      chorusUI(u, lt, S, palette, [], from);
      lyrics(u, S, 'center');
    },
  };
}

// ------------------------------------------------------------------ frame composition
export function sceneAt(t) {
  const bar = t / BAR;
  for (const s of SCENES) if (bar >= s.from && bar < s.to) return s;
  return SCENES[SCENES.length - 1];
}

function particleState(t) {
  let k = 0;
  while (k + 1 < KEYS.length && KEYS[k + 1].t <= t) k++;
  const B = KEYS[k], A = KEYS[Math.max(0, k - 1)];
  const mix = k === 0 ? 1 : clamp((t - B.t) / B.morph);
  return { a: A.shape, b: B.shape, ta: t - A.t, tb: t - B.t, mix, scatter: B.scatter, swirl: B.swirl };
}

export function compose(t, ui, audio, opts = {}) {
  const scene = sceneAt(t);
  const lt = t - scene.from * BAR;
  const beat = t / BEAT;
  const S = {
    t, beat, barF: t / BAR, bar: Math.floor(t / BAR), beatInBar: Math.floor(beat) % 4,
    bands: audio.bands, lyric: audio.lyric, proj: null,
  };
  S.beatInBar = ((S.beatInBar % 4) + 4) % 4;

  // camera
  const cam = scene.cam(lt, S);
  const p = pulseAt(S);
  const shakeK = (scene.id.startsWith('chorus') || (scene.id === 'final' && S.barF >= 96) ? 0.25 : 0.06) * (p + audio.kick * 0.6);
  const eye = v3.add(cam.eye, [noise1(t * 13) * shakeK, noise1(t * 11 + 7) * shakeK, 0]);
  let up = cam.up || [0, 1, 0];
  if (cam.roll) {
    const f = v3.norm(v3.sub(cam.target, eye));
    const r = v3.norm(v3.cross(f, up));
    const u2 = v3.cross(r, f);
    up = v3.add(v3.scale(u2, Math.cos(cam.roll)), v3.scale(r, Math.sin(cam.roll)));
  }
  const fov = (cam.fov * Math.PI) / 180;
  const aspect = DW / DH;
  const vp = mat4.mul(mat4.perspective(fov, aspect, 0.1, 3000), mat4.lookAt(eye, cam.target, up));
  S.proj = q => project(vp, q, DW, DH);

  const ps = particleState(t);
  const pp = scene.particles ? scene.particles(lt, S) : {};
  const bg = { ...DEFAULT_BG, ...(scene.bg ? scene.bg(lt, S) : {}) };
  const post = { ...DEFAULT_POST, ...(scene.post ? scene.post(lt, S) : {}) };

  // ---- overlay
  ui.begin();
  const cut = activeCutin(t);
  if (cut) {
    ui.cutin(cut.text, { bg: cut.bg, fg: cut.fg, font: cut.font, t: cut.lt, alpha: 1 - clamp((cut.lt - 0.8) / 0.12) });
    post.chroma = 0.4 + 1.6 * (1 - cut.lt);
    post.glitch = cut.lt < 0.1 ? 0.5 : 0;
    post.uiGlow = 0.25;
    post.bloom = 0.3;
    post.flash = 0;
    post.invert = 0;
  } else {
    scene.ui(ui, lt, S);
    hud(ui, S, scene.hud ? scene.hud(S) : 0.8, scene.section);
  }
  const gm = opts.grain ?? 1;
  post.grain *= gm;
  bg.haze = gm;
  // global fade-in at the very start
  post.exposure *= smooth(0, 0.6, t) || 0;

  return {
    time: t,
    beat: Math.max(p * (scene.id === 'bridge' ? 0.3 : 1), audio.kick),
    vp, cam: eye, pointScale: ui.canvas.height / (2 * Math.tan(fov / 2)),
    bg, post,
    lines: scene.lines ? scene.lines(lt, S).map(l => ({ ...l, alpha: l.alpha * (cut ? 0.3 : 1) })) : [],
    particles: { ...ps, alpha: pp.alpha ?? 1, turb: pp.turb ?? 0.02, size: pp.size ?? 1 },
    scene: scene.id,
  };
}

export { SCENES, KEYS };
