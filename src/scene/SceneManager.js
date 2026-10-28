import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { CameraController } from './CameraController.js';

// 2D stand-in shown when WebGL is unavailable: the hood, the eyes and a halo, animated in CSS
const FALLBACK_SVG = `
<svg viewBox="0 0 200 240" aria-hidden="true">
  <circle class="ra-fb-halo" cx="100" cy="105" r="92" />
  <path class="ra-fb-hood" d="M100 8 C62 52 40 96 38 150 C36 190 20 214 6 236 H194 C180 214 164 190 162 150 C160 96 138 52 100 8 Z" />
  <path class="ra-fb-face" d="M100 66 C82 92 70 118 70 146 C70 172 84 192 100 198 C116 192 130 172 130 146 C130 118 118 92 100 66 Z" />
  <path class="ra-fb-eye" d="M78 132 L94 136 L80 140 Z" />
  <path class="ra-fb-eye" d="M122 132 L106 136 L120 140 Z" />
  <path class="ra-fb-mouth" d="M90 172 H110" />
</svg>`;

/**
 * Owns the renderer, scene, camera and post-processing (bloom + vignette + optional SMAA).
 * Background is pure black. Bloom is configurable and can be switched off; with bloom and
 * SMAA both off it renders straight to the canvas (no post-processing passes at all).
 *
 * If WebGL can't start, `supported` is false: the scene graph still exists (so the
 * assistant keeps working) but nothing is rendered and a CSS emblem stands in.
 */
export class SceneManager {
  constructor(container) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
    this.bloomStrength = 0.6;
    this.bloomScale = 1;
    this.insets = { top: 0, bottom: 0 };
    this.contextLost = false;

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: false,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      console.warn('[RA-ONE] WebGL unavailable, running in lite mode:', err.message);
      this.renderer = null;
    }
    this.supported = !!this.renderer;

    if (!this.supported) {
      this.fallback = document.createElement('div');
      this.fallback.className = 'ra-fallback';
      this.fallback.dataset.state = 'idle';
      this.fallback.setAttribute('role', 'img');
      this.fallback.setAttribute('aria-label', 'RA-ONE (lite mode: 3D view unavailable on this device)');
      this.fallback.innerHTML = FALLBACK_SVG;
      container.appendChild(this.fallback);
      this.cameraController = new CameraController(this.camera, this.fallback);
      this.resize();
      return;
    }

    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.domElement.setAttribute('aria-label', 'RA-ONE hologram');
    container.appendChild(this.renderer.domElement);
    this.cameraController = new CameraController(this.camera, this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Only the brightest parts (eye cores, rims, energy nodes) should bloom
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.45, 0.32);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.0;
    this.vignette.uniforms.darkness.value = 1.15;
    this.composer.addPass(this.vignette);
    this.smaa = new SMAAPass(innerWidth, innerHeight);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());

    // Context loss: stop rendering until the browser restores the context
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
    });

    this.resize();
  }

  get pixelRatio() {
    return this.renderer?.getPixelRatio() ?? 1;
  }

  /** True when no post-processing pass is needed, so frames skip the composer. */
  get direct() {
    return !this.bloom.enabled && !this.smaa.enabled;
  }

  /** maxRatio is capped by the device's own pixel ratio. */
  setPixelRatio(maxRatio) {
    if (!this.supported) return;
    const ratio = Math.min(window.devicePixelRatio || 1, maxRatio);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.resize();
  }

  setBloomStrength(v) {
    this.bloomStrength = v;
    if (this.supported) this.bloom.strength = v * this.bloomScale;
  }

  setBloom(enabled, scale = this.bloomScale) {
    this.bloomScale = scale;
    if (!this.supported) return;
    this.bloom.enabled = enabled;
    this.bloom.strength = this.bloomStrength * scale;
    document.body.classList.toggle('ra-direct', this.direct);
  }

  setAntialias(enabled) {
    if (!this.supported) return;
    this.smaa.enabled = enabled;
    document.body.classList.toggle('ra-direct', this.direct);
  }

  /** Lite mode only: lets the CSS emblem react to the assistant state. */
  setFallbackState(name) {
    if (this.fallback) this.fallback.dataset.state = name;
  }

  setInsets(insets) {
    this.insets = insets;
    this.resize();
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.camera.aspect = w / h;
    if (this.supported) {
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
    } else {
      // Centre the emblem in the band the UI leaves free
      this.fallback.style.top = `${this.insets.top}px`;
      this.fallback.style.bottom = `${this.insets.bottom}px`;
    }
    this.cameraController.fit(w, h, this.insets);
  }

  render() {
    if (!this.supported || this.contextLost) return;
    this.cameraController.update();
    if (this.direct) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
}
