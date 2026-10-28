/**
 * Thinking: neural activity rises and breathes in a slow rhythm, with brief
 * glitch flickers around the face. Gathering clusters at the brow, the energy
 * wave through the hood and faster link pulses are shader-side, keyed on uThink
 * and uNeural. Everything is eased; no strobing.
 */
export class ThinkingEffect {
  constructor(uniforms, state) {
    this.u = uniforms;
    this.state = state;
    this.flicker = 0;
    this.nextFlicker = 0.8;
  }

  update(dt, elapsed) {
    const w = this.state.weights.thinking;
    const u = this.u;
    // Rhythmic processing: activity swells and eases at ~0.4 Hz
    u.uNeural.value *= 1 + w * 0.35 * Math.sin(elapsed * 2.4);

    this.nextFlicker -= dt;
    if (this.nextFlicker <= 0) {
      this.flicker = 0.15;
      this.nextFlicker = 0.6 + Math.random() * 1.4;
    }
    this.flicker = Math.max(0, this.flicker - dt);
    u.uGlitchRate.value += w * (this.flicker > 0 ? 2.5 : 0);
  }
}
