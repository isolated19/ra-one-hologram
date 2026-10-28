import * as THREE from 'three';
import noiseSrc from '../shaders/noise.glsl?raw';
import { OPENING } from '../character/HoodGeometry.js';

const f = (v) => v.toFixed(4);

// GLSL twin of openingE() in HoodGeometry.js, compiled from the same constants
const openingGlsl = /* glsl */ `
float openingE(vec2 p) {
  float v = (p.y - (${f(OPENING.yBottom)})) / ${f(OPENING.yTop - OPENING.yBottom)};
  if (v <= 0.0 || v >= 1.0) return 2.0;
  float s = clamp(v / 0.14, 0.0, 1.0);
  float hw = ${f(OPENING.width)} * (1.0 - pow(max(0.0, (v - 0.45) / 0.55), 1.3)) * sqrt(s * (2.0 - s));
  return abs(p.x - ${f(OPENING.skew)} * v) / max(hw, 1e-4);
}
`;

/**
 * Mesh hologram shader, adapted from Anderson Mancini's HolographicMaterial
 * (github.com/ektogamat/threejs-vanilla-holographic-material, MIT):
 * fresnel rim + screen-space scanlines + signal flicker over a faint body.
 *
 * Additions for this scene: a bottom-to-top reveal driven by uForm, noise
 * dissolve, the energy pulse band, horizontal glitch slices, and an optional
 * face-opening cut (used by the hood) with a bright edge around it.
 */
const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vPositionW;
varying vec4 vClip;
varying float vUvY;

void main() {
  vec3 pos = position;

  // Glitch: occasionally a thin horizontal slice of the hologram shifts sideways
  float t = uTime * uSpeed;
  float tick = floor(t * 7.0);
  float on = step(0.92, hash12(vec2(tick, 3.7)));
  float sliceY = mix(-1.6, 2.2, hash12(vec2(tick, 9.1)));
  float inSlice = step(abs(position.y - sliceY), 0.09);
  pos.x += on * inSlice * (hash12(vec2(tick, 1.3)) - 0.5) * 0.18;

  vObj = position;
  vUvY = uv.y;
  vec4 world = modelMatrix * vec4(pos, 1.0);
  vPositionW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vClip = projectionMatrix * viewMatrix * world;
  gl_Position = vClip;
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uForm;
uniform float uDissolve;
uniform float uPulseY;
uniform float uPulseAmp;
uniform float uBrightness;
uniform float uThink;

uniform vec3 hologramColor;
uniform float fresnelAmount;
uniform float fresnelOpacity;
uniform float scanlineSize;
uniform float signalSpeed;
uniform float hologramBrightness;
uniform float hologramOpacity;
uniform float bodyAmount;
uniform bool enableBlinking;
uniform bool blinkFresnelOnly;
uniform bool cutFace;
uniform bool concealOutsideOpening;

varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vPositionW;
varying vec4 vClip;
varying float vUvY;

float flicker(float amt, float time) { return clamp(fract(cos(time) * 43758.5453123), amt, 1.0); }
float random(float a, float b) { return fract(cos(dot(vec2(a, b), vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  // Face opening of the hood: a pointed arch on the front, with a glowing lip
  float edge = 0.0;
  float e = openingE(vObj.xy);
  if (cutFace && vObj.z > 0.0) {
    if (e < 1.0) discard;
    edge = exp(-pow((e - 1.0) * 16.0, 2.0)) * smoothstep(0.1, 0.5, vObj.z);
  }

  // Reveal: the hologram is "printed" from hem to crown as the figure forms
  float reveal = smoothstep(0.3, 0.95, uForm);
  float front = mix(-1.9, 2.6, reveal);
  if (vObj.y > front) discard;
  float printLine = exp(-pow((front - vObj.y) * 14.0, 2.0)) * (1.0 - step(0.999, reveal));

  // Dissolve: noise-driven break-up
  float n = vnoise(vObj * 9.0);
  if (n < uDissolve * 1.05) discard;
  float burn = smoothstep(uDissolve * 1.05 + 0.08, uDissolve * 1.05, n) * step(0.001, uDissolve);

  float t = uTime * uSpeed;
  vec2 sUv = fract((vClip.xy / vClip.w) * 0.5 + 0.5);

  // Body colour (reference: alpha mixes brightness with uv.y)
  vec4 holo = vec4(hologramColor, mix(hologramBrightness, vUvY, 0.5));

  // Scanlines (from the reference)
  float scan = 10.0;
  scan += 20.0 * sin(t * signalSpeed * 20.8 - sUv.y * 60.0 * scanlineSize);
  scan *= smoothstep(1.3 * cos(t * signalSpeed + sUv.y * scanlineSize), 0.78, 0.9);
  scan *= max(0.25, sin(t * signalSpeed));
  float r = random(vObj.x, vObj.y);
  float b = random(vObj.y * 0.9, vObj.y * 0.2);
  holo.rgb += hologramColor * (r + b) * 0.5 * scan / 84.0;
  // Fine horizontal raster lines drifting upward, the classic projector look
  float raster = 0.6 + 0.4 * sin(gl_FragCoord.y * 1.6 - t * 6.0);
  // Inner (back) faces are dimmer so the hollow of the hood reads as depth
  vec3 body = holo.rgb * holo.a * bodyAmount * raster * (gl_FrontFacing ? 1.0 : 0.35);

  // Fresnel rim (two-sided: back faces flip their normal)
  vec3 nrm = normalize(vNormalW) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 viewDir = normalize(cameraPosition - vPositionW);
  float fres = dot(viewDir, nrm) * (1.6 - fresnelOpacity / 2.0);
  fres = clamp(fresnelAmount - fres, 0.0, fresnelOpacity);
  vec3 rimColor = mix(hologramColor, vec3(1.0, 0.75, 0.72), 0.35);

  float blink = flicker(enableBlinking ? 0.6 - signalSpeed : 1.0, t * signalSpeed * 0.02);
  vec3 col = blinkFresnelOnly
    ? body + rimColor * fres * blink
    : body * blink + rimColor * fres;

  // Energy pulse band and the extra edges
  float band = exp(-pow((vObj.y - uPulseY) * 2.8, 2.0)) * uPulseAmp;
  float wave = mod(t * 0.5, 4.6) - 1.9;   // same thinking wave as the particles
  band += exp(-pow((vObj.y - wave) * 3.0, 2.0)) * uThink * 0.8;
  col *= 1.0 + band;
  // Parts of the face outside the opening are hidden in the hood's shadow
  if (concealOutsideOpening) col *= mix(0.015, 1.0, smoothstep(1.12, 0.94, e));
  col += rimColor * (edge * 0.9 + printLine * 1.6 + burn * 1.4);
  // The projection fades out toward the hem instead of ending on a hard edge
  col *= smoothstep(-1.75, -0.9, vObj.y);

  gl_FragColor = vec4(max(col, 0.0) * uBrightness, hologramOpacity);
}
`;

export class HolographicMaterial extends THREE.ShaderMaterial {
  /**
   * @param {object} shared - uniforms shared with the particle system (uTime, uForm, ...)
   * @param {object} params - look parameters; names follow the reference material
   */
  constructor(shared, params = {}) {
    super({
      vertexShader: noiseSrc + vertexShader,
      fragmentShader: noiseSrc + openingGlsl + fragmentShader,
      uniforms: {
        ...shared,
        hologramColor: { value: new THREE.Color(params.hologramColor ?? '#ff2448') },
        fresnelAmount: { value: params.fresnelAmount ?? 0.7 },
        fresnelOpacity: { value: params.fresnelOpacity ?? 1.0 },
        scanlineSize: { value: params.scanlineSize ?? 3.7 },
        signalSpeed: { value: params.signalSpeed ?? 0.18 },
        hologramBrightness: { value: params.hologramBrightness ?? 1.6 },
        hologramOpacity: { value: params.hologramOpacity ?? 0.7 },
        bodyAmount: { value: params.bodyAmount ?? 0.22 },
        enableBlinking: { value: params.enableBlinking ?? true },
        blinkFresnelOnly: { value: params.blinkFresnelOnly ?? true },
        cutFace: { value: params.cutFace ?? false },
        concealOutsideOpening: { value: params.concealOutsideOpening ?? false },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: params.side ?? THREE.DoubleSide,
    });
  }
}
