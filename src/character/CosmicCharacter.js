import * as THREE from 'three';
import { ParticleSystem, PRESETS } from '../particles/ParticleSystem.js';
import { ParticleConnections } from '../particles/ParticleConnections.js';
import { FormationAnimation } from '../effects/FormationAnimation.js';
import { DissolveAnimation } from '../effects/DissolveAnimation.js';
import { EnergyPulse } from '../effects/EnergyPulse.js';
import { EyeGlowController } from '../effects/EyeGlowController.js';
import { IdleEffect } from '../effects/IdleEffect.js';
import { ListeningEffect } from '../effects/ListeningEffect.js';
import { ThinkingEffect } from '../effects/ThinkingEffect.js';
import { SleepEffect } from '../effects/SleepEffect.js';
import { WakeEffect } from '../effects/WakeEffect.js';
import { MouthController } from '../speech/MouthController.js';
import { HologramFigure } from './HologramFigure.js';
import { EyeCores } from './EyeCores.js';
import { HaloRing } from './HaloRing.js';
import { buildContours } from './Contours.js';
import { MOUTH_Y } from './FaceParticles.js';

// Uniforms shared by every material, so one update drives them all
export function createUniforms() {
  return {
    uTime: { value: 0 },
    uForm: { value: 0 },
    uDissolve: { value: 0 },
    uSpeed: { value: 1 },
    uPulseY: { value: -9 },
    uPulseAmp: { value: 0 },
    uDensity: { value: 1 },
    uScale: { value: 800 },
    uPixelRatio: { value: 1 },
    uBrightness: { value: 1 },
    uCamDist: { value: 9 },
    // assistant state
    uIdle: { value: 1 },
    uListen: { value: 0 },
    uThink: { value: 0 },
    uSpeak: { value: 0 },
    uNeural: { value: 0.3 },
    uGlitchRate: { value: 0.6 },
    uDust: { value: 0 },
    uAudioIn: { value: 0 },
    uMouthOpen: { value: 0 },
    uMouthY: { value: MOUTH_Y },
    uEyeIntensity: { value: 0 },
  };
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Owns the figure: particle layers, neural links, hologram surfaces, eyes, mouth, halo,
 * and the effects that translate assistant state into uniforms.
 * Only the particle buffers depend on the quality preset.
 */
export class CosmicCharacter {
  constructor(scene, fov, state) {
    this.fov = fov;
    this.state = state;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.uniforms = createUniforms();
    this.formation = new FormationAnimation(this.uniforms.uForm);
    this.dissolve = new DissolveAnimation(this.uniforms.uDissolve);
    this.pulse = new EnergyPulse(this.uniforms);

    this.figure = new HologramFigure(this.uniforms);
    this.eyeCores = new EyeCores(this.uniforms);
    this.halo = new HaloRing(this.uniforms);
    this.mouth = new MouthController(this.uniforms);
    this.eyes = new EyeGlowController(this.uniforms, state);
    this.idle = new IdleEffect(this.uniforms, state);
    this.listening = new ListeningEffect(this.uniforms, state);
    this.thinking = new ThinkingEffect(this.uniforms, state);
    this.sleepFx = new SleepEffect(this.uniforms, this.eyes);
    this.wakeFx = new WakeEffect(this.eyes, this.pulse);
    this.root.add(this.halo.mesh, this.figure.group, this.eyeCores.group, this.mouth.group, this.listening.points);

    this.contours = buildContours();
    this.rotateOn = false;
    this.lookTarget = new THREE.Vector2();
    this.lookStrength = 1;
    this.system = null;
    this.connections = null;
    this.presetName = null;
  }

  setPreset(name) {
    if (this.system) {
      this.root.remove(this.system.points);
      this.system.dispose();
    }
    if (this.connections) {
      this.root.remove(this.connections.lines, this.connections.sparks);
      this.connections.dispose();
    }
    const cfg = PRESETS[name];
    this.system = new ParticleSystem(this.uniforms, cfg);
    this.connections = new ParticleConnections(this.uniforms, this.system.nodes, cfg, this.contours);
    this.root.add(this.system.points, this.connections.lines, this.connections.sparks);
    this.halo.mesh.visible = cfg.halo;
    this.presetName = name;
  }

  // Point sizes are in world units; convert with the camera's vertical FOV
  setViewport(heightCss, pixelRatio) {
    this.uniforms.uPixelRatio.value = pixelRatio;
    this.uniforms.uScale.value = heightCss / (2 * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2));
  }

  setDensity(v) {
    this.uniforms.uDensity.value = v;
  }

  setSpeed(v) {
    this.uniforms.uSpeed.value = v;
  }

  /** Where the figure should look, in normalized screen space (-1..1, +y up); (0, 0) is straight ahead. */
  lookAt(x, y) {
    this.lookTarget.set(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  }

  update(dt, elapsed, cameraDistance) {
    const u = this.uniforms;
    u.uTime.value = elapsed;
    u.uCamDist.value = cameraDistance;
    this.formation.update(dt);
    this.dissolve.update(dt);
    this.pulse.update(dt);

    // State → base uniforms, then each effect layers its motion on top
    const { weights, params } = this.state;
    u.uIdle.value = weights.idle;
    u.uListen.value = weights.listening;
    u.uThink.value = weights.thinking;
    u.uSpeak.value = weights.speaking;
    u.uNeural.value = params.neural;
    u.uGlitchRate.value = params.glitch;
    u.uDust.value = params.dust;

    this.idle.update(dt, elapsed);
    this.listening.update(dt, elapsed);
    this.thinking.update(dt, elapsed);
    // Eyes ignite only once the whole figure has formed
    this.eyes.update(dt, elapsed, smoothstep(0.9, 1.0, u.uForm.value));
    this.sleepFx.update(dt);
    this.wakeFx.update(dt);
    this.eyeCores.update();

    // Auto-rotate: a gentle sway within the ±20° viewing range.
    // Gaze: the head turns toward the pointer, a little more when it's listening.
    const gaze = this.lookStrength * u.uForm.value * (1 - u.uDissolve.value) * (1 + 0.35 * weights.listening);
    const yaw = (this.rotateOn ? Math.sin(elapsed * 0.3) * 0.3 : 0) + this.lookTarget.x * 0.2 * gaze;
    const pitch = -this.lookTarget.y * 0.07 * gaze;
    const k = Math.min(1, dt * 2.5);
    this.root.rotation.y += (yaw - this.root.rotation.y) * k;
    this.root.rotation.x += (pitch - this.root.rotation.x) * k;
  }

  setSleeping(on) {
    this.sleepFx.setSleeping(!!on);
  }

  triggerWake() {
    this.sleepFx.setSleeping(false);
    this.wakeFx.trigger();
  }
}
