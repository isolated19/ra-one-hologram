import * as THREE from 'three';
import { DemoSpeechGenerator } from '../speech/DemoSpeechGenerator.js';
import { MOUTH_Y } from '../character/FaceParticles.js';

const vertexShader = /* glsl */ `
attribute float aU;       // -1..1 along the arc
attribute float aArc;     // 0, 1, 2
attribute float aRandom;
uniform float uTime;
uniform float uSpeed;
uniform float uListen;
uniform float uAudioIn;
uniform float uScale;
uniform float uPixelRatio;
uniform float uBrightness;
varying float vA;
void main() {
  float t = uTime * uSpeed;
  float env = pow(1.0 - aU * aU, 1.5);
  float level = 0.25 + uAudioIn * 1.4;
  vec3 pos = position;
  pos.y += sin(aU * (14.0 + aArc * 5.0) - t * (5.0 + aArc) + aArc * 2.1) * 0.03 * level * env;
  pos.y += (aRandom - 0.5) * 0.006;
  vA = uListen * env * (0.5 + 0.5 * level) * (1.0 - aArc * 0.25) * uBrightness;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(0.015 * uScale * uPixelRatio / max(-mv.z, 0.1), 24.0);
}
`;

const fragmentShader = /* glsl */ `
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float g = exp(-r * r * 30.0);
  gl_FragColor = vec4(vec3(1.0, 0.3, 0.36) * 2.4 * g * vA, g * vA);
}
`;

/**
 * Listening: waveform-like energy arcs in front of the lower face, driven by the
 * input level (uAudioIn). The level comes from the microphone analyser when a
 * developer enables it, otherwise from a simulated voice envelope. Convergence
 * and hood ripples are shader-side, keyed on uListen.
 */
export class ListeningEffect {
  constructor(uniforms, state) {
    this.u = uniforms;
    this.state = state;
    this.mic = null;
    this.simulatedVoice = false;
    this.generator = new DemoSpeechGenerator();
    this.level = 0;

    const perArc = 160;
    const n = perArc * 3;
    const pos = new Float32Array(n * 3);
    const aU = new Float32Array(n);
    const aArc = new Float32Array(n);
    const aRandom = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const arc = Math.floor(i / perArc);
      const u = ((i % perArc) / (perArc - 1)) * 2 - 1;
      const width = 0.34 + arc * 0.08;
      pos.set([u * width, MOUTH_Y - 0.18 - arc * 0.07 + 0.05 * u * u, 1.1 + arc * 0.03], i * 3);
      aU[i] = u;
      aArc[i] = arc;
      aRandom[i] = Math.random();
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    this.geometry.setAttribute('aArc', new THREE.BufferAttribute(aArc, 1));
    this.geometry.setAttribute('aRandom', new THREE.BufferAttribute(aRandom, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** Use a VoiceAmplitudeAnalyzer (e.g. microphone) as the input level; null for simulation. */
  setInputAnalyzer(analyzer) {
    this.mic = analyzer;
  }

  /** Simulated "user is talking" input, used by the demo interaction. */
  setSimulatedVoice(on) {
    this.simulatedVoice = on;
    if (on) this.generator.reset();
  }

  update(dt) {
    let target;
    if (this.mic) {
      target = this.mic.sample(dt);
    } else if (this.simulatedVoice) {
      target = this.generator.update(dt);
    } else {
      target = 0.08; // waiting: a faint carrier
    }
    this.level += (target - this.level) * (1 - Math.exp(-dt * 14));
    this.u.uAudioIn.value = this.level;
    this.points.visible = this.state.weights.listening > 0.01;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
