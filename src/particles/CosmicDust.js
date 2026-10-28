import { makeParticle } from '../utils/math.js';

// Sample a point in a shell around the figure, keeping the head area clear
function sampleShell(rng, minR, spread, ySpread = 3.0) {
  const a = rng() * Math.PI * 2;
  const r = minR + Math.pow(rng(), 1.8) * spread;
  const y = 0.4 + (rng() * 2 - 1) * ySpread;
  return [Math.cos(a) * r, y, Math.sin(a) * r * 0.8];
}

/**
 * Layer B: micro cosmic dust. Mostly tiny and faint, with a few brighter motes;
 * a share hugs the silhouette so the figure seems to shed stardust.
 */
export function buildDust(count, rng) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const near = rng() < 0.35;
    const [x, y, z] = near ? sampleShell(rng, 1.15, 0.7, 2.2) : sampleShell(rng, 1.6, 3.6);
    const mote = rng() < 0.05;
    out.push(makeParticle(
      rng, x, y, z, 2,
      mote ? 0.9 + rng() * 0.5 : 0.2 + rng() * 0.45,
      mote ? 0.014 + rng() * 0.008 : 0.004 + rng() * 0.008,
      rng() * 0.25,
    ));
  }
  return out;
}

/** Layer E: a few large, faint nebula sprites around the silhouette (procedural noise). */
export function buildNebula(count, rng) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const [x, y, z] = sampleShell(rng, 1.4, 2.2, 2.0);
    out.push(makeParticle(
      rng, x, y, z - 0.6, 4,
      0.25 + rng() * 0.2,
      0.7 + rng() * 1.1,
      0.1 + rng() * 0.4,
    ));
  }
  return out;
}
