// Cartoon rain clouds: a puffy cloud with falling streaks whose density follows rain intensity.
// A fixed pool is reused, so switching hours never allocates new geometry.
import * as THREE from 'three';

const DROPS = 36;
const POOL = 20;
const LIGHT = new THREE.Color('#f4f6f8');
const DARK = new THREE.Color('#8a9aa6');

export function createRainLayer({ scene, gradientMap, groundY }) {
  const puff = new THREE.IcosahedronGeometry(1, 1);
  const dropMat = new THREE.LineBasicMaterial({ color: '#2f8fd8', transparent: true, opacity: 0.75 });
  const puffs = [
    [0, 0, 0, 1],
    [0.9, -0.15, 0.1, 0.75],
    [-0.85, -0.2, -0.05, 0.7],
    [0.2, 0.35, -0.25, 0.65],
  ];

  const clouds = Array.from({ length: POOL }, () => {
    const group = new THREE.Group();
    const mat = new THREE.MeshToonMaterial({ color: LIGHT.clone(), gradientMap });
    for (const [x, y, z, s] of puffs) {
      const m = new THREE.Mesh(puff, mat);
      m.position.set(x, y, z);
      m.scale.setScalar(s);
      m.castShadow = true;
      group.add(m);
    }
    const pos = new Float32Array(DROPS * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const drops = new THREE.LineSegments(geo, dropMat);
    drops.frustumCulled = false;
    const seeds = Float32Array.from({ length: DROPS }, () => Math.random());
    group.visible = false;
    scene.add(group, drops);
    return { group, mat, drops, pos, seeds, spot: null, phase: Math.random() * 10 };
  });

  /**
   * spots: [{ x, y, z, size, intensity }] in scene units; intensity 0..1 (0 = cloud only).
   * Extra spots beyond the pool are ignored.
   */
  function set(spots) {
    clouds.forEach((c, i) => {
      const s = spots[i] ?? null;
      c.spot = s;
      c.group.visible = !!s;
      c.drops.visible = !!s && s.intensity > 0;
      if (!s) return;
      c.group.position.set(s.x, s.y, s.z);
      c.group.scale.setScalar(s.size);
      c.mat.color.copy(LIGHT).lerp(DARK, Math.min(1, s.intensity * 1.2));
      c.drops.geometry.setDrawRange(0, Math.max(4, Math.round(DROPS * s.intensity)) * 2);
    });
  }

  function update(dt, time) {
    for (const c of clouds) {
      const s = c.spot;
      if (!s) continue;
      c.group.position.y = s.y + Math.sin(time * 0.8 + c.phase) * 0.12;
      if (!c.drops.visible) continue;
      const fall = s.y - groundY;
      const r = s.size * 1.1;
      for (let i = 0; i < DROPS; i++) {
        // each streak cycles from the cloud base to the ground
        const t = (c.seeds[i] + time * (0.9 + c.seeds[i] * 0.4)) % 1;
        const ang = c.seeds[i] * 97.3;
        const rad = r * Math.sqrt((c.seeds[i] * 7.31) % 1);
        const x = s.x + Math.cos(ang) * rad;
        const z = s.z + Math.sin(ang) * rad;
        const y = s.y - s.size * 0.5 - t * fall;
        const j = i * 6;
        c.pos[j] = x; c.pos[j + 1] = y; c.pos[j + 2] = z;
        c.pos[j + 3] = x - 0.05; c.pos[j + 4] = y - 0.45; c.pos[j + 5] = z;
      }
      c.drops.geometry.attributes.position.needsUpdate = true;
    }
  }

  return { set, update };
}
