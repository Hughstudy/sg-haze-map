// Builds public/data/context.json: the geography that makes the map read as Singapore.
//  - water: reservoirs, Marina Bay, big rivers/lakes inside Singapore (OpenStreetMap via Overpass)
//  - neighbors: southern Johor and the Riau Islands, clipped to the view (Natural Earth 1:10m)
// Usage: npm run context
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../public/data/context.json', import.meta.url);
const AREAS = new URL('../public/data/planning-areas.json', import.meta.url);
const UA = 'sg-haze-map/0.1 (https://github.com/Hughstudy/sg-haze-map)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson';
const VIEW = [103.35, 0.85, 104.35, 1.75]; // west, south, east, north
const MIN_WATER_KM2 = 0.12;
const MIN_LAND_KM2 = 0.5;

const KM2 = 111.32 * 110.57; // deg² → km² near the equator
const round = (n) => Math.round(n * 1e5) / 1e5;

function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function centroid(ring) {
  const n = ring.length;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function simplify(points, tol) {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Round, drop repeats and the closing point (three.js closes shapes itself).
function cleanRing(ring, tol) {
  const out = [];
  for (const [x, y] of simplify(ring, tol)) {
    const p = [round(x), round(y)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
  return out;
}

// Join a relation's outer ways end-to-end into closed rings.
function stitch(ways) {
  const pending = ways.map((w) => w.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let grew = true;
    while (grew && !samePt(ring[0], ring.at(-1))) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const w = pending[i];
        if (samePt(ring.at(-1), w[0])) ring = ring.concat(w.slice(1));
        else if (samePt(ring.at(-1), w.at(-1))) ring = ring.concat(w.slice(0, -1).reverse());
        else if (samePt(ring[0], w.at(-1))) ring = w.slice(0, -1).concat(ring);
        else if (samePt(ring[0], w[0])) ring = w.slice(1).reverse().concat(ring);
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (samePt(ring[0], ring.at(-1)) && ring.length >= 4) rings.push(ring);
  }
  return rings;
}
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];

// Sutherland–Hodgman clip of a ring to the view rectangle.
function clipToView(ring) {
  const [w, s, e, n] = VIEW;
  const edges = [
    [(p) => p[0] >= w, (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= e, (a, b) => [e, a[1] + ((b[1] - a[1]) * (e - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= s, (a, b) => [a[0] + ((b[0] - a[0]) * (s - a[1])) / (b[1] - a[1]), s]],
    [(p) => p[1] <= n, (a, b) => [a[0] + ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]), n]],
  ];
  let out = ring;
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
    }
    if (!out.length) break;
  }
  return out;
}

async function overpass(query) {
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(150_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return JSON.parse(text);
      console.warn(`${new URL(url).host}: ${res.status} ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.warn(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error('All Overpass servers failed; try again later');
}

// ---- Water inside Singapore ----
const { areas } = JSON.parse(await readFile(AREAS, 'utf8'));
const sgOuterRings = areas.flatMap((a) => a.polygons.map((p) => p[0]));
const inSingapore = (pt) => sgOuterRings.some((r) => pointInRing(pt, r));

const osm = await overpass('[out:json][timeout:120];(way["natural"="water"](1.15,103.6,1.48,104.1);relation["natural"="water"](1.15,103.6,1.48,104.1););out geom;');
const candidates = [];
for (const el of osm.elements) {
  const name = el.tags?.name ?? null;
  if (el.type === 'way' && el.geometry) {
    const pts = el.geometry.map((g) => [g.lon, g.lat]);
    if (samePt(pts[0], pts.at(-1))) candidates.push({ name, ring: pts });
  } else if (el.type === 'relation') {
    const outers = el.members.filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry).map((m) => m.geometry.map((g) => [g.lon, g.lat]));
    for (const ring of stitch(outers)) candidates.push({ name, ring });
  }
}
const water = candidates
  .filter((c) => ringArea(c.ring) * KM2 >= MIN_WATER_KM2 && inSingapore(centroid(c.ring)))
  .map((c) => ({ name: c.name, ring: cleanRing(c.ring, 0.00015) }))
  .filter((c) => c.ring.length >= 3)
  .sort((a, b) => ringArea(b.ring) - ringArea(a.ring));

// ---- Neighbouring land ----
const ne = await (await fetch(NATURAL_EARTH, { headers: { 'User-Agent': UA } })).json();
const neighbors = [];
for (const f of ne.features) {
  const country = f.properties.ADMIN;
  if (country !== 'Malaysia' && country !== 'Indonesia') continue;
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const poly of polys) {
    const clipped = clipToView(poly[0]);
    if (clipped.length < 3 || ringArea(clipped) * KM2 < MIN_LAND_KM2) continue;
    neighbors.push({ country, ring: cleanRing(clipped, 0.0008) });
  }
}

await writeFile(OUT, JSON.stringify({
  sources: {
    water: '© OpenStreetMap contributors (ODbL)',
    neighbors: 'Natural Earth 1:10m admin 0 countries (public domain)',
  },
  water,
  neighbors: neighbors.filter((n) => n.ring.length >= 3),
}));
console.log(`Wrote ${water.length} water bodies (${water.slice(0, 8).map((w) => w.name ?? '?').join(', ')}…) and ${neighbors.length} neighbouring land polygons`);
