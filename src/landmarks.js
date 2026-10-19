// The things that make the toy island read as Singapore: real reservoirs and Marina Bay,
// the Johor and Riau coastlines around it, a handful of cartoon landmarks, and place names.
// Heights are exaggerated (~6×) so landmarks stay visible from the default zoom.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const NEIGHBOR_DEPTH = 0.25;

const PLACES = [
  { name: 'Sentosa', lon: 103.8303, lat: 1.2494 },
  { name: 'Jurong Island', lon: 103.695, lat: 1.262 },
  { name: 'Changi Airport', lon: 103.995, lat: 1.333 },
  { name: 'Pulau Ubin', lon: 103.958, lat: 1.411 },
  { name: 'Pulau Tekong', lon: 104.05, lat: 1.405 },
  { name: 'Johor · Malaysia', lon: 103.86, lat: 1.535, country: true },
  { name: 'Batam · Indonesia', lon: 103.97, lat: 1.1, country: true },
];

// Changi runways from OpenStreetMap (aeroway=runway): 02L/20R, 02C/20C, 02R/20L
const RUNWAYS = [
  [[103.97746, 1.34895], [103.99149, 1.38224]],
  [[103.98497, 1.3288], [103.99897, 1.36195]],
  [[103.99984, 1.32239], [104.01411, 1.35618]],
];

const toonMat = (color, gradientMap, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra });

function shapeFrom(ring, project) {
  return new THREE.Shape(ring.map(([lon, lat]) => new THREE.Vector2(...project(lon, lat))));
}

/** Flat water decals that sit on (and lift with) the planning-area tile they belong to. */
export function addWater({ context, project, top, areas, areaAt, waterMat }) {
  const shoreMat = new THREE.LineBasicMaterial({ color: '#1f6f9f', transparent: true, opacity: 0.7 });
  const rings = [];
  for (const w of context?.water ?? []) {
    const ring = w.ring.map(([lon, lat]) => project(lon, lat));
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const area = areaAt(cx, cy) ?? areas[0];
    const geom = new THREE.ShapeGeometry(new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y))));
    geom.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geom, waterMat);
    mesh.position.y = top + 0.03;
    mesh.receiveShadow = true;
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring.map(([x, y]) => new THREE.Vector3(x, 0.004, -y))),
      shoreMat,
    );
    mesh.add(outline);
    area.mesh.add(mesh);
    rings.push(ring);
  }
  return rings;
}

/** Southern Johor and the Riau Islands as low, muted land so Singapore sits in its real setting. */
export function addNeighbors({ scene, context, project, gradientMap }) {
  const group = new THREE.Group();
  const topMat = toonMat('#d9e4c8', gradientMap);
  const sideMat = toonMat('#b9a27f', gradientMap);
  const edgeMat = new THREE.LineBasicMaterial({ color: '#7d8a6e', transparent: true, opacity: 0.5 });
  for (const n of context?.neighbors ?? []) {
    let geom;
    try {
      geom = new THREE.ExtrudeGeometry(shapeFrom(n.ring, project), { depth: NEIGHBOR_DEPTH, bevelEnabled: false });
    } catch {
      continue;
    }
    geom.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geom, [topMat, sideMat]);
    mesh.receiveShadow = true;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 35), edgeMat));
    group.add(mesh);
  }
  scene.add(group);
  return group;
}

export function addPlaceLabels({ scene, project, top }) {
  for (const p of PLACES) {
    const el = document.createElement('div');
    el.className = `place-label${p.country ? ' country' : ''}`;
    el.textContent = p.name;
    const obj = new CSS2DObject(el);
    const [x, y] = project(p.lon, p.lat);
    obj.position.set(x, p.country ? 0.6 : top + 0.4, -y);
    scene.add(obj);
  }
}

/**
 * Cartoon landmarks. Returns an update(time) function for the moving parts.
 * `onLand(x, y)` guards placements that depend on the reclaimed coastline.
 */
export function addLandmarks({ scene, project, top, gradientMap, areas, onLand, rand }) {
  const group = new THREE.Group();
  scene.add(group);
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const at = (lon, lat, obj) => {
    const [x, y] = project(lon, lat);
    obj.position.set(x, top, -y);
    group.add(obj);
    return obj;
  };
  const part = (geom, mat, sx, sy, sz, px = 0, py = 0, pz = 0) => {
    const m = new THREE.Mesh(geom, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // Marina Bay Sands: three towers carrying the SkyPark "ship"
  const mbs = new THREE.Group();
  const tower = toonMat('#eef3f6', gradientMap);
  mbs.add(part(box, toonMat('#cfd8dc', gradientMap), 0.62, 0.12, 0.34, 0.02, 0, 0.12));
  for (let i = -1; i <= 1; i++) mbs.add(part(box, tower, 0.1, 1.25, 0.3, i * 0.19, 0, 0));
  mbs.add(part(box, toonMat('#7cb342', gradientMap), 0.86, 0.07, 0.13, 0.1, 1.25, 0));
  mbs.rotation.y = Math.PI / 2 - 0.25; // towers run roughly north–south
  at(103.8607, 1.2834, mbs);

  // Singapore Flyer: a slowly turning wheel on an A-frame
  const flyer = new THREE.Group();
  const wheel = new THREE.Group();
  wheel.add(part(new THREE.TorusGeometry(0.55, 0.035, 6, 40), toonMat('#eceff1', gradientMap), 1, 1, 1));
  const capsuleGeo = new THREE.SphereGeometry(0.045, 6, 4);
  const capsuleMat = toonMat('#4fc3f7', gradientMap);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    wheel.add(part(capsuleGeo, capsuleMat, 1, 1, 1, Math.cos(a) * 0.58, Math.sin(a) * 0.58, 0));
  }
  wheel.position.y = 0.7;
  flyer.add(wheel);
  const legMat = toonMat('#90a4ae', gradientMap);
  for (const s of [-1, 1]) {
    const leg = part(box, legMat, 0.04, 0.78, 0.04, s * 0.17, 0, 0.05);
    leg.rotation.z = s * 0.38;
    flyer.add(leg);
  }
  flyer.rotation.y = 0.6;
  at(103.8631, 1.2893, flyer);

  // Gardens by the Bay: two glass domes and a grove of Supertrees
  const dome = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const glass = toonMat('#b2ebf2', gradientMap, { transparent: true, opacity: 0.85 });
  at(103.8645, 1.2843, part(dome, glass, 0.2, 0.13, 0.15));
  at(103.8661, 1.284, part(dome, glass, 0.16, 0.16, 0.12));
  const trunkGeo = new THREE.CylinderGeometry(0.02, 0.035, 1, 6).translate(0, 0.5, 0);
  const crownGeo = new THREE.ConeGeometry(0.1, 0.09, 8).rotateX(Math.PI).translate(0, 0.045, 0);
  const trunkMat = toonMat('#8e6bbf', gradientMap);
  const crownMat = toonMat('#d05ce3', gradientMap);
  for (let i = 0; i < 9; i++) {
    const tree = new THREE.Group();
    const h = 0.3 + rand() * 0.22;
    tree.add(part(trunkGeo, trunkMat, 1, h, 1));
    tree.add(part(crownGeo, crownMat, 1, 1, 1, 0, h, 0));
    at(103.8632 + (rand() - 0.5) * 0.004, 1.2816 + (rand() - 0.5) * 0.003, tree);
  }

  // Changi Airport: runways, control tower and the Jewel dome
  const runwayMat = toonMat('#5f6b73', gradientMap);
  const stripeMat = toonMat('#ffffff', gradientMap);
  for (const [a, b] of RUNWAYS) {
    const [ax, ay] = project(...a);
    const [bx, by] = project(...b);
    if (!onLand((ax + bx) / 2, (ay + by) / 2)) continue;
    const len = Math.hypot(bx - ax, by - ay);
    const runway = new THREE.Group();
    runway.add(part(box, runwayMat, 0.13, 0.02, len));
    runway.add(part(box, stripeMat, 0.015, 0.025, len * 0.9));
    runway.position.set((ax + bx) / 2, top, -(ay + by) / 2);
    runway.rotation.y = Math.atan2(bx - ax, -(by - ay)); // align local z with the runway (north is -z)
    group.add(runway);
  }
  const towerGrp = new THREE.Group();
  towerGrp.add(part(new THREE.CylinderGeometry(0.035, 0.05, 1, 8).translate(0, 0.5, 0), toonMat('#eceff1', gradientMap), 1, 0.62, 1));
  towerGrp.add(part(new THREE.CylinderGeometry(0.11, 0.07, 0.09, 8), toonMat('#26a69a', gradientMap), 1, 1, 1, 0, 0.66, 0));
  at(103.9872, 1.357, towerGrp);
  at(103.9894, 1.3602, part(dome, glass, 0.15, 0.09, 0.15));

  // Jurong Island: petrochemical tanks and flare stacks
  const jurong = areas.find((a) => a.name === 'Western Islands');
  if (jurong) {
    const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0);
    const tankMats = ['#eceff1', '#cfd8dc', '#fff8e1'].map((c) => toonMat(c, gradientMap));
    const stackMat = toonMat('#e53935', gradientMap);
    for (let i = 0; i < 46; i++) {
      const p = jurong.randomPoint();
      if (!p) continue;
      const stack = i % 9 === 0;
      const r = stack ? 0.025 : 0.07 + rand() * 0.06;
      const h = stack ? 0.55 : 0.08 + rand() * 0.07;
      const mesh = part(tankGeo, stack ? stackMat : tankMats[i % 3], r, h, r);
      mesh.position.set(p[0], top, -p[1]);
      group.add(mesh);
    }
  }

  // Johor–Singapore Causeway
  {
    const [ax, ay] = project(103.7686, 1.4524);
    const [bx, by] = project(103.7668, 1.461);
    const causeway = part(box, toonMat('#b0bec5', gradientMap), 0.07, 0.06, Math.hypot(bx - ax, by - ay));
    causeway.position.set((ax + bx) / 2, NEIGHBOR_DEPTH, -(ay + by) / 2);
    causeway.rotation.y = Math.atan2(bx - ax, -(by - ay));
    group.add(causeway);
  }

  return (time) => {
    wheel.rotation.z = time * 0.08;
  };
}
