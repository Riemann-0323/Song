// Audio: the user's own song file (synced through an offset), or a built-in original
// 124 BPM C-minor demo beat synthesised with WebAudio so the PV is never silent.
// The demo is NOT the song — it only shares tempo and key so the visuals lock to it.
import { BPM, BEAT, BAR, TOTAL_BARS } from './timeline.js';
import { clamp } from './math.js';

// ------------------------------------------------------------------ arrangement
const PROG_VERSE = [[36, [60, 63, 67]], [32, [60, 63, 68]], [39, [63, 67, 70]], [34, [62, 65, 70]]]; // Cm Ab Eb Bb
const PROG_CHORUS = [[32, [60, 63, 68]], [34, [62, 65, 70]], [31, [62, 67, 70]], [36, [60, 63, 67]]]; // Ab Bb Gm Cm (王道進行)
const LEAD = [
  [75, 72, 75, 77, 79, 0, 77, 75],
  [74, 0, 70, 72, 74, 77, 0, 74],
  [74, 70, 67, 70, 74, 0, 72, 70],
  [72, 0, 67, 0, 75, 74, 72, 0],
];

function section(bar) {
  if (bar < 2) return { name: 'boot', pad: 0.5 };
  if (bar < 8) return { name: 'intro', pad: 0.8, hat: bar >= 4 ? 8 : 0, kick: bar >= 4 ? 'half' : '', arp: bar >= 6 ? 0.6 : 0, riser: bar === 7, chorusChords: false };
  if (bar < 24) return { name: 'verse', pad: 0.5, hat: 8, kick: 'verse', snare: true, bass: 0.8, arp: bar >= 16 ? 0.5 : 0.3 };
  if (bar < 32) return { name: 'pre', pad: 0.6, hat: 16, kick: 'four', snare: true, bass: 0.9, arp: 0.7, riser: bar >= 30, roll: bar === 31 };
  if (bar < 48) return { name: 'chorus', chorus: true, hat: 16, kick: 'four', clap: true, bass: 1, arp: 0.8, stab: 1, lead: 1, impact: bar === 32 };
  if (bar < 52) return { name: 'tower', pad: 0.9, arp: 0.6, kick: 'half', hat: 8, impact: bar === 48 };
  if (bar < 64) return { name: 'verse', pad: 0.5, hat: 8, kick: 'verse', snare: true, bass: 0.8, arp: 0.5 };
  if (bar < 70) return { name: 'glyph', hat: 16, kick: 'break', snare: true, bass: 0.9, arp: 0.7, riser: bar >= 68, roll: bar === 69 };
  if (bar < 84) return { name: 'chorus', chorus: true, hat: 16, kick: 'four', clap: true, bass: 1, arp: 0.8, stab: 1, lead: 1, impact: bar === 70 };
  if (bar < 90) return { name: 'bridge', pad: 1, arp: 0.35 };
  if (bar < 91) return { name: 'lost', drone: true };
  if (bar < 92) return { name: 'restart', roll: true, riser: true };
  if (bar < 96) return { name: 'fly', chorus: true, hat: 16, kick: 'four', clap: true, bass: 1, arp: 0.9, stab: 0.8, impact: bar === 92 };
  if (bar < 102) return { name: 'final', chorus: true, hat: 16, kick: 'four', clap: true, bass: 1, arp: 0.9, stab: 1, lead: 1, roll: bar === 101 };
  return { name: 'outro', pad: 1 - (bar - 102) / 6, arp: bar < 105 ? 0.4 : 0, impact: bar === 102 };
}

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function noiseBuffer(ctx) {
  if (ctx.__noise) return ctx.__noise;
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  ctx.__noise = b;
  return b;
}

function env(g, t, a, peak, d, end = 0.0001) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(end, t + a + d);
}

// builds the shared mix bus; returns { input, fx: {delay, verb} }
export function buildBus(ctx, out) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  comp.connect(master).connect(out);

  const input = ctx.createGain();
  input.connect(comp);

  const delay = ctx.createDelay(2);
  delay.delayTime.value = BEAT * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass';
  dlp.frequency.value = 3200;
  delay.connect(dlp).connect(fb).connect(delay);
  dlp.connect(comp);

  const verb = ctx.createConvolver();
  const len = ctx.sampleRate * 2.6;
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let s = 777 + c;
    for (let i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = ((s / 0x7fffffff) * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
  }
  verb.buffer = ir;
  const vg = ctx.createGain();
  vg.gain.value = 0.32;
  verb.connect(vg).connect(comp);
  return { input, delay, verb };
}

class Voice {
  constructor(ctx, bus) {
    this.ctx = ctx;
    this.bus = bus;
    this.noise = noiseBuffer(ctx);
  }
  kick(t, v = 1) {
    const { ctx } = this;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    env(g, t, 0.003, 0.95 * v, 0.42);
    o.connect(g).connect(this.bus.input);
    o.start(t);
    o.stop(t + 0.5);
  }
  noiseHit(t, type, f, q, a, peak, d, send = 0) {
    const { ctx } = this;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    fl.Q.value = q;
    const g = ctx.createGain();
    env(g, t, a, peak, d);
    s.connect(fl).connect(g).connect(this.bus.input);
    if (send) {
      const sg = ctx.createGain();
      sg.gain.value = send;
      g.connect(sg).connect(this.bus.verb);
    }
    s.start(t, Math.random() * 1.5);
    s.stop(t + a + d + 0.05);
  }
  snare(t, v = 1) {
    this.noiseHit(t, 'bandpass', 1900, 0.7, 0.002, 0.5 * v, 0.2, 0.25);
    const { ctx } = this;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    env(g, t, 0.002, 0.35 * v, 0.1);
    o.connect(g).connect(this.bus.input);
    o.start(t);
    o.stop(t + 0.15);
  }
  clap(t) {
    for (let i = 0; i < 3; i++) this.noiseHit(t + i * 0.011, 'bandpass', 1300, 1.2, 0.001, 0.4, i === 2 ? 0.18 : 0.02, i === 2 ? 0.35 : 0);
  }
  hat(t, open = false, v = 1) {
    this.noiseHit(t, 'highpass', 7800, 0.5, 0.001, 0.16 * v, open ? 0.22 : 0.045);
  }
  bass(t, m, dur, v = 1) {
    const { ctx } = this;
    const g = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(220, t + dur);
    for (const [type, det, k] of [['sawtooth', 0, 0.5], ['square', -1200, 0.4]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(m);
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = k;
      o.connect(og).connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    env(g, t, 0.005, 0.42 * v, dur);
    f.connect(g).connect(this.bus.input);
  }
  pluck(t, m, v = 1, dur = 0.22) {
    const { ctx } = this;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(5200, t);
    f.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ctx.createGain();
    env(g, t, 0.003, 0.12 * v, dur);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    f.connect(g).connect(this.bus.input);
    const dg = ctx.createGain();
    dg.gain.value = 0.35;
    g.connect(dg).connect(this.bus.delay);
  }
  stab(t, notes, dur, v = 1) {
    const { ctx } = this;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(4200, t);
    f.frequency.exponentialRampToValueAtTime(1200, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07 * v, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const m of notes)
      for (const det of [-14, -5, 5, 14]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m + 12);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    f.connect(g).connect(this.bus.input);
    const vg = ctx.createGain();
    vg.gain.value = 0.4;
    g.connect(vg).connect(this.bus.verb);
  }
  pad(t, notes, dur, v = 1) {
    const { ctx } = this;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05 * v, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.3);
    for (const m of notes)
      for (const [type, det] of [['triangle', -6], ['sawtooth', 7]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = mtof(m);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.4);
      }
    f.connect(g).connect(this.bus.input);
    const vg = ctx.createGain();
    vg.gain.value = 0.8;
    g.connect(vg).connect(this.bus.verb);
  }
  lead(t, m, dur, v = 1) {
    const { ctx } = this;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * v, t + 0.012);
    g.gain.setValueAtTime(0.09 * v, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 5.5;
    lg.gain.value = 12;
    lfo.connect(lg);
    for (const [type, det] of [['square', -4], ['sawtooth', 4]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(m);
      o.detune.value = det;
      lg.connect(o.detune);
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
    f.connect(g).connect(this.bus.input);
    const dg = ctx.createGain();
    dg.gain.value = 0.45;
    g.connect(dg).connect(this.bus.delay);
  }
  riser(t, dur) {
    const { ctx } = this;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    s.connect(f).connect(g).connect(this.bus.input);
    s.start(t);
    s.stop(t + dur + 0.1);
  }
  impact(t) {
    const { ctx } = this;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 1.2);
    env(g, t, 0.004, 0.8, 1.8);
    o.connect(g).connect(this.bus.input);
    o.start(t);
    o.stop(t + 2);
    this.noiseHit(t, 'lowpass', 2500, 0.5, 0.002, 0.5, 1.4, 0.8);
  }
  drone(t, dur) {
    const { ctx } = this;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = mtof(36);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.bus.input);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

// schedule every note whose song-time lies in [from, to); ctxZero = context time of song t=0
export function scheduleDemo(voice, from, to, ctxZero) {
  const b0 = Math.max(0, Math.floor(from / BAR)), b1 = Math.min(TOTAL_BARS, Math.ceil(to / BAR));
  const at = st => ctxZero + st;
  const inRange = st => st >= from && st < to;
  for (let bar = b0; bar < b1; bar++) {
    const S = section(bar);
    const tb = bar * BAR;
    const prog = S.chorus ? PROG_CHORUS : PROG_VERSE;
    const [root, chord] = prog[bar % 4];
    const ev = (st, fn) => { if (inRange(st)) fn(at(st)); };

    if (S.impact) ev(tb, t => voice.impact(t));
    if (S.drone) ev(tb, t => voice.drone(t, BAR));
    if (S.pad) ev(tb, t => voice.pad(t, chord, BAR, S.pad));
    if (S.riser) ev(tb, t => voice.riser(t, BAR));
    for (let s = 0; s < 16; s++) {
      const st = tb + s * (BEAT / 4);
      if (!inRange(st)) continue;
      const t = at(st);
      const beat = s / 4;
      // drums
      const kickHit =
        (S.kick === 'four' && s % 4 === 0) ||
        (S.kick === 'half' && (s === 0 || s === 8)) ||
        (S.kick === 'verse' && (s === 0 || s === 6 || s === 8 || s === 11)) ||
        (S.kick === 'break' && (s === 0 || s === 3 || s === 10));
      if (kickHit) voice.kick(t);
      if ((S.snare || S.clap) && (s === 4 || s === 12)) S.clap ? voice.clap(t) : voice.snare(t);
      if (S.roll && s >= 8) voice.snare(t, 0.3 + (s - 8) / 10);
      if (S.hat === 16) voice.hat(t, s % 8 === 6, s % 2 ? 0.55 : 1);
      else if (S.hat === 8 && s % 2 === 0) voice.hat(t, s % 8 === 4, s % 4 ? 0.6 : 1);
      // bass: off-beat pumping 8ths
      if (S.bass && s % 2 === 0) voice.bass(t, root + (s % 8 === 6 ? 12 : 0), BEAT / 2 - 0.02, S.bass * (s % 4 === 0 ? 0.7 : 1));
      // arpeggio
      if (S.arp && s % 2 === 0) {
        const notes = [...chord, chord[0] + 12, chord[1] + 12, chord[2], chord[1], chord[0] + 12];
        voice.pluck(t, notes[(s / 2) % notes.length] + 12, S.arp);
      }
      if (S.stab && s % 4 === 0) voice.stab(t, chord, BEAT * 0.92, S.stab);
      if (S.lead && s % 2 === 0) {
        const m = LEAD[bar % 4][s / 2];
        if (m) voice.lead(t, m, BEAT / 2 * (LEAD[bar % 4][s / 2 + 1] === 0 ? 1.9 : 0.95), S.lead);
      }
      void beat;
    }
  }
}

// ------------------------------------------------------------------ LRC lyrics
export function parseLRC(text) {
  const out = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const txt = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]) - offset, text: txt });
  }
  out.sort((a, b) => a.t - b.t);
  out.forEach((l, i) => (l.end = i + 1 < out.length ? out[i + 1].t : l.t + 6));
  return out.filter(l => l.text);
}

export function lyricAt(lines, t) {
  if (!lines || !lines.length) return null;
  let lo = 0, hi = lines.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  if (best < 0) return null;
  const l = lines[best];
  return t < l.end ? l : null;
}

// ------------------------------------------------------------------ engine
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mode = 'none'; // none | demo | file
    this.playing = false;
    this.offset = 0; // visual time = audio time + offset
    this.songPos = 0;
    this.clockStart = 0;
    this.bands = new Array(24).fill(0);
    this.kick = 0;
    this._bassAvg = 0;
    this.lyrics = null;
    this.el = null;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.out = ctx.createGain();
    this.out.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recDest);
    return ctx;
  }

  async loadFile(file) {
    this.ensure();
    this.stop();
    if (this.el) URL.revokeObjectURL(this.el.src);
    const el = new Audio();
    el.src = typeof file === 'string' ? file : URL.createObjectURL(file);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    await new Promise((res, rej) => {
      el.addEventListener('loadedmetadata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('could not load audio')), { once: true });
    });
    if (!this.elSource || this.elSource.mediaElement !== el) {
      this.elSource = this.ctx.createMediaElementSource(el);
      this.elSource.connect(this.out);
    }
    this.el = el;
    this.mode = 'file';
    return el.duration;
  }

  useDemo() {
    this.stop();
    this.mode = 'demo';
  }

  time() {
    if (this.mode === 'file' && this.el) return this.el.currentTime + this.offset;
    if (this.playing && this.ctx) return this.ctx.currentTime - this.clockStart;
    return this.songPos;
  }

  async play(from = this.time()) {
    const ctx = this.ensure();
    if (ctx.state !== 'running') await ctx.resume();
    this.stop();
    this.playing = true;
    if (this.mode === 'file' && this.el) {
      this.el.currentTime = Math.max(0, from - this.offset);
      await this.el.play();
      return;
    }
    this.clockStart = ctx.currentTime - from + 0.05;
    if (this.mode === 'demo') {
      this.session = ctx.createGain();
      this.session.connect(this.out);
      const bus = buildBus(ctx, this.session);
      this.voice = new Voice(ctx, bus);
      this.scheduledTo = from;
      const tick = () => {
        if (!this.playing) return;
        const now = ctx.currentTime - this.clockStart;
        const until = now + 0.35;
        if (until > this.scheduledTo) {
          scheduleDemo(this.voice, this.scheduledTo, until, this.clockStart);
          this.scheduledTo = until;
        }
      };
      tick();
      this.timer = setInterval(tick, 60);
    }
  }

  stop() {
    if (!this.playing) return;
    this.songPos = this.time();
    this.playing = false;
    clearInterval(this.timer);
    if (this.session) {
      const s = this.session;
      s.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      setTimeout(() => s.disconnect(), 300);
      this.session = null;
    }
    if (this.el) this.el.pause();
  }

  seek(t) {
    const was = this.playing;
    this.stop();
    this.songPos = t;
    if (this.mode === 'file' && this.el) this.el.currentTime = Math.max(0, t - this.offset);
    if (was) this.play(t);
  }

  // per-frame analysis; synthetic bands when nothing is audible (offline render, silent mode)
  analyse(t, pulse) {
    if (this.ctx && this.playing && this.mode !== 'none') {
      this.analyser.getByteFrequencyData(this.freq);
      const n = this.bands.length, F = this.freq, bins = F.length;
      for (let i = 0; i < n; i++) {
        const a = Math.floor(Math.pow(i / n, 2) * bins * 0.5) + 1, b = Math.floor(Math.pow((i + 1) / n, 2) * bins * 0.5) + 2;
        let s = 0;
        for (let k = a; k < b; k++) s += F[k];
        this.bands[i] = Math.pow(s / (b - a) / 255, 1.4) * 1.2;
      }
      const bass = (F[2] + F[3] + F[4] + F[5]) / (4 * 255);
      this._bassAvg += (bass - this._bassAvg) * 0.05;
      this.kick = Math.max(this.kick * 0.86, clamp((bass - this._bassAvg) * 5));
    } else {
      for (let i = 0; i < this.bands.length; i++) {
        const k = i / this.bands.length;
        this.bands[i] = clamp(0.15 + pulse * (0.85 - k * 0.6) * (0.6 + 0.4 * Math.sin(t * 7 + i * 1.7)) + 0.08 * Math.sin(t * 3.1 + i));
      }
      this.kick = 0;
    }
    return { bands: this.bands, kick: this.kick, lyric: lyricAt(this.lyrics, t - this.offset) };
  }
}

// offline render of the demo beat → 16-bit WAV bytes (used by tools/render.mjs)
export async function renderDemoWav(from, to, sampleRate = 48000) {
  const len = Math.ceil((to - from) * sampleRate);
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const bus = buildBus(ctx, ctx.destination);
  const voice = new Voice(ctx, bus);
  scheduleDemo(voice, from, to, -from);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const bytes = new ArrayBuffer(44 + len * 4);
  const v = new DataView(bytes);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + len * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len * 4, true);
  for (let i = 0; i < len; i++) {
    v.setInt16(44 + i * 4, clamp(L[i], -1, 1) * 32767, true);
    v.setInt16(46 + i * 4, clamp(R[i], -1, 1) * 32767, true);
  }
  return new Uint8Array(bytes);
}

export { BPM };
