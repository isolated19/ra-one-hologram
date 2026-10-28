import * as THREE from 'three';
import { makeParticle, gaussian } from '../utils/math.js';
import { openingE } from './HoodGeometry.js';

const ss = THREE.MathUtils.smoothstep;
const g2 = (x, y, sx, sy) => Math.exp(-(x * x) / (2 * sx * sx) - (y * y) / (2 * sy * sy));

export const MOUTH_Y = -0.5;
export const EYE = { x: 0.21, y: 0.3 };

// Face outline half-width by height: angular, widest at the cheekbones,
// a defined jaw angle, tapering to the chin. Piecewise linear on purpose.
const OUTLINE = [
  [-0.86, 0.13], [-0.8, 0.21], [-0.66, 0.31], [-0.45, 0.45], [-0.2, 0.52],
  [-0.02, 0.56], [0.25, 0.535], [0.55, 0.5], [0.85, 0.47], [1.05, 0.38],
];

export function faceHalfWidth(y) {
  if (y <= OUTLINE[0][0] || y >= OUTLINE[OUTLINE.length - 1][0]) return 0;
  for (let i = 1; i < OUTLINE.length; i++) {
    const [y1, w1] = OUTLINE[i];
    if (y <= y1) {
      const [y0, w0] = OUTLINE[i - 1];
      return w0 + ((y - y0) / (y1 - y0)) * (w1 - w0);
    }
  }
  return 0;
}

/**
 * Face surface depth z(x, y), or null outside the outline. A curved base with
 * flatter cheek planes, plus sculpted features: brow ridge, recessed eye
 * sockets, nose bridge and tip, cheekbones and hollows, mouth, chin.
 */
export function faceDepth(x, y) {
  const w = faceHalfWidth(y);
  if (w <= 0) return null;
  const q = Math.abs(x) / w;
  if (q >= 1) return null;
  const ax = Math.abs(x);

  let z = 0.44 + 0.42 * Math.sqrt(1 - Math.pow(q, 2.4));
  z -= 0.12 * ss(y, 0.55, 1.05);                                   // forehead slopes back
  z -= 0.05 * ss(-y, 0.6, 0.86);                                   // under the chin

  z += 0.05 * g2(ax - 0.22, y - 0.44, 0.17, 0.045);                // brow ridge
  z += 0.02 * g2(x, y - 0.42, 0.06, 0.05);                         // glabella
  z -= 0.12 * g2(ax - EYE.x, y - EYE.y, 0.1, 0.065);               // eye sockets
  if (y < 0.4 && y > -0.26) {
    z += 0.17 * ss(-y, -0.36, 0.18) * g2(x, 0, 0.05, 1) + 0.03 * g2(x, 0, 0.09, 1); // nose bridge
  }
  z += 0.05 * g2(x, y + 0.2, 0.06, 0.05);                          // nose tip
  z += 0.03 * g2(ax - 0.08, y + 0.22, 0.04, 0.04);                 // nostril wings
  z -= 0.03 * g2(x, y + 0.31, 0.1, 0.03);                          // under the nose
  z += 0.055 * g2(ax - 0.35, y + 0.02, 0.1, 0.07);                 // cheekbones
  z -= 0.07 * g2(ax - 0.32, y + 0.3, 0.09, 0.11);                  // cheek hollows
  z += 0.035 * g2(x, y - MOUTH_Y, 0.15, 0.06);                     // lips
  z -= 0.03 * g2(x, y - MOUTH_Y, 0.17, 0.012);                     // mouth slit
  z += 0.05 * g2(x, y + 0.74, 0.11, 0.07);                         // chin
  return z;
}

// Curvature of the surface: high on features, low on flat planes
function curvature(x, y) {
  const e = 0.02;
  const c = faceDepth(x, y);
  const l = faceDepth(x - e, y);
  const r = faceDepth(x + e, y);
  const d = faceDepth(x, y - e);
  const u = faceDepth(x, y + e);
  if ([c, l, r, d, u].includes(null)) return 1;
  return Math.min(1, Math.abs(l + r + d + u - 4 * c) / (e * e) / 18);
}

/**
 * Face particles: density and brightness follow curvature and the jawline, so
 * the anatomy reads from the particles alone. Anything outside the hood opening
 * is dimmed (concealed by the hood). A deeper dim layer adds volume.
 */
export function buildFaceParticles(count, eyeCount, rng) {
  const out = [];
  const surface = Math.round(count * 0.8);
  const volume = Math.round(count * 0.12);
  const neck = count - surface - volume;

  let guard = 0;
  while (out.length < surface && guard++ < surface * 40) {
    const x = (rng() * 2 - 1) * 0.58;
    const y = -0.88 + rng() * 1.94;
    const z = faceDepth(x, y);
    if (z === null) continue;
    const c = curvature(x, y);
    const jaw = ss(Math.abs(x) / faceHalfWidth(y), 0.84, 0.98);
    const hidden = openingE(x, y) > 1;
    const density = (0.16 + 0.75 * c + 0.35 * jaw) * (hidden ? 0.45 : 1);
    if (rng() > density) continue;
    const bright = (0.3 + 0.7 * c + 0.25 * jaw) * (hidden ? 0.12 : 1) * (0.8 + rng() * 0.4);
    out.push(makeParticle(rng, x, y, z + (rng() - 0.5) * 0.008, 1, bright, 0.008 + rng() * 0.008, 0.55 + rng() * 0.25));
  }

  guard = 0;
  while (out.length < surface + volume && guard++ < volume * 40) {
    const x = (rng() * 2 - 1) * 0.55;
    const y = -0.85 + rng() * 1.8;
    const z = faceDepth(x, y);
    if (z === null) continue;
    out.push(makeParticle(rng, x, y, z - 0.04 - rng() * 0.16, 1, 0.08 + rng() * 0.08, 0.008, 0.6 + rng() * 0.2));
  }

  // Neck column receding into the hood
  for (let i = 0; i < neck; i++) {
    const a = rng() * Math.PI * 2;
    const y = -0.72 - rng() * 0.6;
    const r = 0.27 + rng() * 0.03;
    out.push(makeParticle(rng, Math.cos(a) * r, y, 0.42 + Math.sin(a) * r * 0.8, 1,
      0.1 + rng() * 0.1, 0.008, 0.5 + rng() * 0.2));
  }

  // Eye sparks: small embers in the sockets around the eye cores (EyeCores.js)
  for (let i = 0; i < eyeCount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * EYE.x + gaussian(rng) * 0.05;
    const y = EYE.y + gaussian(rng) * 0.025 + (side * (x - side * EYE.x)) * 0.2;
    const z = (faceDepth(x, y) ?? 0.8) + 0.01;
    out.push(makeParticle(rng, x, y, z, 3, 0.6 + rng() * 0.4, 0.008 + rng() * 0.006, 0.9 + rng() * 0.1));
  }
  return out;
}

/** Face surface mesh for the hologram material (fresnel picks out the contours). */
export function buildFaceMesh(cols = 150, rows = 200) {
  const pos = [];
  const uv = [];
  const ids = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const x = -0.58 + (i / cols) * 1.16;
      const y = -0.88 + (j / rows) * 1.94;
      const z = faceDepth(x, y);
      if (z === null) continue;
      ids[j * (cols + 1) + i] = pos.length / 3;
      pos.push(x, y, z);
      uv.push(i / cols, j / rows);
    }
  }
  const index = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = ids[j * (cols + 1) + i];
      const b = ids[j * (cols + 1) + i + 1];
      const c = ids[(j + 1) * (cols + 1) + i];
      const d = ids[(j + 1) * (cols + 1) + i + 1];
      if (a >= 0 && b >= 0 && c >= 0) index.push(a, b, c);
      if (b >= 0 && d >= 0 && c >= 0) index.push(b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}
