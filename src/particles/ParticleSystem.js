import * as THREE from 'three';
import vertexSrc from '../shaders/particle.vert.glsl?raw';
import fragmentSrc from '../shaders/particle.frag.glsl?raw';
import noiseSrc from '../shaders/noise.glsl?raw';
import { buildHoodParticles } from '../character/HoodGeometry.js';
import { buildFaceParticles } from '../character/FaceParticles.js';
import { buildDust, buildNebula } from './CosmicDust.js';
import { mulberry32, makeParticle } from '../utils/math.js';

/**
 * Graphics presets. Particle budgets are targets; maxPixelRatio is capped by the
 * device's own ratio. Nebula sprites are large (fill-rate heavy), so they are a
 * small fixed count rather than a share of the total. SMAA smooths the neural
 * links and mask edges (the renderer has no MSAA); it is off on Low to save fill rate.
 * Minimal is for machines without a usable GPU (CPU/software rendering): no bloom,
 * no halo, sub-native resolution and a 30 fps cap (brightness makes up for the missing
 * bloom). fpsCap 0 means uncapped.
 */
export const PRESETS = {
  minimal: { name: 'Minimal', total: 8000, connections: 200, sparks: 30, nebula: 0, maxPixelRatio: 0.75, bloom: false, bloomScale: 0.7, smaa: false, halo: false, fpsCap: 30, brightness: 2.3 },
  low: { name: 'Low', total: 24000, connections: 700, sparks: 90, nebula: 30, maxPixelRatio: 1, bloom: true, bloomScale: 0.85, smaa: false, halo: true, fpsCap: 0 },
  medium: { name: 'Medium', total: 45000, connections: 1600, sparks: 220, nebula: 80, maxPixelRatio: 1.25, bloom: true, bloomScale: 1, smaa: true, halo: true, fpsCap: 0 },
  high: { name: 'High', total: 100000, connections: 3000, sparks: 420, nebula: 150, maxPixelRatio: 2, bloom: true, bloomScale: 1.15, smaa: true, halo: true, fpsCap: 0 },
};

/** Shared material builder for the points (particles) and line segments (neural links). */
export function createParticleMaterial(uniforms, isPoints) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPoints: { value: isPoints ? 1 : 0 } },
    vertexShader: noiseSrc + vertexSrc,
    fragmentShader: noiseSrc + fragmentSrc,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * All point layers in one buffer (one draw call):
 * A structural (hood, face, neck), B micro dust, D energy nodes,
 * E nebula, F drift clusters (inside the hood layer), G glitch (per-particle flag).
 */
export function buildParticleData(cfg, seed) {
  const rng = mulberry32(seed);
  const total = cfg.total;
  const eyes = Math.max(200, Math.round(total * 0.008));
  const hood = Math.round(total * 0.44);
  const face = Math.round(total * 0.26);
  const dust = total - hood - face - eyes;
  const parts = [
    ...buildHoodParticles(hood, rng),
    ...buildFaceParticles(face, eyes, rng),
    ...buildDust(dust, rng),
    ...buildNebula(cfg.nebula, rng),
  ];

  // Layer D: energy nodes — brighter copies of well-lit structural particles
  const candidates = parts.filter((p) => (p.kind === 0 || p.kind === 1) && p.bright > 0.5);
  const nodeCount = Math.round(total * 0.006);
  for (let i = 0; i < nodeCount && candidates.length; i++) {
    const c = candidates[Math.floor(rng() * candidates.length)];
    parts.push(makeParticle(rng, c.x, c.y, c.z + 0.004, 7, 1.1 + rng() * 0.6, 0.018 + rng() * 0.012, c.phase + 0.15));
  }
  return parts;
}

/** Packs particle records into typed-array attributes. */
function packPoints(parts) {
  const n = parts.length;
  const position = new Float32Array(n * 3);
  const aStart = new Float32Array(n * 3);
  const aDir = new Float32Array(n * 3);
  const aPhase = new Float32Array(n);
  const aRandom = new Float32Array(n);
  const aSize = new Float32Array(n);
  const aBright = new Float32Array(n);
  const aKind = new Float32Array(n);
  const aGlitch = new Float32Array(n);
  const aSeq = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const p = parts[i];
    position.set([p.x, p.y, p.z], i * 3);
    aStart.set([p.sx, p.sy, p.sz], i * 3);
    aDir.set([p.dx, p.dy, p.dz], i * 3);
    aPhase[i] = p.phase;
    aRandom[i] = p.random;
    aSize[i] = p.size;
    aBright[i] = p.bright;
    aKind[i] = p.kind;
    aGlitch[i] = p.glitch;
    aSeq[i] = p.seq ?? 0;
  }

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

export class ParticleSystem {
  constructor(uniforms, cfg, seed = 1337) {
    const parts = buildParticleData(cfg, seed);
    // Hood and face particles are the candidates for neural links
    this.nodes = parts.filter((p) => p.kind < 1.5 && p.bright > 0.6);
    this.count = parts.length;
    this.geometry = packPoints(parts);
    this.material = createParticleMaterial(uniforms, true);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
