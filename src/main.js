import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { compose, DURATION, BAR, BEAT, PRELOAD, KEYS } from './timeline.js';
import { AudioEngine, parseLRC, renderDemoWav } from './audio.js';
import { loadFonts } from './fonts.js';
import { fract } from './math.js';

const Q = new URLSearchParams(location.search);
const RENDER = Q.has('render');
const OPTS = { grain: Q.has('grain') ? +Q.get('grain') : 1 };
const $ = s => document.querySelector(s);

const canvas = $('#pv');
const renderer = new Renderer(canvas, { particles: +Q.get('n') || 131072, preserve: RENDER });
const ui = new UI(16, 9);
const audio = new AudioEngine();
audio.offset = +Q.get('offset') || 0;

let scale = +Q.get('q') || 1;
let fixedW = +Q.get('w') || 0, fixedH = +Q.get('h') || 0;

function sizeFor() {
  if (fixedW && fixedH) return [fixedW, fixedH];
  const box = $('#stage').getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(box.width * dpr * scale), h = Math.round((w * 9) / 16);
  if (w > 1920 * scale) { w = Math.round(1920 * scale); h = Math.round((w * 9) / 16); }
  return [Math.max(320, w), Math.max(180, h)];
}

function frame(t) {
  const [w, h] = sizeFor();
  renderer.resize(w, h);
  ui.resize(w, h);
  const pulse = Math.exp(-fract(t / BEAT) * 5);
  const a = audio.analyse(t, pulse);
  const F = compose(t, ui, a, OPTS);
  renderer.render(F, ui.canvas);
  return F;
}

// shapes for the next keyframe are built a little ahead of time so morphs never hitch
function prefetch(t) {
  for (const k of KEYS) if (k.t > t && k.t - t < BAR * 1.5) renderer.shape(k.shape);
}

// ------------------------------------------------------------------ offline render API
window.PV = {
  duration: DURATION,
  ready: null,
  renderAt(t) {
    prefetch(t);
    return frame(t).scene;
  },
  grab(q = 0.92) {
    return canvas.toDataURL('image/jpeg', q);
  },
  async demoWav(from = 0, to = DURATION) {
    const bytes = await renderDemoWav(from, to);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
};

async function boot() {
  await loadFonts();
  if (RENDER) {
    document.body.classList.add('render');
    // build every formation once up front so frame timing is uniform
    for (const s of PRELOAD) renderer.shape(s);
    return;
  }
  setupControls();
  let last = performance.now(), frames = 0, acc = 0;
  const loop = now => {
    const t = Math.min(audio.time(), DURATION);
    prefetch(t);
    frame(t);
    updateControls(t);
    if (audio.playing && t >= DURATION - 0.01 && audio.mode !== 'file') audio.stop();
    // adaptive resolution
    frames++;
    acc += now - last;
    last = now;
    if (acc > 2000) {
      const fps = (frames * 1000) / acc;
      if (fps < 38 && scale > 0.5 && !Q.get('q')) scale = Math.max(0.5, scale * 0.85);
      else if (fps > 57 && scale < 1 && !Q.get('q')) scale = Math.min(1, scale * 1.08);
      $('#fps').textContent = `${fps.toFixed(0)} fps · ${canvas.width}×${canvas.height}`;
      frames = 0;
      acc = 0;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
window.PV.ready = boot();

// ------------------------------------------------------------------ controls
let recorder = null;

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateControls(t) {
  const seek = $('#seek');
  if (!seek.matches(':active')) seek.value = String((t / DURATION) * 1000);
  $('#time').textContent = `${fmt(t)} / ${fmt(DURATION)}`;
  $('#play').textContent = audio.playing ? '❚❚' : '▶';
}

function setupControls() {
  const start = async mode => {
    $('#gate').classList.add('hidden');
    if (mode === 'demo') audio.useDemo();
    await audio.play(audio.time());
  };
  $('#gate-demo').onclick = () => start('demo');
  $('#gate-silent').onclick = () => { audio.mode = 'none'; start('none'); };
  $('#gate-file').onclick = () => $('#file').click();
  $('#play').onclick = () => (audio.playing ? audio.stop() : audio.play());
  $('#seek').oninput = e => audio.seek((e.target.value / 1000) * DURATION);
  $('#load').onclick = () => $('#file').click();
  $('#lrc').onclick = () => $('#lrcfile').click();
  $('#demo').onclick = async () => { audio.useDemo(); await audio.play(audio.time()); toast('Demo beat (original, 124 BPM C minor)'); };
  $('#offset').value = String(audio.offset);
  $('#offset').onchange = e => {
    const t = audio.time();
    audio.offset = parseFloat(e.target.value) || 0;
    audio.seek(t);
  };
  $('#file').onchange = e => e.target.files[0] && loadAudio(e.target.files[0]);
  $('#lrcfile').onchange = e => e.target.files[0] && loadLyrics(e.target.files[0]);
  $('#full').onclick = () => ($('#stage').requestFullscreen ? $('#stage').requestFullscreen() : null);
  $('#rec').onclick = toggleRecord;
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); audio.playing ? audio.stop() : audio.play(); }
    if (e.code === 'ArrowRight') audio.seek(audio.time() + BAR * 2);
    if (e.code === 'ArrowLeft') audio.seek(Math.max(0, audio.time() - BAR * 2));
    if (e.code === 'KeyF') $('#full').click();
    if (e.code === 'KeyH') document.body.classList.toggle('clean');
  });
  document.body.addEventListener('dragover', e => e.preventDefault());
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      if (/\.(lrc|txt)$/i.test(f.name)) loadLyrics(f);
      else loadAudio(f);
    }
  });
  if (Q.get('audio')) loadAudio(Q.get('audio'), true);
  if (Q.get('lrc')) fetch(Q.get('lrc')).then(r => r.text()).then(txt => (audio.lyrics = parseLRC(txt)));
  if (Q.get('t')) audio.seek(+Q.get('t'));
}

async function loadAudio(file, quiet) {
  try {
    const d = await audio.loadFile(file);
    $('#gate').classList.add('hidden');
    toast(`Loaded ${file.name || file} · ${fmt(d)} · offset ${audio.offset}s`);
    await audio.play(0 + audio.offset);
  } catch (err) {
    if (!quiet) toast('Could not load audio: ' + err.message);
  }
}

async function loadLyrics(file) {
  audio.lyrics = parseLRC(await file.text());
  toast(`Lyrics: ${audio.lyrics.length} lines`);
}

function toggleRecord() {
  if (recorder) {
    recorder.stop();
    return;
  }
  audio.ensure();
  const stream = canvas.captureStream(60);
  for (const tr of audio.recDest.stream.getAudioTracks()) stream.addTrack(tr);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
  const chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    a.download = 'ghost-city-tokyo-pv.webm';
    a.click();
    recorder = null;
    $('#rec').classList.remove('on');
    toast('Recording saved');
  };
  recorder.start(500);
  $('#rec').classList.add('on');
  audio.seek(0);
  if (!audio.playing) audio.play(0);
  toast('Recording from 0:00 — press REC again to stop');
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
