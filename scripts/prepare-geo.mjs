// Downloads URA Master Plan 2019 planning-area boundaries from data.gov.sg,
// simplifies them, and writes a compact file the browser can load quickly.
// Usage: npm run geo
import { writeFile, mkdir } from 'node:fs/promises';

const DATASET = 'd_4765db0e87b9c86336792efe8a1f7a66';
const OUT = new URL('../public/data/planning-areas.json', import.meta.url);
const TOLERANCE = 0.0003; // degrees, about 33 m
const MIN_RING_POINTS = 4;

async function downloadUrl() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`https://api-open.data.gov.sg/v1/public/api/datasets/${DATASET}/poll-download`);
    const body = await res.json();
    if (body?.data?.url) return body.data.url;
    console.warn(`poll-download attempt ${attempt} failed, retrying…`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('Could not get download URL from data.gov.sg');
}

// Iterative Douglas–Peucker on a closed ring.
function simplify(points, tol) {
  if (points.length <= MIN_RING_POINTS) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tol * tol;
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
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (n) => Math.round(n * 1e5) / 1e5;
const MIN_HOLE_AREA = 1e-7; // deg², about 0.1 ha; slivers this small break triangulation

const ringArea = (ring) =>
  Math.abs(ring.reduce((s, [x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length];
    return s + x * ny - nx * y;
  }, 0)) / 2;

// Round, drop repeated points and the GeoJSON closing point (three.js closes shapes itself).
function cleanRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [round(x), round(y)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  const [fx, fy] = out[0];
  const [lx, ly] = out.at(-1);
  if (fx === lx && fy === ly) out.pop();
  return out;
}
const title = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const url = await downloadUrl();
const geo = await (await fetch(url)).json();

const areas = geo.features.map((f) => {
  const g = f.geometry;
  const polygons = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return {
    name: title(f.properties.PLN_AREA_N),
    region: title(f.properties.REGION_N.replace(' REGION', '')),
    polygons: polygons
      .map((rings) => {
        const [outer, ...holes] = rings.map((ring) => cleanRing(simplify(ring, TOLERANCE)));
        if (outer.length < 3 || ringArea(outer) === 0) return null;
        return [outer, ...holes.filter((h) => h.length >= 3 && ringArea(h) >= MIN_HOLE_AREA)];
      })
      .filter(Boolean),
  };
});

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ source: 'URA Master Plan 2019 Planning Area Boundary (No Sea), data.gov.sg', areas }));
const vertices = areas.reduce((n, a) => n + a.polygons.flat(2).length, 0);
console.log(`Wrote ${areas.length} planning areas, ${vertices} vertices → ${OUT.pathname}`);
