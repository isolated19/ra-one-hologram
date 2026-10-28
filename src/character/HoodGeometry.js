import * as THREE from 'three';
import { makeParticle } from '../utils/math.js';

const ss = THREE.MathUtils.smoothstep;

// Cloak silhouette as (radius, y) control points, crown to hem: a pointed crown,
// straight-falling sides, a pinch at the neck, then shoulders.
const PROFILE = new THREE.SplineCurve([
  [0.0, 2.45], [0.16, 2.32], [0.46, 2.04], [0.76, 1.66], [0.95, 1.2], [1.02, 0.7],
  [1.0, 0.2], [0.95, -0.22], [1.12, -0.58], [1.42, -0.94], [1.68, -1.28], [1.85, -1.6],
].map(([r, y]) => new THREE.Vector2(r, y)));

// Height h runs from 0 (peak) to 1 (hem), spaced evenly along the outline
const _p = new THREE.Vector2();
export const hoodY = (h) => PROFILE.getPointAt(h, _p).y;
export const hoodR = (h) => PROFILE.getPointAt(h, _p).x;
export const HOOD_Z_SQUASH = 0.95;

// y is monotonic in h, so a lookup table inverts it
const H_TABLE = Array.from({ length: 513 }, (_, i) => hoodY(i / 512));
function hFromY(y) {
  let lo = 0;
  let hi = 512;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (H_TABLE[mid] > y) lo = mid; else hi = mid;
  }
  const f = (H_TABLE[lo] - y) / (H_TABLE[lo] - H_TABLE[hi] || 1);
  return (lo + THREE.MathUtils.clamp(f, 0, 1)) / 512;
}

// Fabric folds: irregular, asymmetric, stronger toward the hem
const foldPhase = (a, h) => a * 7 + h * 9 + 0.6 * Math.sin(a * 3);
export const foldCrest = (a, h) => 0.5 + 0.5 * Math.sin(foldPhase(a, h));
const fold = (a, h) =>
  1 + (0.4 + 0.6 * h) * (0.045 * Math.sin(foldPhase(a, h)) + 0.018 * Math.sin(a * 13 - h * 5)) +
  0.012 * Math.sin(a * 2 + 1.3);

// Deep cowl: the front juts forward around the face so the face sits recessed.
// The crown drapes back and leans slightly to one side.
const cowl = (a, y) => 0.3 * Math.pow(Math.max(0, Math.sin(a)), 3) * Math.exp(-(((y - 0.4) / 1.1) ** 2));
const drape = (y) => 0.3 * ss(y, 1.2, 2.45) ** 2;
const lean = (y) => 0.08 * ss(y, 1.0, 2.45) ** 2;

/** Point on a hood shell. scale < 1 gives the inner layers. */
export function hoodPoint(h, a, scale = 1) {
  const y = hoodY(h);
  const r = hoodR(h) * scale * fold(a, h);
  return [
    Math.cos(a) * r + lean(y),
    y,
    Math.sin(a) * r * HOOD_Z_SQUASH + cowl(a, y) - drape(y),
  ];
}

/** Point on the front of a hood shell at a given x, y (used for the opening edge). */
export function hoodFrontPoint(x, y, scale = 1) {
  const h = hFromY(y);
  let a = Math.acos(THREE.MathUtils.clamp(x / (hoodR(h) * scale), -1, 1));
  a = Math.acos(THREE.MathUtils.clamp(x / (hoodR(h) * scale * fold(a, h)), -1, 1));
  return hoodPoint(h, a, scale);
}

/**
 * Face opening: a narrow pointed arch, rounded at the chin, slightly skewed.
 * The same numbers are compiled into the hologram shader (HolographicMaterial.js).
 */
export const OPENING = { yBottom: -0.95, yTop: 1.05, width: 0.6, skew: 0.025 };

export function openingHalfWidth(v) {
  if (v <= 0 || v >= 1) return 0;
  const s = Math.min(v / 0.14, 1);
  return OPENING.width * (1 - Math.pow(Math.max(0, (v - 0.45) / 0.55), 1.3)) * Math.sqrt(s * (2 - s));
}

/** < 1 inside the opening, 1 on its edge. */
export function openingE(x, y) {
  const v = (y - OPENING.yBottom) / (OPENING.yTop - OPENING.yBottom);
  const hw = openingHalfWidth(v);
  if (hw <= 1e-4) return 2;
  return Math.abs(x - OPENING.skew * v) / hw;
}

/** Points along the opening edge, left side bottom→top then right side top→bottom. */
export function openingEdge(steps, widen = 1) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const v = 0.005 + 0.99 * (i / steps);
    pts.push([-openingHalfWidth(v) * widen + OPENING.skew * v, OPENING.yBottom + v * (OPENING.yTop - OPENING.yBottom)]);
  }
  for (let i = steps; i >= 0; i--) {
    const v = 0.005 + 0.99 * (i / steps);
    pts.push([openingHalfWidth(v) * widen + OPENING.skew * v, OPENING.yBottom + v * (OPENING.yTop - OPENING.yBottom)]);
  }
  return pts;
}

/** Hood surface mesh (outer shell) for the hologram material. */
export function buildHoodMesh(segments = 160, rings = 140) {
  const geo = new THREE.BufferGeometry();
  const pos = [];
  const uv = [];
  const index = [];
  for (let i = 0; i <= rings; i++) {
    const h = i / rings;
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos.push(...hoodPoint(h, a));
      uv.push(j / segments, 1 - h);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// Front-view silhouette edges (the sides) glow more than the interior
const silhouette = (a) => ss(Math.abs(Math.cos(a)), 0.72, 0.98);

/**
 * Hood particles in layers: outer shell (fold-weighted density), mid and inner
 * shells for depth, a thick rim band where the fabric turns in around the face,
 * and drift clusters (kind 5) that peel off the edges and return.
 */
export function buildHoodParticles(count, rng) {
  const out = [];
  const n = {
    outer: Math.round(count * 0.52),
    mid: Math.round(count * 0.18),
    inner: Math.round(count * 0.13),
    rim: Math.round(count * 0.11),
  };
  const driftCount = count - n.outer - n.mid - n.inner - n.rim;

  const shell = (target, scale, accept, brightFn, sizeFn, phaseFn) => {
    let made = 0;
    let guard = 0;
    while (made < target && guard++ < target * 12) {
      const h = rng();
      const a = rng() * Math.PI * 2;
      const crest = foldCrest(a, h);
      if (rng() > accept(crest, h)) continue;
      const [x, y, z] = hoodPoint(h, a, scale);
      const e = openingE(x, y);
      if (z > 0 && e < 1) continue;
      const rim = z > 0.2 && e >= 1 && e < 1.09;
      out.push(makeParticle(rng, x, y, z, 0, brightFn(crest, a, rim), sizeFn(rim), phaseFn(h), rim));
      made++;
    }
  };

  // Outer shell: density follows the fold crests so the fabric reads as striations
  shell(n.outer, 1, (c, h) => 0.3 + 0.7 * c * c * (0.5 + 0.5 * h) + 0.2 * (1 - h),
    (c, a, rim) => rim ? 1.5 + rng() * 0.4 : (0.32 + 0.6 * c * c) * (1 + 1.2 * silhouette(a)) * (0.7 + rng() * 0.6),
    (rim) => rim ? 0.022 : 0.009 + rng() * rng() * 0.02,
    (h) => 0.2 + h * 0.25 + rng() * 0.2);
  shell(n.mid, 0.93, (c) => 0.4 + 0.6 * c,
    (c) => 0.16 + 0.16 * c + rng() * 0.08, () => 0.008 + rng() * 0.006, (h) => 0.3 + h * 0.2 + rng() * 0.15);
  shell(n.inner, 0.85, () => 1,
    () => 0.08 + rng() * 0.08, () => 0.008, (h) => 0.35 + h * 0.2 + rng() * 0.15);

  // Rim band: fabric thickness between outer and inner shell around the opening
  const edge = openingEdge(160);
  for (let i = 0; i < n.rim; i++) {
    const [ex, ey] = edge[Math.floor(rng() * edge.length)];
    const x = ex * (1 + rng() * 0.07);
    const outerP = hoodFrontPoint(x, ey, 1);
    const innerP = hoodFrontPoint(x * 0.97, ey, 0.85);
    const t = Math.pow(rng(), 1.6); // denser toward the outer lip
    const p = outerP.map((v, k) => v + (innerP[k] - v) * t);
    out.push(makeParticle(rng, p[0], p[1], p[2], 0, (1.4 - t * 0.9) * (0.8 + rng() * 0.4), 0.012 + rng() * 0.01, 0.4 + rng() * 0.2, true));
  }

  // Drift clusters on the opening rim and the side silhouette
  let made = 0;
  while (made < driftCount) {
    let base;
    if (rng() < 0.5) {
      const [ex, ey] = edge[Math.floor(rng() * edge.length)];
      base = hoodFrontPoint(ex * 1.04, ey, 1);
    } else {
      const a = (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.5;
      base = hoodPoint(0.08 + rng() * 0.8, a, 1);
    }
    const seed = rng();
    const size = 3 + Math.floor(rng() * 6);
    for (let k = 0; k < size && made < driftCount; k++, made++) {
      const p = makeParticle(rng,
        base[0] + (rng() - 0.5) * 0.06, base[1] + (rng() - 0.5) * 0.06, base[2] + (rng() - 0.5) * 0.06,
        5, 0.9 + rng() * 0.6, 0.01 + rng() * 0.01, 0.45 + rng() * 0.2);
      p.seq = seed;
      out.push(p);
    }
  }
  return out;
}
