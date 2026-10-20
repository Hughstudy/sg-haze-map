// Cartoon wind arrows that glide across the map the way the wind blows. The haze particles
// drift with the wind too, but they're soft blobs, so on their own the direction is hard to read.
// A fixed pool of instanced arrows is reused; each one fades in, travels, and fades out.
import * as THREE from 'three';

const COUNT = 22;
const LIFE_MIN = 3.2; // seconds
const LIFE_MAX = 5.5;
const CALM_KMH = 0.5; // below this the arrows shrink away

/** Flat arrow pointing along +x, about 2 units long, centred on the origin. */
function arrowGeometry(grow = 0) {
  const g = grow;
  const s = new THREE.Shape();
  s.moveTo(1 + g * 1.6, 0);
  s.lineTo(0.15 - g * 0.4, 0.62 + g);
  s.lineTo(0.15 - g * 0.4, 0.22 + g * 0.6);
  s.lineTo(-1 - g, 0.22 + g * 0.6);
  s.lineTo(-1 - g, -0.22 - g * 0.6);
  s.lineTo(0.15 - g * 0.4, -0.22 - g * 0.6);
  s.lineTo(0.15 - g * 0.4, -0.62 - g);
  s.closePath();
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
}

/**
 * `area` is the ellipse arrows spawn in ({ a, b } half-widths around the origin, in scene units);
 * `height` is how far above the sea they fly.
 */
export function createWindLayer({ scene, area, height }) {
  const fill = new THREE.InstancedMesh(arrowGeometry(), new THREE.MeshBasicMaterial({ color: '#ffffff' }), COUNT);
  const outline = new THREE.InstancedMesh(arrowGeometry(0.14), new THREE.MeshBasicMaterial({ color: '#3a2e2a' }), COUNT);
  for (const m of [fill, outline]) {
    m.frustumCulled = false;
    m.renderOrder = 2;
    scene.add(m);
  }
  // Fill is drawn a hair above its outline so they never z-fight.
  const LIFT = 0.04;

  const arrows = Array.from({ length: COUNT }, () => ({ x: 0, z: 0, age: 0, life: 1, bob: Math.random() * 10 }));
  const respawn = (p, randomAge) => {
    const r = Math.sqrt(Math.random());
    const t = Math.random() * Math.PI * 2;
    p.x = Math.cos(t) * r * area.a;
    p.z = Math.sin(t) * r * area.b;
    p.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    p.age = randomAge ? Math.random() * p.life : 0;
  };
  arrows.forEach((p) => respawn(p, true));

  // Wind as a travel direction (unit vector in the x/z plane) and strength 0..1, eased each frame.
  const target = { dx: 0, dz: 0, strength: 0, speed: 0 };
  const cur = { dx: 0, dz: -1, strength: 0, speed: 0 };
  const dummy = new THREE.Object3D();

  /** wind: { speed km/h, dir degrees the wind blows FROM }, or null. */
  function set(wind) {
    if (!wind || wind.speed == null) {
      target.strength = 0;
      return;
    }
    const rad = (wind.dir * Math.PI) / 180;
    // Blowing FROM `dir`, so it travels toward dir + 180°. Scene north is -z.
    target.dx = -Math.sin(rad);
    target.dz = Math.cos(rad);
    // Even a light breeze has a direction worth showing; stronger wind gets fuller arrows.
    target.strength = wind.speed < CALM_KMH ? 0 : THREE.MathUtils.clamp(0.5 + wind.speed / 12, 0, 1);
    target.speed = wind.speed;
  }

  function update(dt, time) {
    const ease = 1 - Math.exp(-dt * 3);
    // Turn through the shorter way so the arrows don't collapse when the wind swings round.
    const ang = Math.atan2(cur.dz, cur.dx);
    let diff = Math.atan2(target.dz, target.dx) - ang;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (target.strength > 0) {
      const a = ang + diff * ease;
      cur.dx = Math.cos(a);
      cur.dz = Math.sin(a);
    }
    cur.strength += (target.strength - cur.strength) * ease;
    cur.speed += (target.speed - cur.speed) * ease;

    // Faster than the haze so the motion reads, still proportional to wind speed.
    const v = 1.5 + cur.speed * 0.22;
    const len = 0.85 + THREE.MathUtils.clamp(cur.speed / 25, 0, 1) * 0.6;
    const yaw = Math.atan2(-cur.dz, cur.dx);
    for (let i = 0; i < COUNT; i++) {
      const p = arrows[i];
      p.age += dt;
      if (p.age >= p.life) respawn(p, false);
      p.x += cur.dx * v * dt;
      p.z += cur.dz * v * dt;
      const k = Math.sin((Math.PI * p.age) / p.life) ** 0.6 * cur.strength;
      const y = height + Math.sin(time * 1.6 + p.bob) * 0.25;
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(len * 2.3 * k, 1, 1.9 * k + 1e-4);
      dummy.position.set(p.x, y + LIFT, p.z);
      dummy.updateMatrix();
      fill.setMatrixAt(i, dummy.matrix);
      dummy.position.y = y;
      dummy.updateMatrix();
      outline.setMatrixAt(i, dummy.matrix);
    }
    fill.instanceMatrix.needsUpdate = true;
    outline.instanceMatrix.needsUpdate = true;
  }

  return { set, update };
}
