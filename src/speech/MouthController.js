import * as THREE from 'three';
import noiseSrc from '../shaders/noise.glsl?raw';
import { MOUTH_Y, faceDepth } from '../character/FaceParticles.js';

// Shared by the mouth particles and its energy lines
const vertexShader = /* glsl */ `
attribute float aSide;    // +1 upper edge, -1 lower edge, 0 the slit itself
attribute float aU;       // -1..1 across the mouth
attribute float aRandom;
uniform float uTime;
uniform float uSpeed;
uniform float uForm;
uniform float uDissolve;
uniform float uSpeak;
uniform float uMouthOpen;
uniform float uScale;
uniform float uPixelRatio;
uniform float uBrightness;
varying float vBright;
varying float vHot;

void main() {
  float t = uTime * uSpeed;
  float open = uMouthOpen;
  float prof = pow(max(0.0, 1.0 - aU * aU), 1.2);
  vec3 pos = position;
  // The slit expands and contracts; edges shiver slightly while speaking
  pos.y += aSide * (open * 0.05 * prof + 0.003);
  pos.y += (vnoise(vec3(aU * 8.0, t * 6.0, aRandom * 10.0)) - 0.5) * 0.012 * open;
  pos.z += open * 0.01 * prof;

  // Density follows amplitude: extra particles only appear while sound is present
  float show = step(aRandom, 0.35 + 0.65 * clamp(open * 1.4 + uSpeak * 0.15, 0.0, 1.0));
  // Occasional horizontal scan across the slit
  float sweep = fract(t * 0.8) * 2.6 - 1.3;
  float scan = exp(-pow((aU - sweep) * 5.0, 2.0)) * uSpeak * 0.8 * step(0.5, fract(t * 0.35));

  float gate = smoothstep(0.8, 0.95, uForm) * (1.0 - uDissolve);
  vBright = (0.22 + 0.3 * uSpeak + open * 1.9 * prof + scan) * gate * show * uBrightness;
  vHot = open * prof;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = aSide == 0.0 ? 0.016 : 0.011;
  gl_PointSize = min(size * (1.0 + open * 0.5) * uScale * uPixelRatio / max(-mv.z, 0.1), 32.0);
}
`;

const pointsFragment = /* glsl */ `
varying float vBright;
varying float vHot;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float g = exp(-r * r * 36.0);
  vec3 col = mix(vec3(1.0, 0.09, 0.27), vec3(1.0, 0.62, 0.58), clamp(vHot, 0.0, 1.0));
  gl_FragColor = vec4(col * vBright * g * 1.4, g);
}
`;

const linesFragment = /* glsl */ `
varying float vBright;
varying float vHot;
void main() {
  gl_FragColor = vec4(vec3(1.0, 0.12, 0.25) * vBright, 0.35);
}
`;

/**
 * Holographic mouth: a horizontal energy slit of dense glowing particles and
 * thin red lines, set into the lower face. setTarget(amplitude) feeds it;
 * attack/release smoothing produces uMouthOpen, which also drives the jaw,
 * lip and speech-ring motion in the main particle shader.
 */
export class MouthController {
  constructor(uniforms, { attack = 0.04, release = 0.12 } = {}) {
    this.u = uniforms;
    this.attack = attack;
    this.release = release;
    this.target = 0;
    this.value = 0;
    this.group = new THREE.Group();

    const pts = [];
    const add = (u, side, r) => {
      const x = u * 0.19;
      const y = MOUTH_Y - 0.012 * u * u + side * 0.004;
      pts.push({ x, y, z: (faceDepth(x, y) ?? 0.9) + 0.012, u, side, r });
    };
    const perRow = 90;
    for (const side of [1, 0, -1]) {
      for (let i = 0; i < perRow; i++) add((i / (perRow - 1)) * 2 - 1, side, Math.random());
    }
    for (let i = 0; i < 260; i++) add(Math.random() * 2 - 1, Math.random() < 0.5 ? 0.5 : -0.5, Math.random());

    this.pointsGeometry = this._geometry(pts);
    const material = (fragmentShader) => new THREE.ShaderMaterial({
      uniforms,
      vertexShader: noiseSrc + vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.pointsMaterial = material(pointsFragment);
    this.points = new THREE.Points(this.pointsGeometry, this.pointsMaterial);

    // Energy lines: along the upper and lower edges, plus rungs across the slit
    const segs = [];
    const rows = pts.slice(0, perRow * 3);
    const row = (side) => rows.filter((p) => p.side === side);
    for (const side of [1, -1]) {
      const r = row(side);
      for (let i = 0; i < r.length - 1; i += 1) segs.push(r[i], r[i + 1]);
    }
    const up = row(1);
    const down = row(-1);
    for (let i = 6; i < perRow - 6; i += 9) segs.push(up[i], down[i]);
    this.linesGeometry = this._geometry(segs);
    this.linesMaterial = material(linesFragment);
    this.lines = new THREE.LineSegments(this.linesGeometry, this.linesMaterial);

    this.points.frustumCulled = false;
    this.lines.frustumCulled = false;
    this.group.add(this.lines, this.points);
  }

  _geometry(list) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(list.flatMap((p) => [p.x, p.y, p.z]), 3));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(list.map((p) => p.side), 1));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(list.map((p) => p.u), 1));
    geo.setAttribute('aRandom', new THREE.Float32BufferAttribute(list.map((p) => p.r), 1));
    return geo;
  }

  /** Normalized speech amplitude 0..1 (values above 1 are clamped). */
  setTarget(amplitude) {
    this.target = Math.max(0, Math.min(1, amplitude));
  }

  update(dt) {
    const tau = this.target > this.value ? this.attack : this.release;
    this.value += (this.target - this.value) * (1 - Math.exp(-dt / tau));
    this.u.uMouthOpen.value = this.value;
  }

  dispose() {
    this.pointsGeometry.dispose();
    this.linesGeometry.dispose();
    this.pointsMaterial.dispose();
    this.linesMaterial.dispose();
  }
}
