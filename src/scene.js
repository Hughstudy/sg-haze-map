import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { REGIONS, REGION_LOCATIONS, islandMean, isUpwind } from './data.js';
import { getScale, bandOf, displayValue, valuesOf } from './scales.js';
import { addWater, addNeighbors, addPlaceLabels, addLandmarks } from './landmarks.js';
import { createRainLayer } from './rain.js';
import { createWindLayer } from './wind.js';

// Local equirectangular projection centred on Singapore; 1 scene unit = 1 km.
const LAT0 = 1.3521;
const LON0 = 103.8198;
const KX = 111.32 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110.57;
const project = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];

// Map is true to scale out to this radius; fires farther away sit on log-compressed rings.
const TO_SCALE_KM = 50;
const FAR_K = 13;
const DISTANCE_RINGS = [100, 250, 500, 1000];
const RING_LABEL_BEARING = 165;
const MAX_ZOOM_OUT = 340; // camera distance that shows every distance ring
const FIRE_ZOOM_OUT = 1.35; // at most this much farther out than the island-only view, to show nearer fires // usually fire-free (Java Sea side) and nearest the camera

const DEPTH = 0.5;
const BEVEL = 0.12;
const TOP = DEPTH + BEVEL * 2;

const NATURE = new Set(['Central Water Catchment', 'Western Water Catchment', 'Lim Chu Kang', 'Mandai', 'Bukit Timah', 'Simpang', 'North-Eastern Islands', 'Changi Bay', 'Sungei Kadut']);
const CBD = new Set(['Downtown Core', 'Marina South', 'Outram', 'Museum', 'Rochor', 'Singapore River', 'Orchard', 'Straits View', 'Newton', 'River Valley']);
const SPARSE = new Set(['Tuas', 'Western Islands', 'Changi', 'Paya Lebar', 'Tengah', 'Southern Islands', 'Pioneer', 'Seletar', 'Boon Lay', 'Marina East', 'Lim Chu Kang', 'Sungei Kadut']);

const COLORS = {
  sky: new THREE.Color('#9ad8ff'),
  skyHazy: new THREE.Color('#d9c8a2'),
  sea: new THREE.Color('#4fb8e6'),
  seaHazy: new THREE.Color('#8fa9a6'),
  side: new THREE.Color('#a87c4f'),
  outline: new THREE.Color('#3a2e2a'),
  noData: new THREE.Color('#c9c9c9'),
  hazeLight: new THREE.Color('#f5f0e6'),
  hazeSmoky: new THREE.Color('#a8865c'),
};

const WHITE = new THREE.Color('#ffffff');
const bandColor = new THREE.Color();

/** Cartoon fill for a value on the current scale: band hue, lighter at the low end of each band. */
export function levelColor(value, out = new THREE.Color()) {
  if (value == null) return out.copy(COLORS.noData);
  const { bands, convert } = getScale();
  const v = convert(value);
  const i = bands.findIndex((b) => v <= b.max);
  const band = i === -1 ? bands.length - 1 : i;
  const lo = band === 0 ? 0 : bands[band - 1].max;
  const hi = Number.isFinite(bands[band].max) ? bands[band].max : lo + 150;
  const t = THREE.MathUtils.clamp((v - lo) / (hi - lo), 0, 1);
  return out.copy(bandColor.set(bands[band].color)).lerp(WHITE, 0.32 - 0.27 * t);
}

function toonGradient() {
  const tex = new THREE.DataTexture(new Uint8Array([110, 185, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function softSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInArea(x, y, area) {
  return area.rings.some((rings) => pointInRing(x, y, rings[0]) && !rings.slice(1).some((h) => pointInRing(x, y, h)));
}

const REGION_XY = Object.fromEntries(REGIONS.map((r) => [r, project(REGION_LOCATIONS[r].lon, REGION_LOCATIONS[r].lat)]));

function nearestRegion(x, y) {
  let best = REGIONS[0];
  let bestD = Infinity;
  for (const r of REGIONS) {
    const [rx, ry] = REGION_XY[r];
    const d = (rx - x) ** 2 + (ry - y) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** Dashed distance rings on the sea, labelled in real km. */
function addDistanceRings(scene, radiusOf) {
  const solid = new THREE.LineBasicMaterial({ color: '#2b6f93', transparent: true, opacity: 0.45 });
  const dashed = new THREE.LineDashedMaterial({ color: '#2b6f93', dashSize: 1.4, gapSize: 1.6, transparent: true, opacity: 0.4 });
  const b = (RING_LABEL_BEARING * Math.PI) / 180;
  for (const km of [TO_SCALE_KM, ...DISTANCE_RINGS]) {
    const r = radiusOf(km);
    const pts = Array.from({ length: 160 }, (_, i) => {
      const a = (i / 160) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * r, 0.03, Math.sin(a) * r);
    });
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), km === TO_SCALE_KM ? solid : dashed);
    if (km !== TO_SCALE_KM) ring.computeLineDistances();
    scene.add(ring);

    const el = document.createElement('div');
    el.className = `ring-label${km === TO_SCALE_KM ? ' to-scale' : ''}`;
    el.textContent = km === TO_SCALE_KM ? `${km} km · to scale inside` : `${km.toLocaleString('en-SG')} km`;
    const label = new CSS2DObject(el);
    label.position.set(Math.sin(b) * r, 0.3, -Math.cos(b) * r);
    scene.add(label);
  }
}

// Deterministic RNG so trees and buildings don't reshuffle between reloads.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function createScene(container, geo, { context = null, getInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 }) } = {}) {
  const isSmall = Math.min(window.innerWidth, window.innerHeight) < 700;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'label-layer';
  container.appendChild(labelRenderer.domElement);
  // Fire badges are placed by hand so they can pin to the screen edge when off-screen.
  const fireLabelLayer = document.createElement('div');
  fireLabelLayer.className = 'label-layer';
  container.appendChild(fireLabelLayer);

  const scene = new THREE.Scene();
  scene.background = COLORS.sky.clone();
  scene.fog = new THREE.Fog(COLORS.sky.clone(), 70, 240);

  // Near plane at 2: the camera never gets closer than controls.minDistance, and it buys depth precision.
  const camera = new THREE.PerspectiveCamera(35, 1, 2, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 12;
  controls.maxDistance = MAX_ZOOM_OUT;
  controls.maxPolarAngle = 1.3;
  controls.target.set(0, 0, 2);

  // Lights
  scene.add(new THREE.HemisphereLight('#ffffff', '#6c8fa3', 1.4));
  const sun = new THREE.DirectionalLight('#fff4dc', 2.2);
  sun.position.set(-25, 40, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 22, bottom: -22, near: 1, far: 120 });
  sun.shadow.bias = -0.0008;
  scene.add(sun);

  const gradientMap = toonGradient();

  // Sea
  const seaMat = new THREE.MeshToonMaterial({ color: COLORS.sea.clone(), gradientMap });
  // Inland water is a deeper blue than the sea so reservoirs read from the overview zoom.
  // polygonOffset keeps the thin decal from z-fighting with the tile top at overview distances.
  const waterMat = new THREE.MeshToonMaterial({
    color: COLORS.sea.clone(),
    gradientMap,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const sea = new THREE.Mesh(new THREE.CircleGeometry(400, 64), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -0.05;
  sea.receiveShadow = true;
  scene.add(sea);

  // Island: one extruded toon tile per planning area
  const sideMat = new THREE.MeshToonMaterial({ color: COLORS.side, gradientMap });
  const outlineMat = new THREE.LineBasicMaterial({ color: COLORS.outline, transparent: true, opacity: 0.6 });
  const island = new THREE.Group();
  scene.add(island);

  const areas = geo.areas.map((a) => {
    const rings = a.polygons.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => project(lon, lat))));
    const shapes = rings.map((poly) => {
      const shape = new THREE.Shape(poly[0].map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = poly.slice(1).map((h) => new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      return shape;
    });
    const extrudeOpts = { depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: 0.05, bevelSegments: 1 };
    let geom;
    try {
      geom = new THREE.ExtrudeGeometry(shapes, extrudeOpts);
    } catch (err) {
      // A degenerate hole can still trip triangulation; the area minus its holes is close enough.
      console.warn(`Dropping holes for ${a.name}:`, err.message);
      shapes.forEach((s) => (s.holes = []));
      geom = new THREE.ExtrudeGeometry(shapes, extrudeOpts);
    }
    geom.rotateX(-Math.PI / 2);
    geom.translate(0, BEVEL, 0);

    const topMat = new THREE.MeshToonMaterial({ color: COLORS.noData.clone(), gradientMap });
    const mesh = new THREE.Mesh(geom, [topMat, sideMat]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 35), outlineMat);
    mesh.add(edges);
    island.add(mesh);

    // Centroid of the largest outer ring decides which NEA region the area reports under.
    const main = rings.map((p) => p[0]).sort((p, q) => q.length - p.length)[0];
    const cx = main.reduce((s, p) => s + p[0], 0) / main.length;
    const cy = main.reduce((s, p) => s + p[1], 0) / main.length;

    const area = {
      name: a.name,
      planningRegion: a.region,
      neaRegion: nearestRegion(cx, cy),
      rings,
      mesh,
      topMat,
      target: COLORS.noData.clone(),
      lift: 0,
      value: null,
    };
    mesh.userData.area = area;
    return area;
  });

  const bbox = new THREE.Box3().setFromObject(island);
  const areaAt = (x, y) => areas.find((a) => pointInArea(x, y, a)) ?? null;

  // Real geography around and inside the island: Johor/Riau coasts, reservoirs, Marina Bay
  addNeighbors({ scene, context, project, gradientMap, clipRadius: TO_SCALE_KM });
  const waterRings = addWater({ context, project, top: TOP, areas, areaAt, waterMat });
  const inWater = (x, y) => waterRings.some((r) => pointInRing(x, y, r));
  addPlaceLabels({ scene, project, top: TOP });

  // Scenery: trees, housing blocks, CBD towers, landmarks
  const rand = rng(42);
  const randomPointIn = (area, tries = 40) => {
    const xs = area.rings.flat(2);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of xs) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let i = 0; i < tries; i++) {
      const x = minX + rand() * (maxX - minX);
      const y = minY + rand() * (maxY - minY);
      if (pointInArea(x, y, area) && !inWater(x, y)) return [x, y];
    }
    return null;
  };
  for (const area of areas) area.randomPoint = () => randomPointIn(area);

  const treeSpots = [];
  const blockSpots = [];
  const towerSpots = [];
  for (const area of areas) {
    const n = CBD.has(area.name) ? 0 : NATURE.has(area.name) ? 36 : SPARSE.has(area.name) ? 3 : 6;
    for (let i = 0; i < n; i++) { const p = randomPointIn(area); if (p) treeSpots.push(p); }
    if (CBD.has(area.name)) {
      for (let i = 0; i < 9; i++) { const p = randomPointIn(area); if (p) towerSpots.push(p); }
    } else if (!NATURE.has(area.name) && !SPARSE.has(area.name)) {
      for (let i = 0; i < 7; i++) { const p = randomPointIn(area); if (p) blockSpots.push(p); }
    }
  }

  const dummy = new THREE.Object3D();
  const place = (inst, spots, sizeFn) => {
    spots.forEach(([x, y], i) => {
      const { sx, sy, sz, rot = rand() * Math.PI } = sizeFn();
      dummy.position.set(x, TOP, -y);
      dummy.rotation.set(0, rot, 0);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    scene.add(inst);
  };

  const crownGeo = new THREE.IcosahedronGeometry(0.22, 0).translate(0, 0.38, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.035, 0.05, 0.22, 5).translate(0, 0.11, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshToonMaterial({ color: '#4caf50', gradientMap }), treeSpots.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshToonMaterial({ color: '#8d5a3b', gradientMap }), treeSpots.length);
  const treeSizes = treeSpots.map(() => 0.6 + rand() * 0.5);
  let k = 0;
  place(crowns, treeSpots, () => { const s = treeSizes[k++]; return { sx: s, sy: s, sz: s }; });
  k = 0;
  place(trunks, treeSpots, () => { const s = treeSizes[k++]; return { sx: s, sy: s, sz: s }; });
  const greens = ['#43a047', '#66bb6a', '#2e7d32', '#7cb342'].map((c) => new THREE.Color(c));
  treeSpots.forEach((_, i) => crowns.setColorAt(i, greens[i % greens.length]));

  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const pastel = ['#fff3e0', '#ffe0b2', '#e1f5fe', '#f8bbd0', '#dcedc8', '#fff9c4'].map((c) => new THREE.Color(c));
  const blocks = new THREE.InstancedMesh(boxGeo, new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap }), blockSpots.length);
  place(blocks, blockSpots, () => ({ sx: 0.14, sy: 0.35 + rand() * 0.4, sz: 0.4 }));
  blockSpots.forEach((_, i) => blocks.setColorAt(i, pastel[i % pastel.length]));

  const glass = ['#b3e5fc', '#e0f7fa', '#cfd8dc', '#bbdefb'].map((c) => new THREE.Color(c));
  const towers = new THREE.InstancedMesh(boxGeo, new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap }), towerSpots.length);
  place(towers, towerSpots, () => { const w = 0.16 + rand() * 0.12; return { sx: w, sy: 0.7 + rand() * 1.6, sz: w }; });
  towerSpots.forEach((_, i) => towers.setColorAt(i, glass[i % glass.length]));

  const updateLandmarks = addLandmarks({
    scene,
    project,
    top: TOP,
    gradientMap,
    areas,
    onLand: (x, y) => areaAt(x, y) !== null,
    rand,
  });

  // Region badges
  const regionLabels = {};
  for (const r of REGIONS) {
    const el = document.createElement('div');
    el.className = 'region-badge';
    el.innerHTML = `<span class="dot"></span><span class="name">${r}</span><span class="val">–</span>`;
    const obj = new CSS2DObject(el);
    const [x, y] = REGION_XY[r];
    obj.position.set(x, TOP + 2.2, -y);
    scene.add(obj);
    regionLabels[r] = el;
  }

  // Haze particles drifting with the wind
  const N = isSmall ? 1500 : 2800;
  const B = { x0: bbox.min.x - 8, x1: bbox.max.x + 8, z0: bbox.min.z - 8, z1: bbox.max.z + 8, y0: TOP + 0.3, y1: 7 };
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 4);
  const seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = B.x0 + Math.random() * (B.x1 - B.x0);
    pos[i * 3 + 1] = B.y0 + Math.random() ** 1.6 * (B.y1 - B.y0);
    pos[i * 3 + 2] = B.z0 + Math.random() * (B.z1 - B.z0);
    seed[i] = Math.random() * 1000;
  }
  const hazeGeo = new THREE.BufferGeometry();
  hazeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  hazeGeo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const haze = new THREE.Points(
    hazeGeo,
    new THREE.PointsMaterial({
      size: isSmall ? 5 : 4.2,
      map: softSprite(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  haze.frustumCulled = false;
  scene.add(haze);

  // Wind arrows above the haze, so direction reads even when the air is clean.
  const windLayer = createWindLayer({ scene, area: { a: 34, b: 22 }, height: TOP + 3.2 });

  // Fire hotspots: cartoon flames on the sea in their true direction from Singapore.
  // Inside TO_SCALE_KM the map is true to scale (1 unit = 1 km), so a fire there sits where it
  // really is. Beyond it, distance is log-compressed and drawn against labelled rings, so a fire
  // 300 km away reads as far away instead of landing on Batam, and the view stays on Singapore.
  const COAST = { a: 30, b: 17 }; // rough island outline, where smoke trails end
  const fireRadius = (km) => (km <= TO_SCALE_KM ? km : TO_SCALE_KM + FAR_K * Math.log(km / TO_SCALE_KM));
  addDistanceRings(scene, fireRadius);
  const fires = new THREE.Group();
  scene.add(fires);
  const flameOuterGeo = new THREE.ConeGeometry(0.55, 1.6, 7).translate(0, 0.8, 0);
  const flameInnerGeo = new THREE.ConeGeometry(0.3, 0.95, 7).translate(0, 0.475, 0);
  const logsGeo = new THREE.CylinderGeometry(0.75, 0.9, 0.2, 8).translate(0, 0.1, 0);
  const flameOuterMat = new THREE.MeshToonMaterial({ color: '#ff7a2f', emissive: '#6a1c00', gradientMap });
  const flameInnerMat = new THREE.MeshToonMaterial({ color: '#ffd84a', emissive: '#5c4000', gradientMap });
  const logsMat = new THREE.MeshToonMaterial({ color: '#6d4c41', gradientMap });
  const smokeMat = new THREE.LineDashedMaterial({ color: '#8d6e63', dashSize: 1.6, gapSize: 1.1, transparent: true, opacity: 0.85 });
  const smokeHeadGeo = new THREE.ConeGeometry(0.55, 1.4, 8);
  const smokeHeadMat = new THREE.MeshToonMaterial({ color: '#8d6e63', gradientMap });
  let fireItems = [];
  let lastWind = null;

  function updateUpwind() {
    for (const f of fireItems) {
      f.upwind = isUpwind(f.sector, lastWind);
      f.label.classList.toggle('upwind', f.upwind);
      f.smoke.visible = f.upwind;
      f.box = null;
    }
  }

  const fmtKm = (km) => Math.round(km / 10) * 10;
  const kmText = (s) => (s.maxKm - s.minKm < 40 ? `${fmtKm(s.distanceKm)} km` : `${fmtKm(s.minKm)}–${fmtKm(s.maxKm).toLocaleString('en-SG')} km`);

  /** One flame per compass direction; size grows with the number of detections there. */
  function setHotspots(hotspots) {
    for (const f of fireItems) {
      fires.remove(f.group, f.smoke);
      f.label.remove();
    }
    fireItems = (hotspots?.sectors ?? []).map((sector, i) => {
      const b = (sector.bearing * Math.PI) / 180;
      const ux = Math.sin(b);
      const uz = -Math.cos(b);
      const r = fireRadius(sector.distanceKm);
      const x = ux * r;
      const z = uz * r;
      const size = THREE.MathUtils.clamp(1 + Math.sqrt(sector.count) / 12, 1.2, 3.4);

      const group = new THREE.Group();
      const outer = new THREE.Mesh(flameOuterGeo, flameOuterMat);
      const inner = new THREE.Mesh(flameInnerGeo, flameInnerMat);
      inner.position.y = 0.05;
      group.add(new THREE.Mesh(logsGeo, logsMat), outer, inner);
      group.position.set(x, 0, z);
      group.scale.setScalar(size);
      group.traverse((o) => (o.castShadow = true));

      const el = document.createElement('div');
      el.className = 'fire-badge';
      el.innerHTML = `<span class="edge-arrow">➜</span><b>${sector.count.toLocaleString('en-SG')}</b><span class="fire-dist"> fires · ${sector.id} · ${kmText(sector)}</span><span class="upwind-tag">upwind</span><span class="rain-tag">rain</span>`;
      fireLabelLayer.appendChild(el);
      const anchor = new THREE.Vector3(x, size * 1.7 + 0.8, z);

      // Dashed smoke trail toward the coast with an arrowhead, shown only when the wind carries it here.
      const coast = Math.min(1, (0.9 / Math.hypot(ux / COAST.a, uz / COAST.b)) / r);
      const from = new THREE.Vector3(x, 1.2, z);
      const to = new THREE.Vector3(x * coast, 2.2, z * coast);
      const smoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), smokeMat);
      smoke.computeLineDistances();
      const head = new THREE.Mesh(smokeHeadGeo, smokeHeadMat);
      head.position.copy(to);
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      smoke.add(head);

      fires.add(group, smoke);
      return { sector, group, outer, inner, label: el, anchor, box: null, smoke, size, x, z, phase: i * 1.7, upwind: false };
    });
    updateUpwind();
    applyRain();
    if (!userMoved) resetView();
  }

  // Rain clouds: over the island (NEA live or model) and over fire areas (model).
  const rainLayer = createRainLayer({ scene, gradientMap, groundY: TOP });
  let islandRain = [];
  let fireRain = {};
  const rainIntensity = (mmPerHour) => THREE.MathUtils.clamp(mmPerHour / 6, 0.12, 1);
  function applyRain() {
    const spots = islandRain.map((r) => {
      const [x, y] = project(r.lon, r.lat);
      return { x, y: TOP + 4.6, z: -y, size: 1.3 + r.intensity * 0.8, intensity: r.intensity };
    });
    for (const f of fireItems) {
      const mm = fireRain[f.sector.id] ?? 0;
      const raining = mm >= 0.5;
      f.label.classList.toggle('raining', raining);
      f.box = null;
      // Cloud just beyond the flame (away from Singapore), low enough to stay clear of the labels above.
      if (raining) {
        const out = (Math.hypot(f.x, f.z) + f.size * 0.9 + 2.4) / Math.hypot(f.x, f.z);
        spots.push({ x: f.x * out, y: f.size * 0.9 + 1.4, z: f.z * out, size: 1.8, intensity: rainIntensity(mm / 3) });
      }
    }
    rainLayer.set(spots);
  }
  /** island: [{ lon, lat, mmPerHour }]; fires: { sectorId: mm over the next 3 h }. */
  function setRain({ island = [], fires: fireMm = {} } = {}) {
    islandRain = island.map((r) => ({ ...r, intensity: r.mmPerHour > 0 ? rainIntensity(r.mmPerHour) : 0 }));
    fireRain = fireMm;
    applyRain();
  }

  // State that the animation loop eases toward
  const current = Object.fromEntries(REGIONS.map((r) => [r, 0]));
  let target = { ...current };
  const wind = { vx: 0, vz: 0, tx: 0, tz: 0 };
  let hazeLevel = 0;

  /** Colours and badges follow the current scale; haze particles always follow raw PM2.5. */
  function setValues(hour) {
    const pm25 = hour?.pm25;
    const values = valuesOf(hour);
    const w = hour?.wind;
    target = Object.fromEntries(REGIONS.map((r) => [r, pm25?.[r] ?? 0]));
    for (const a of areas) {
      a.value = values?.[a.neaRegion] ?? null;
      levelColor(a.value, a.target);
    }
    for (const r of REGIONS) {
      const v = values?.[r];
      const el = regionLabels[r];
      el.querySelector('.val').textContent = v == null ? '–' : displayValue(v);
      el.querySelector('.dot').style.background = v == null ? '#bbb' : bandOf(v).color;
    }
    windLayer.set(w);
    if (w) {
      // Meteorological direction = where wind comes FROM; particles move the opposite way.
      const rad = (w.dir * Math.PI) / 180;
      const s = w.speed * 0.12;
      wind.tx = -Math.sin(rad) * s;
      wind.tz = Math.cos(rad) * s;
    }
    hazeLevel = islandMean(pm25);
    lastWind = w ?? null;
    updateUpwind();
  }

  // Hover / tap picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  let hoverCb = () => {};
  const meshes = areas.map((a) => a.mesh);
  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    const area = hit?.object.userData.area ?? null;
    if (area !== hovered) {
      if (hovered) hovered.topMat.emissive.setHex(0x000000);
      hovered = area;
      if (hovered) hovered.topMat.emissive.setHex(0x1a1a1a);
      renderer.domElement.style.cursor = hovered ? 'pointer' : '';
    }
    hoverCb(hovered, e.clientX, e.clientY);
  }
  renderer.domElement.addEventListener('pointermove', pick);
  renderer.domElement.addEventListener('pointerdown', pick);
  renderer.domElement.addEventListener('pointerleave', () => {
    if (hovered) hovered.topMat.emissive.setHex(0x000000);
    hovered = null;
    hoverCb(null);
  });

  // Framing: centre the view in the part of the screen not covered by UI cards, then back the
  // camera off until the island fits. Fires are real-distance far away, so the view only eases
  // out a little toward them; the rest pin to the screen edge (placeFireLabels).
  let framed = false;
  let userMoved = false;
  controls.addEventListener('start', () => (userMoved = true));
  // Fairly top-down so the island's familiar outline reads like a map, with enough tilt for 3D.
  const VIEW_DIR = new THREE.Vector3(0, 0.84, 0.54).normalize();
  const islandCorners = [];
  for (const x of [bbox.min.x, bbox.max.x]) for (const z of [bbox.min.z, bbox.max.z]) islandCorners.push(new THREE.Vector3(x, TOP, z));
  const ndc = new THREE.Vector3();

  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  function applyInsets(w, h) {
    const i = (insets = getInsets());
    camera.setViewOffset(w, h, (i.right - i.left) / 2, (i.bottom - i.top) / 2, w, h);
    camera.updateProjectionMatrix();
    return i;
  }

  function frame() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return; // hidden tab or collapsed pane; wait for a real size
    camera.aspect = w / h;
    applyInsets(w, h);
    for (const f of fireItems) f.box = null; // badge fonts change with the layout
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    if (!framed) resetView();
  }

  function resetView() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const ins = applyInsets(w, h);
    const m = 0.04; // breathing room in NDC
    const xMin = -1 + (2 * ins.left) / w + m;
    const xMax = 1 - (2 * ins.right) / w - m;
    const yMin = -1 + (2 * ins.bottom) / h + m;
    const yMax = 1 - (2 * ins.top) / h - m;
    controls.target.set(0, 0, 2);
    const fitDistance = (pts, start) => {
      let dist = start;
      for (let k = 0; k < 60; k++) {
        camera.position.copy(controls.target).addScaledVector(VIEW_DIR, dist);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
        const fits = pts.every((p) => {
          ndc.copy(p).project(camera);
          return ndc.x >= xMin && ndc.x <= xMax && ndc.y >= yMin && ndc.y <= yMax;
        });
        if (fits) break;
        dist *= 1.05;
      }
      return dist;
    };
    const islandDist = fitDistance(islandCorners, 30);
    // Phones keep the island-only view; there's no room to spare.
    const fireDist = w > 900 && fireItems.length ? fitDistance(fireItems.map((f) => f.group.position), islandDist) : islandDist;
    const dist = Math.min(fireDist, islandDist * FIRE_ZOOM_OUT);
    camera.position.copy(controls.target).addScaledVector(VIEW_DIR, dist);
    camera.lookAt(controls.target);
    // Far enough to zoom out to the fire rings; small portrait screens start farther out.
    controls.maxDistance = Math.max(MAX_ZOOM_OUT, dist * 1.5);
    controls.update();
    framed = true;
    userMoved = false;
  }
  new ResizeObserver(frame).observe(container);
  frame();

  /**
   * Fire badges sit above their flame when it's in view. Otherwise they pin to the edge of the
   * uncovered map area on the line from Singapore toward the fire, with an arrow pointing out.
   */
  const EDGE_PAD = 10;
  function placeFireLabels() {
    if (!fireItems.length) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const toScreen = (v) => {
      ndc.copy(v).project(camera);
      const x = ((ndc.x + 1) / 2) * w;
      const y = ((1 - ndc.y) / 2) * h;
      return ndc.z > 1 ? null : [x, y];
    };
    const [cx, cy] = toScreen(tmpVec.set(0, TOP, 0)) ?? [w / 2, h / 2];
    for (const f of fireItems) {
      const el = f.label;
      f.box ??= [el.offsetWidth / 2, el.offsetHeight / 2];
      const [hw, hh] = f.box;
      const l = insets.left + EDGE_PAD + hw;
      const r = w - insets.right - EDGE_PAD - hw;
      const t = insets.top + EDGE_PAD + hh;
      const b = h - insets.bottom - EDGE_PAD - hh;
      const p = toScreen(f.anchor);
      // Behind the camera: aim along the fire's ground direction instead.
      let [x, y] = p ?? [cx + f.x * 100, cy + f.z * 100];
      const inside = p && x >= l && x <= r && y >= t && y <= b;
      if (!inside) {
        const dx = x - cx;
        const dy = y - cy;
        let k = Infinity;
        if (dx > 0) k = Math.min(k, (r - cx) / dx);
        if (dx < 0) k = Math.min(k, (l - cx) / dx);
        if (dy > 0) k = Math.min(k, (b - cy) / dy);
        if (dy < 0) k = Math.min(k, (t - cy) / dy);
        if (!Number.isFinite(k)) k = 0;
        x = THREE.MathUtils.clamp(cx + dx * k, l, Math.max(l, r));
        y = THREE.MathUtils.clamp(cy + dy * k, t, Math.max(t, b));
        f.arrowAngle = Math.atan2(dy, dx);
      }
      if (inside !== f.inside) {
        el.classList.toggle('offscreen', !inside);
        f.inside = inside;
        f.box = null;
      }
      if (!inside) el.style.setProperty('--edge-angle', `${f.arrowAngle}rad`);
      el.style.transform = `translate(${(x - hw).toFixed(1)}px, ${(y - hh).toFixed(1)}px)`;
    }
  }

  const tmpVec = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const hazeColor = new THREE.Color();
  // Plain clock: dt is clamped so a backgrounded tab doesn't jump on return.
  let last = performance.now();
  let time = 0;

  renderer.setAnimationLoop((ts) => {
    const dt = Math.min(Math.max((ts - last) / 1000, 0), 0.1);
    last = ts;
    time += dt;
    const ease = 1 - Math.exp(-dt * 4);

    for (const r of REGIONS) current[r] += (target[r] - current[r]) * ease;
    wind.vx += (wind.tx - wind.vx) * ease;
    wind.vz += (wind.tz - wind.vz) * ease;

    for (const a of areas) {
      a.topMat.color.lerp(a.target, ease);
      a.lift += ((a === hovered ? 0.35 : 0) - a.lift) * (1 - Math.exp(-dt * 10));
      a.mesh.position.y = a.lift;
    }

    // Sky, fog and sea turn dusty as the island-wide average rises
    const h = THREE.MathUtils.clamp((hazeLevel - 15) / 120, 0, 1);
    tmpColor.copy(COLORS.sky).lerp(COLORS.skyHazy, h);
    scene.background.lerp(tmpColor, ease);
    scene.fog.color.copy(scene.background);
    // Fog scales with zoom so the island never vanishes, but thickens with haze.
    const camDist = camera.position.distanceTo(controls.target);
    scene.fog.near += (camDist * THREE.MathUtils.lerp(1.1, 0.45, h) - scene.fog.near) * ease;
    scene.fog.far += (camDist * THREE.MathUtils.lerp(3.5, 1.9, h) - scene.fog.far) * ease;
    seaMat.color.lerp(tmpColor.copy(COLORS.sea).lerp(COLORS.seaHazy, h), ease);
    waterMat.color.copy(seaMat.color).multiplyScalar(0.8);

    // Particles: advect with wind, wobble a little, wrap around the box
    const W = B.x1 - B.x0;
    const D = B.z1 - B.z0;
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      const s = seed[i];
      let x = pos[j] + (wind.vx + Math.sin(time * 0.3 + s) * 0.15) * dt;
      let z = pos[j + 2] + (wind.vz + Math.cos(time * 0.27 + s * 1.3) * 0.15) * dt;
      if (x < B.x0) x += W; else if (x > B.x1) x -= W;
      if (z < B.z0) z += D; else if (z > B.z1) z -= D;
      pos[j] = x;
      pos[j + 2] = z;

      const v = current[nearestRegion(x, -z)];
      const edge = Math.min(x - B.x0, B.x1 - x, z - B.z0, B.z1 - z, 6) / 6;
      const a = THREE.MathUtils.clamp(0.02 + (v / 260) * 0.4, 0.02, 0.45) * edge;
      hazeColor.copy(COLORS.hazeLight).lerp(COLORS.hazeSmoky, THREE.MathUtils.clamp(v / 250, 0, 1));
      const c = i * 4;
      col[c] = hazeColor.r;
      col[c + 1] = hazeColor.g;
      col[c + 2] = hazeColor.b;
      col[c + 3] = a;
    }
    hazeGeo.attributes.position.needsUpdate = true;
    hazeGeo.attributes.color.needsUpdate = true;

    updateLandmarks(time);
    rainLayer.update(dt, time);
    windLayer.update(dt, time);

    for (const f of fireItems) {
      const flick = Math.sin(time * 7 + f.phase) * 0.5 + Math.sin(time * 11.3 + f.phase * 2) * 0.5;
      const boost = f.upwind ? 1.15 : 1;
      f.outer.scale.set(boost, boost * (1 + flick * 0.1), boost);
      f.inner.scale.set(1, 1 + flick * 0.16, 1);
    }

    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    placeFireLabels();
  });

  return {
    setValues,
    setHotspots,
    setRain,
    resetView,
    /** Re-frame after the UI cards change size, unless the user has moved the camera. */
    refit: () => !userMoved && resetView(),
    onHover: (cb) => { hoverCb = cb; },
    areaCount: areas.length,
  };
}
