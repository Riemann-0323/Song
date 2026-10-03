// 2D overlay: HUD, kinetic typography, cut-ins, station labels, lyrics.
// Everything is drawn in a 1920×1080 design space and uploaded as a texture so it
// goes through the same bloom / chromatic / glitch post chain as the 3D layer.
import { FONT } from './fonts.js';
import { clamp, ease, hash1, fract } from './math.js';

export const DW = 1920, DH = 1080;
const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン#%&@$01';

export const COL = {
  teal: '#39ffe0',
  miku: '#39c5bb',
  pink: '#ff2a9d',
  violet: '#8a5cff',
  yellow: '#ffe600',
  white: '#ffffff',
  ink: '#07040f',
};

export function scrambleText(text, p, t, seed = 0) {
  const chars = [...text];
  const n = chars.length;
  const shown = Math.floor(clamp(p) * (n + 0.999));
  const tick = Math.floor(t * 24);
  return chars
    .map((ch, i) => (i < shown || ch === ' ' ? ch : GLYPHS[Math.floor(hash1(i * 13 + tick * 7 + seed) * GLYPHS.length)]))
    .join('');
}

export class UI {
  constructor(w, h) {
    this.canvas = document.createElement('canvas');
    this.g = this.canvas.getContext('2d');
    this.resize(w, h);
  }
  resize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }
  begin() {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // fit 16:9 design space into the canvas (cover)
    const s = Math.max(this.canvas.width / DW, this.canvas.height / DH);
    g.setTransform(s, 0, 0, s, (this.canvas.width - DW * s) / 2, (this.canvas.height - DH * s) / 2);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'miter';
    return g;
  }

  text(str, x, y, { size = 32, font = FONT.mono, color = COL.white, align = 'left', base = 'alphabetic', alpha = 1, weight = 400, stroke = 0, strokeColor = COL.ink, spacing = 0 } = {}) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.font = `${weight} ${size}px ${font}`;
    g.textAlign = align;
    g.textBaseline = base;
    if (spacing) g.letterSpacing = `${spacing}px`;
    if (stroke) {
      g.lineWidth = stroke;
      g.strokeStyle = strokeColor;
      g.strokeText(str, x, y);
    }
    g.fillStyle = color;
    g.fillText(str, x, y);
    g.restore();
  }

  vtext(str, x, y, opts = {}) {
    const size = opts.size || 32;
    [...str].forEach((ch, i) => this.text(ch, x, y + i * size * (opts.gap || 1.05), { ...opts, align: 'center', base: 'top' }));
  }

  // giant outlined text for backgrounds
  outline(str, x, y, { size = 400, font = FONT.dela, color = COL.teal, width = 3, alpha = 1, align = 'center', rot = 0 } = {}) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.translate(x, y);
    g.rotate(rot);
    g.font = `400 ${size}px ${font}`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.lineWidth = width;
    g.strokeStyle = color;
    g.strokeText(str, 0, 0);
    g.restore();
  }

  brackets(x, y, w, h, len = 24, color = COL.teal, lw = 2, alpha = 1) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(x, y + len); g.lineTo(x, y); g.lineTo(x + len, y);
    g.moveTo(x + w - len, y); g.lineTo(x + w, y); g.lineTo(x + w, y + len);
    g.moveTo(x + w, y + h - len); g.lineTo(x + w, y + h); g.lineTo(x + w - len, y + h);
    g.moveTo(x + len, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - len);
    g.stroke();
    g.restore();
  }

  stripes(x, y, w, h, color = COL.yellow, alpha = 1, phase = 0, gap = 36) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = color;
    const off = fract(phase) * gap;
    for (let sx = x - h - gap + off; sx < x + w + h; sx += gap) {
      g.beginPath();
      g.moveTo(sx, y + h); g.lineTo(sx + h, y); g.lineTo(sx + h + gap / 2, y); g.lineTo(sx + gap / 2, y + h);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  rect(x, y, w, h, color, alpha = 1) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
    g.restore();
  }

  line(x0, y0, x1, y1, color = COL.teal, lw = 1.5, alpha = 1) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.restore();
  }

  barcode(x, y, w, h, seed, color = COL.white, alpha = 0.8) {
    let cx = x;
    let i = 0;
    while (cx < x + w) {
      const bw = 1 + Math.floor(hash1(seed + i * 3.1) * 4);
      if (hash1(seed + i * 7.7) > 0.4) this.rect(cx, y, bw, h, color, alpha);
      cx += bw + 1 + Math.floor(hash1(seed + i) * 3);
      i++;
    }
  }

  // marquee band of repeating text
  marquee(y, h, str, t, speed, { bg = COL.teal, fg = COL.ink, size, font = FONT.orb, alpha = 1, rot = 0 } = {}) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.translate(DW / 2, y + h / 2);
    g.rotate(rot);
    g.fillStyle = bg;
    g.fillRect(-DW, -h / 2, DW * 2, h);
    g.font = `900 ${size || h * 0.62}px ${font}`;
    g.textBaseline = 'middle';
    g.fillStyle = fg;
    const unit = g.measureText(str + '   ').width;
    let x = -DW - fract((t * speed) / unit) * unit;
    while (x < DW) {
      g.fillText(str, x, 2);
      x += unit;
    }
    g.restore();
  }

  // station / landmark callout pinned to a projected 3D point
  callout(sx, sy, ja, en, { color = COL.teal, alpha = 1, side = 1, dy = -70, p = 1, sub } = {}) {
    if (alpha <= 0.01) return;
    const g = this.g;
    const ex = sx + side * 60, ey = sy + dy;
    const k = ease.outCubic(clamp(p));
    g.save();
    g.globalAlpha *= alpha;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(sx, sy, 6 + (1 - k) * 20, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + (ex - sx) * k, sy + (ey - sy) * k);
    g.lineTo(ex + side * 140 * k, ey);
    g.stroke();
    g.restore();
    const tx = ex + (side > 0 ? 4 : -4);
    const al = side > 0 ? 'left' : 'right';
    this.text(scrambleText(ja, p * 1.4, p * 3 + sx, sx), tx, ey - 10, { size: 34, font: FONT.zen, weight: 900, color: COL.white, align: al, alpha: alpha * k });
    this.text(en.toUpperCase(), tx, ey + 22, { size: 15, font: FONT.mono, color, align: al, alpha: alpha * k, spacing: 3 });
    if (sub) this.text(sub, tx, ey + 42, { size: 13, font: FONT.mono, color: COL.white, align: al, alpha: alpha * k * 0.6 });
  }

  // full-frame colour block with a giant glyph: the classic one-beat PV cut-in
  cutin(str, { bg = COL.teal, fg = COL.ink, font = FONT.dela, size = 640, t = 0, alpha = 1, sub, vertical = false, rot = -0.04 } = {}) {
    const g = this.g;
    g.save();
    g.globalAlpha *= alpha;
    g.fillStyle = bg;
    g.fillRect(-20, -20, DW + 40, DH + 40);
    this.stripes(0, 0, DW, 70, fg, 0.9, t * 2, 40);
    this.stripes(0, DH - 70, DW, 70, fg, 0.9, -t * 2, 40);
    g.translate(DW / 2, DH / 2);
    g.rotate(rot);
    const s = 1 + (1 - ease.outExpo(clamp(t * 4))) * 0.25;
    g.scale(s, s);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (vertical) {
      const chars = [...str];
      g.font = `400 ${size / Math.max(1, chars.length * 0.8)}px ${font}`;
      const sz = size / Math.max(1, chars.length * 0.8);
      chars.forEach((ch, i) => g.fillText(ch, 0, (i - (chars.length - 1) / 2) * sz));
    } else {
      g.font = `400 ${size}px ${font}`;
      const w = g.measureText(str).width;
      if (w > DW * 0.92) g.font = `400 ${(size * DW * 0.92) / w}px ${font}`;
      g.fillText(str, 0, 20);
    }
    g.restore();
    if (sub) this.text(sub, DW - 90, DH - 100, { size: 28, font: FONT.orb, weight: 900, color: fg, align: 'right', spacing: 8, alpha });
  }

  spectrum(x, y, w, h, bands, color = COL.teal, alpha = 0.8) {
    const n = bands.length;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = clamp(bands[i]);
      this.rect(x + i * bw, y + h - v * h, bw - 2, v * h, i % 4 === 0 ? COL.pink : color, alpha);
    }
  }
}
