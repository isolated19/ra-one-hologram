/**
 * Idle ambience: occasional short holographic glitch bursts on top of the
 * ambient glitch rate. Breathing, drifting dust and the energy flow across the
 * face are in the particle shader and run in every state.
 */
export class IdleEffect {
  constructor(uniforms, state) {
    this.u = uniforms;
    this.state = state;
    this.nextBurst = 4;
    this.burst = 0;
    this.reducedMotion = false;
  }

  update(dt) {
    this.nextBurst -= dt;
    if (this.nextBurst <= 0) {
      this.burst = 0.25;
      this.nextBurst = 4 + Math.random() * 5;
    }
    this.burst = Math.max(0, this.burst - dt);
    const idle = this.state.weights.idle;
    if (!this.reducedMotion) this.u.uGlitchRate.value += idle * (this.burst > 0 ? 4 : 0);
  }
}
