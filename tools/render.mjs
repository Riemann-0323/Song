// Offline, frame-exact renderer: drives the PV in headless Chromium and pipes frames to ffmpeg.
//
//   node tools/render.mjs                                   # full PV, 1280x720@30, demo beat
//   node tools/render.mjs --width 1920 --height 1080 --fps 60 --audio song.mp3 --offset 0
//   node tools/render.mjs --from 60 --to 75 --out renders/chorus.mp4
//   node tools/render.mjs --stills 5,20,64 --out renders/stills
//
// Options: --workers N (parallel browsers, default 3) · --grain 0.4 (film grain amount,
// lower = smaller files) · --crf 22 · --particles 131072 · --mute
// --audio muxes your own song file (visual time = audio time + offset); without it the
// original demo beat is rendered offline in the page and muxed instead.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
});
const W = +args.width || 1280, H = +args.height || 720, FPS = +args.fps || 30;
const N = +args.particles || 131072;
const GRAIN = args.grain != null ? +args.grain : 0.5;
const WORKERS = +args.workers || 3;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const g = execSync('npm root -g').toString().trim();
    return await import(pathToFileURL(path.join(g, 'playwright', 'index.mjs')).href);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.lrc': 'text/plain' };
function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const srv = await serve();
const port = srv.address().port;
const { chromium } = await loadPlaywright();

async function openPV() {
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', m => m.type() === 'error' && !/ERR_CERT|Failed to load resource/.test(m.text()) && console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?render=1&w=${W}&h=${H}&n=${N}&grain=${GRAIN}`);
  await page.waitForFunction(() => window.PV && window.PV.ready);
  await page.evaluate(() => window.PV.ready);
  const grab = async (t, q = 0.92) => {
    const url = await page.evaluate(([tt, qq]) => (window.PV.renderAt(tt), window.PV.grab(qq)), [t, q]);
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  };
  return { browser, page, grab };
}

function encoder(out, audioIn = []) {
  return spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    ...audioIn,
    '-map', '0:v', ...(audioIn.length ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(args.crf || 22), '-maxrate', String(args.maxrate || '6M'), '-bufsize', '12M',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
}

const progress = new Map();
let lastLog = 0;
function report(id, i, total, t0) {
  progress.set(id, [i, total]);
  const now = Date.now();
  if (now - lastLog < 2000) return;
  lastLog = now;
  let done = 0, all = 0;
  for (const [d, a] of progress.values()) { done += d; all += a; }
  const el = (now - t0) / 1000;
  process.stdout.write(`\rframes ${done}/${all}  ${(done / el).toFixed(1)} fps  eta ${(((all - done) * el) / Math.max(done, 1) / 60).toFixed(1)} min   `);
}

async function renderSegment(id, f0, f1, out, t0) {
  const pv = await openPV();
  const ff = encoder(out);
  for (let f = f0; f < f1; f++) {
    const buf = await pv.grab(f / FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    report(id, f - f0 + 1, f1 - f0, t0);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await pv.browser.close();
}

if (args.stills) {
  const pv = await openPV();
  const out = path.resolve(ROOT, args.out || 'renders/stills');
  fs.mkdirSync(out, { recursive: true });
  for (const s of String(args.stills).split(',')) {
    const t = parseFloat(s);
    const f = path.join(out, `t${t.toFixed(2).padStart(7, '0')}.jpg`);
    fs.writeFileSync(f, await pv.grab(t, 0.95));
    console.log('wrote', path.relative(ROOT, f));
  }
  await pv.browser.close();
} else {
  const probe = await openPV();
  const DURATION = await probe.page.evaluate(() => window.PV.duration);
  const from = +args.from || 0, to = Math.min(+args.to || DURATION, DURATION);
  const out = path.resolve(ROOT, args.out || 'renders/ghost-city-tokyo-pv.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));

  let audioIn = [];
  if (args.audio) {
    audioIn = ['-ss', String(Math.max(0, from - (+args.offset || 0))), '-i', path.resolve(args.audio)];
  } else if (!args.mute) {
    console.log('rendering demo beat…');
    const b64 = await probe.page.evaluate(([a, b]) => window.PV.demoWav(a, b), [from, to]);
    const wav = path.join(tmp, 'demo.wav');
    fs.writeFileSync(wav, Buffer.from(b64, 'base64'));
    audioIn = ['-i', wav];
  }
  await probe.browser.close();

  const F0 = Math.round(from * FPS), F1 = Math.round(to * FPS);
  const k = Math.max(1, Math.min(WORKERS, Math.ceil((F1 - F0) / FPS)));
  const per = Math.ceil((F1 - F0) / k);
  const t0 = Date.now();
  const parts = [];
  await Promise.all(
    Array.from({ length: k }, (_, i) => {
      const a = F0 + i * per, b = Math.min(F1, a + per);
      const part = path.join(tmp, `part${i}.mp4`);
      parts.push(part);
      return renderSegment(i, a, b, part, t0);
    }),
  );
  fs.writeFileSync(path.join(tmp, 'list.txt'), parts.map(p => `file '${p}'`).join('\n'));
  execSync(
    ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), ...audioIn,
      '-map', '0:v', ...(audioIn.length ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
      '-c:v', 'copy', '-movflags', '+faststart', out].map(s => `'${s.replace(/'/g, "'\\''")}'`).join(' '),
    { stdio: 'inherit' },
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nwrote ${path.relative(ROOT, out)} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
await new Promise(r => srv.close(r));
