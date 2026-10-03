// Builds src/data/tokyo.js from open data sources.
//
//   curl -LO https://raw.githubusercontent.com/dataofjapan/land/master/tokyo.geojson
//   npm pack japan-train-data@0.6.0 && tar xzf japan-train-data-0.6.0.tgz
//   node tools/build-data.mjs tokyo.geojson package/dist/bundle.cjs.js
//
// Projection: local equirectangular around central Tokyo, 1 unit = 1 km,
// +x = east, +z = south (so the map lies on the XZ plane, y is up).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [geoPath, trainPath] = process.argv.slice(2);
if (!geoPath || !trainPath) {
  console.error('usage: node tools/build-data.mjs <tokyo.geojson> <japan-train-data bundle.cjs.js>');
  process.exit(1);
}

const LAT0 = 35.684, LNG0 = 139.752;
const KX = Math.cos(LAT0 * Math.PI / 180) * 111.32, KY = 110.57;
const proj = (lng, lat) => [+((lng - LNG0) * KX).toFixed(3), +(-(lat - LAT0) * KY).toFixed(3)];
const inBox = ([x, z]) => Math.abs(x) < 19 && Math.abs(z) < 17;

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1];
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1e-9;
  let maxD = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return dp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(dp(pts.slice(idx), eps));
}

// ---- 23 special wards (地球地図日本 / GSI Global Map Japan via dataofjapan/land)
const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
const wards = [];
for (const f of geo.features) {
  if (f.properties.area_ja !== '都区部') continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let best = null;
  const rings = [];
  for (const poly of polys) {
    const ring = poly[0].map(([lng, lat]) => proj(lng, lat));
    // closed ring: simplify the two halves separately (DP degenerates when first == last)
    const mid = ring.length >> 1;
    const s = dp(ring.slice(0, mid + 1), 0.04).slice(0, -1).concat(dp(ring.slice(mid), 0.04));
    if (s.length < 4) continue;
    rings.push(s);
    if (!best || s.length > best.length) best = s;
  }
  let cx = 0, cz = 0;
  for (const p of best) { cx += p[0]; cz += p[1]; }
  wards.push({ ja: f.properties.ward_ja, en: f.properties.ward_en, c: [+(cx / best.length).toFixed(2), +(cz / best.length).toFixed(2)], rings });
}

// ---- railway lines (japan-train-data, MIT; station geodata from ekidata.jp)
const require = createRequire(import.meta.url);
const train = require(path.resolve(trainPath));
const LINES = [
  [11302, '#9acd32', 'Yamanote', true], [11312, '#ff7a1a', 'Chuo'], [11313, '#ffd400', 'Chuo-Sobu'],
  [11332, '#00b2e5', 'Keihin-Tohoku'], [11321, '#00ac9a', 'Saikyo'], [11326, '#e60033', 'Keiyo'],
  [28001, '#ff9500', 'Ginza'], [28002, '#f62e36', 'Marunouchi'], [28003, '#b5b5ac', 'Hibiya'],
  [28004, '#009bbf', 'Tozai'], [28005, '#00bb85', 'Chiyoda'], [28006, '#c1a470', 'Yurakucho'],
  [28008, '#8f76d6', 'Hanzomon'], [28009, '#00ac9b', 'Namboku'], [28010, '#9c5e31', 'Fukutoshin'],
  [99301, '#ce045b', 'Oedo'], [99302, '#e85298', 'Asakusa'], [99303, '#0079c2', 'Mita'],
  [99304, '#6cbb5a', 'Shinjuku'], [99311, '#00a0de', 'Yurikamome'], [99337, '#00418e', 'Rinkai'],
  [24006, '#dd0077', 'Inokashira'], [26001, '#da0442', 'Toyoko'], [26003, '#20a288', 'Den-en-toshi'],
  [25001, '#2288cc', 'Odakyu'], [24001, '#dd0077', 'Keio'], [22001, '#ff6600', 'Seibu Ikebukuro'],
  [22007, '#0099cc', 'Seibu Shinjuku'], [21001, '#0f6cc3', 'Tobu Tojo'], [27001, '#e5171f', 'Keikyu'],
  [99336, '#0068b7', 'Tokyo Monorail'], [99309, '#c1272d', 'Tsukuba Express'], [99305, '#ee86a7', 'Toden Arakawa'],
  [21002, '#0f6cc3', 'Tobu Skytree'], [23001, '#005aaa', 'Keisei'],
];
const rails = [];
const stations = new Map();
for (const [id, color, name, loop] of LINES) {
  const line = train.lines.find(l => l.id === id);
  if (!line) continue;
  const pts = line.stations.map(s => ({ ja: s.name.ja, en: s.name.en, p: proj(s.location.lng, s.location.lat) }));
  if (loop) pts.push(pts[0]);
  let cur = [];
  const flush = () => { if (cur.length > 1) rails.push({ name, ja: line.name.ja, color, loop: !!loop && cur.length === pts.length, pts: cur.map(s => s.p), st: cur.map(s => s.ja) }); cur = []; };
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i];
    if (!inBox(s.p)) { flush(); continue; }
    if (cur.length) {
      const q = cur[cur.length - 1].p;
      if (Math.hypot(s.p[0] - q[0], s.p[1] - q[1]) > 4.9) flush();
    }
    cur.push(s);
    if (!stations.has(s.ja)) stations.set(s.ja, { ja: s.ja, en: s.en, p: s.p, n: 0 });
    stations.get(s.ja).n++;
  }
  flush();
}

const LANDMARKS = [
  { ja: '東京タワー', en: 'TOKYO TOWER', ll: [139.7454, 35.6586], h: 0.333 },
  { ja: '東京スカイツリー', en: 'TOKYO SKYTREE', ll: [139.8107, 35.7101], h: 0.634 },
  { ja: '渋谷スクランブル交差点', en: 'SHIBUYA SCRAMBLE', ll: [139.7005, 35.6595], h: 0 },
  { ja: '歌舞伎町', en: 'KABUKICHO', ll: [139.7034, 35.6938], h: 0 },
  { ja: '都庁', en: 'METROPOLITAN GOV.', ll: [139.6917, 35.6896], h: 0.243 },
].map(l => ({ ja: l.ja, en: l.en, p: proj(...l.ll), h: l.h }));

const out = `// Generated by tools/build-data.mjs — do not edit by hand.
// Ward boundaries: 地球地図日本 (GSI Global Map Japan) via github.com/dataofjapan/land
// Railway stations: japan-train-data (MIT, Marco Lüthy), station geodata from ekidata.jp
// Projection: 1 unit = 1 km, origin ${LAT0}N ${LNG0}E, +x east, +z south.
export const ORIGIN = [${LAT0}, ${LNG0}];
export const WARDS = ${JSON.stringify(wards)};
export const RAILS = ${JSON.stringify(rails)};
export const STATIONS = ${JSON.stringify([...stations.values()])};
export const LANDMARKS = ${JSON.stringify(LANDMARKS)};
`;
fs.writeFileSync(new URL('../src/data/tokyo.js', import.meta.url), out);
console.log(`wards ${wards.length}, rails ${rails.length}, stations ${stations.size}, bytes ${out.length}`);
