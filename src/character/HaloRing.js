import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Polar HUD drawn on a single quad: a main ring, a rotating tick scale and
// three inner arcs. Every layer is keyed on the shared state uniforms.
const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uForm;
uniform float uDissolve;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uMouthOpen;
uniform float uAudioIn;
uniform float uBrightness;
varying vec2 vUv;

const float TAU = 6.2831853;

// Explicit square: pow() is undefined for negative bases and can return NaN, which bloom smears across the screen
float line(float r, float r0, float w) { float d = (r - r0) / w; return exp(-d * d); }

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // Everything lives in the outer band; this also keeps atan() away from the undefined centre
  if (r > 1.0 || r < 0.6) discard;
  float a = atan(p.x, p.y);                 // 0 at the top, ±PI at the bottom
  float t = uTime * uSpeed;

  // Draws on from the crown in both directions as the figure finishes forming
  float reveal = smoothstep(0.78, 1.0, uForm);
  float gate = step(abs(a) / 3.14159, reveal) * (1.0 - uDissolve);
  if (gate <= 0.0) discard;

  // Main ring: ripples while listening (stronger with mic input), breathes with the voice
  float ripple = sin(a * 6.0 - t * 4.0) * 0.012 * uListen * (0.4 + uAudioIn);
  float r0 = 0.86 + ripple + 0.012 * uSpeak * uMouthOpen;
  float ring = line(r, r0, 0.006) * 0.9 + line(r, r0, 0.05) * 0.08;

  // Tick scale: 60 ticks (every fifth one longer), creeping round, faster while thinking
  float u = (a + t * 0.04 * (1.0 + 4.0 * uThink)) / TAU * 60.0;
  float major = 1.0 - step(0.5, mod(floor(u), 5.0));
  float tick = step(0.82, fract(u)) * step(0.915, r) * step(r, mix(0.94, 0.965, major));

  // Inner arcs: three segments counter-rotating; they speed up and turn amber while thinking
  float arcs = step(0.55, fract((a - t * (0.12 + 1.1 * uThink)) / TAU * 3.0)) * line(r, 0.8, 0.004);

  vec3 crimson = vec3(1.0, 0.09, 0.27);
  vec3 pale = vec3(1.0, 0.54, 0.5);
  vec3 amber = vec3(1.0, 0.55, 0.12);
  vec3 base = mix(crimson, pale, uListen * 0.4);

  float energy = 0.55 + 0.25 * uListen + 0.3 * uThink + 0.5 * uSpeak * uMouthOpen;
  vec3 col = base * (ring + tick * 0.35) + mix(base, amber, uThink * 0.8) * arcs * (0.35 + 0.5 * uThink);
  // Fade the lower arc so it doesn't crowd the console
  col *= energy * gate * mix(0.12, 1.0, smoothstep(-0.9, -0.2, p.y));

  gl_FragColor = vec4(col * uBrightness, 1.0);
}
`;

/** A holographic HUD ring behind the head that reflects the assistant state. */
export class HaloRing {
  constructor(uniforms, { radius = 1.8, y = 0.5, z = -0.7 } = {}) {
    this.geometry = new THREE.PlaneGeometry(radius * 2, radius * 2);
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(0, y, z);
    this.mesh.renderOrder = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
