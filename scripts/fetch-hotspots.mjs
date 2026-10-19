// Fetches recent VIIRS fire detections around Singapore from NASA FIRMS and writes
// public/data/hotspots.json. Runs in the deploy workflow because FIRMS needs a
// private MAP_KEY and has no CORS, so the browser can't call it directly.
// Usage: FIRMS_MAP_KEY=... npm run hotspots
import { writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.FIRMS_MAP_KEY;
const SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];
const BBOX = [95, -6, 120, 8]; // west,south,east,north: Sumatra, Peninsular Malaysia, Borneo
const DAYS = 2;
const OUT = new URL('../public/data/hotspots.json', import.meta.url);

if (!KEY) {
  console.log('FIRMS_MAP_KEY not set; skipping hotspots (the site hides the fire layer).');
  process.exit(0);
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split('\n');
  const cols = header.split(',');
  const at = (name) => {
    const i = cols.indexOf(name);
    if (i === -1) throw new Error(`missing column ${name}`);
    return i;
  };
  const idx = { lat: at('latitude'), lon: at('longitude'), frp: at('frp'), date: at('acq_date'), time: at('acq_time'), conf: at('confidence') };
  return rows.map((r) => r.split(',')).map((c) => ({
    lat: Number(c[idx.lat]),
    lon: Number(c[idx.lon]),
    frp: Number(c[idx.frp]) || 0,
    // acq_time is HHMM in UTC
    t: Date.parse(`${c[idx.date]}T${c[idx.time].padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z`) / 1000,
    conf: c[idx.conf],
  }));
}

async function fetchSource(source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/${source}/${BBOX.join(',')}/${DAYS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  // Errors come back as plain text such as "Invalid MAP_KEY."
  if (!res.ok || !text.startsWith('latitude')) throw new Error(`${source}: ${text.slice(0, 120).trim() || res.status}`);
  return parseCsv(text);
}

const results = await Promise.allSettled(SOURCES.map(fetchSource));
const points = [];
const used = [];
results.forEach((r, i) => {
  if (r.status === 'fulfilled') {
    used.push(SOURCES[i]);
    points.push(...r.value);
  } else {
    console.warn(`Skipping ${r.reason.message}`);
  }
});

if (!used.length) {
  // Don't fail the deploy over fire data; the site just hides the layer.
  console.warn('No FIRMS source succeeded; not writing hotspots.json.');
  process.exit(0);
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const kept = points
  .filter((p) => p.conf !== 'l' && Number.isFinite(p.lat) && Number.isFinite(p.t))
  .map((p) => [round(p.lon, 3), round(p.lat, 3), round(p.frp, 1), p.t]);

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  generatedAt: Math.floor(Date.now() / 1000),
  sources: used,
  bbox: BBOX,
  points: kept,
}));
console.log(`Wrote ${kept.length} detections from ${used.join(', ')} → ${OUT.pathname}`);
