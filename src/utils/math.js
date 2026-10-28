// Seeded RNG (mulberry32): the figure is identical on every load.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal sample, used for gaussian particle clusters (eyes, cheekbones)
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomDirection(rng) {
  const z = rng() * 2 - 1;
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}

/**
 * Creates one particle record. Every particle carries its formation start
 * position, a dissolve direction, a timing phase and a random key.
 * kind: 0 hood, 1 face, 2 dust, 3 eye, 4 nebula
 */
export function makeParticle(rng, x, y, z, kind, bright, size, phase, rim = false) {
  const startR = kind === 2 || kind === 4 ? 6 + rng() * 3 : 4 + rng() * 2;
  const s = randomDirection(rng);
  const len = Math.hypot(x, y - 0.1, z - 0.3) || 1;
  const r = randomDirection(rng);
  return {
    x, y, z, kind, bright, size, phase, rim,
    sx: s[0] * startR, sy: s[1] * startR, sz: s[2] * startR,
    dx: ((x) / len) * 0.8 + r[0] * 0.5,
    dy: ((y - 0.1) / len) * 0.8 + r[1] * 0.5,
    dz: ((z - 0.3) / len) * 0.8 + r[2] * 0.5,
    random: rng(),
    glitch: rng() < 0.06 ? 1 : 0,
  };
}
