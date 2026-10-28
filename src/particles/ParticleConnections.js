import * as THREE from 'three';
import { createParticleMaterial } from './ParticleSystem.js';
import { mulberry32, makeParticle } from '../utils/math.js';

// Layer C: neural links + structural contours, and the energy sparks travelling along them
const sparkVertex = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute float aSeed;
uniform float uTime;
uniform float uSpeed;
uniform float uForm;
uniform float uDissolve;
uniform float uNeural;
uniform float uPixelRatio;
uniform float uScale;
uniform float uBrightness;
varying float vA;
void main() {
  float f = fract(uTime * uSpeed * (0.10 + aSeed * 0.22) * (0.6 + uNeural * 1.4) + aSeed);
  vec3 pos = mix(aA, aB, f);
  float vis = smoothstep(0.85, 1.0, uForm) * (1.0 - uDissolve);
  // more sparks are lit as neural activity rises
  vis *= step(aSeed, 0.35 + 0.65 * clamp(uNeural, 0.0, 1.0));
  vA = vis * sin(f * 3.14159) * uBrightness;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(0.02 * uScale * uPixelRatio / max(-mv.z, 0.1), 40.0);
}
`;

const sparkFragment = /* glsl */ `
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float g = exp(-r * r * 40.0);
  gl_FragColor = vec4(vec3(1.0, 0.54, 0.5) * 2.2 * g, g * vA);
}
`;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Random subset of nodes so the link count stays bounded
function pickNodes(nodes, count, rng) {
  if (nodes.length <= count) return nodes;
  const seen = new Set();
  const out = [];
  while (out.length < count) {
    const i = Math.floor(rng() * nodes.length);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(nodes[i]);
  }
  return out;
}

// Spatial hash: each node only checks its own cell and the 26 around it,
// so we never test all pairs.
function buildSegments(nodes, maxDist, maxLinks) {
  const cell = maxDist;
  const grid = new Map();
  const cellOf = (p) => [Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor(p.z / cell)];
  nodes.forEach((p, i) => {
    const [cx, cy, cz] = cellOf(p);
    const key = `${cx},${cy},${cz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });

  const segs = [];
  nodes.forEach((p, i) => {
    const [cx, cy, cz] = cellOf(p);
    const cand = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const q = nodes[j];
            const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
            if (d < maxDist) cand.push([d, j]);
          }
        }
      }
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < Math.min(maxLinks, cand.length); k++) {
      segs.push([i, cand[k][1]]);
    }
  });
  return segs;
}

// Contour polylines → node records + consecutive segments
function contourGraph(contours, rng) {
  const nodes = [];
  const segs = [];
  for (const { points, kind, bright } of contours) {
    const first = nodes.length;
    for (const [x, y, z] of points) {
      nodes.push(makeParticle(rng, x, y, z, kind, bright, 0, kind === 0 ? 0.6 : 0.75));
    }
    for (let i = first; i < nodes.length - 1; i++) segs.push([i, i + 1]);
  }
  return { nodes, segs };
}

// Two vertices per segment, carrying the endpoint's formation and dissolve data
function packSegments(nodes, segs, rng) {
  const v = segs.length * 2;
  const position = new Float32Array(v * 3);
  const aStart = new Float32Array(v * 3);
  const aDir = new Float32Array(v * 3);
  const aPhase = new Float32Array(v);
  const aRandom = new Float32Array(v);
  const aSize = new Float32Array(v);
  const aBright = new Float32Array(v);
  const aKind = new Float32Array(v);
  const aGlitch = new Float32Array(v);
  const aSeq = new Float32Array(v);

  segs.forEach(([ia, ib], s) => {
    const A = nodes[ia];
    const B = nodes[ib];
    const seed = rng();
    const phase = Math.max(A.phase, B.phase);
    [A, B].forEach((P, e) => {
      const i = s * 2 + e;
      position.set([P.x, P.y, P.z], i * 3);
      aStart.set([P.sx, P.sy, P.sz], i * 3);
      aDir.set([P.dx, P.dy, P.dz], i * 3);
      aPhase[i] = phase;
      aRandom[i] = seed;
      aSize[i] = 0;
      aBright[i] = (A.bright + B.bright) * 0.5;
      aKind[i] = P.kind;
      aGlitch[i] = 0;
      aSeq[i] = e;
    });
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aStart', new THREE.BufferAttribute(aStart, 3));
  geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute('aRandom', new THREE.BufferAttribute(aRandom, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute('aBright', new THREE.BufferAttribute(aBright, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1));
  geo.setAttribute('aGlitch', new THREE.BufferAttribute(aGlitch, 1));
  geo.setAttribute('aSeq', new THREE.BufferAttribute(aSeq, 1));
  return geo;
}

function buildSparks(nodes, segs, count, rng) {
  const A = new Float32Array(count * 3);
  const B = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [ia, ib] = segs[Math.floor(rng() * segs.length)];
    const a = nodes[ia];
    const b = nodes[ib];
    A.set([a.x, a.y, a.z], i * 3);
    B.set([b.x, b.y, b.z], i * 3);
    seed[i] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(A.slice(), 3));
  geo.setAttribute('aA', new THREE.BufferAttribute(A, 3));
  geo.setAttribute('aB', new THREE.BufferAttribute(B, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  return geo;
}

export class ParticleConnections {
  constructor(uniforms, nodes, cfg, contours = [], seed = 99) {
    const rng = mulberry32(seed);
    const linkNodes = pickNodes(nodes, cfg.connections, rng);
    // Link distance scales with node density so the web looks similar across presets
    const maxDist = clamp(0.9 * Math.sqrt(70 / Math.max(1, linkNodes.length)), 0.12, 0.35);
    const segs = buildSegments(linkNodes, maxDist, 2);

    // Contours are appended after the links, with their indices shifted
    const contour = contourGraph(contours, rng);
    const picked = linkNodes.concat(contour.nodes);
    for (const [a, b] of contour.segs) segs.push([a + linkNodes.length, b + linkNodes.length]);

    this.lineGeometry = packSegments(picked, segs, rng);
    this.lineMaterial = createParticleMaterial(uniforms, false);
    this.lines = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.lines.frustumCulled = false;

    this.sparkGeometry = buildSparks(picked, segs, cfg.sparks, rng);
    this.sparkMaterial = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: sparkVertex,
      fragmentShader: sparkFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparks = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
    this.sparks.frustumCulled = false;

    this.segmentCount = segs.length;
  }

  dispose() {
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
  }
}
