import * as THREE from 'three';
import noiseSrc from '../shaders/noise.glsl?raw';
import { EYE, faceDepth } from './FaceParticles.js';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// A sharp, slanted almond: outer corner raised, a heavy lid toward the nose.
// Red-white centre, crimson body, darker red glow around it.
const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uThink;
uniform float uEyeIntensity;
uniform float uSide;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  p.x *= uSide;                       // +x is the outer corner on both eyes
  p.y -= 0.22 * p.x;                  // slant
  float lidH = 0.36 * (1.0 - p.x * p.x);
  float top = lidH * mix(0.45, 1.0, 0.5 + 0.5 * p.x);
  float d = p.y > 0.0 ? p.y - top : -p.y - lidH * 0.75;

  float inside = smoothstep(0.03, -0.06, d);
  float core = exp(-(p.x * p.x * 5.0 + p.y * p.y * 60.0)) * inside;
  float halo = exp(-max(d, 0.0) * 7.0) * smoothstep(1.0, 0.5, abs(p.x)) * smoothstep(1.0, 0.35, abs(p.y));

  float t = uTime * uSpeed;
  float flick = 0.93 + 0.07 * sin(t * 13.0 + uSide) * sin(t * 7.3);
  float inner = 0.85 + 0.35 * vnoise(vec3(p * 6.0, t * 2.5)) * (0.3 + uThink);

  vec3 col = vec3(0.35, 0.0, 0.01) * halo * 0.8
           + mix(vec3(1.0, 0.09, 0.2), vec3(1.0, 0.42, 0.1), uThink * 0.45) * inside * 1.05 * inner
           + vec3(1.0, 0.78, 0.74) * core * 1.3;
  gl_FragColor = vec4(col * uEyeIntensity * flick, 1.0);
}
`;

/** The two eye cores, set into the sockets. Brightness comes from EyeGlowController. */
export class EyeCores {
  constructor(uniforms) {
    this.group = new THREE.Group();
    this.geometry = new THREE.PlaneGeometry(0.34, 0.2);
    this.materials = [-1, 1].map((side) => {
      const material = new THREE.ShaderMaterial({
        uniforms: { ...uniforms, uSide: { value: side } },
        vertexShader,
        fragmentShader: noiseSrc + fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      const x = side * EYE.x;
      mesh.position.set(x, EYE.y, (faceDepth(x, EYE.y) ?? 0.8) + 0.02);
      mesh.rotation.y = side * 0.25; // follow the curve of the face
      mesh.renderOrder = 3;
      this.group.add(mesh);
      return material;
    });
  }

  // Skip the draw entirely once the eyes are dark (dissolved or not yet formed)
  update() {
    this.group.visible = this.materials[0].uniforms.uEyeIntensity.value > 0.01;
  }

  dispose() {
    this.geometry.dispose();
    this.materials.forEach((m) => m.dispose());
  }
}
