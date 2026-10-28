/**
 * Sleeping mode: extremely dim eyes, slowed ambient activity.
 * Does not replace the hologram design — layers on existing uniforms.
 */
export class SleepEffect {
  constructor(uniforms, eyes) {
    this.u = uniforms;
    this.eyes = eyes;
    this.active = false;
    this.blend = 0; // 0 awake → 1 sleeping
    this._savedGain = 1;
    this._savedSpeed = null;
  }

  setSleeping(on) {
    if (on && !this.active) {
      this._savedGain = this.eyes?.gain ?? 1;
      if (this.u?.uSpeed) this._savedSpeed = this.u.uSpeed.value;
    }
    this.active = !!on;
  }

  update(dt) {
    const target = this.active ? 1 : 0;
    this.blend += (target - this.blend) * (1 - Math.exp(-dt * 2.2));
    if (!this.eyes) return;
    // Dim eyes strongly while asleep; restore gain when fully awake
    if (this.blend > 0.02) {
      this.eyes.setGain(this._savedGain * (0.12 + 0.88 * (1 - this.blend)));
    } else if (!this.active) {
      this.eyes.setGain(this._savedGain);
    }
    // Soften neural / glitch / dust / particle speed while sleeping
    if (this.u && this.blend > 0.01) {
      const k = 1 - 0.75 * this.blend;
      this.u.uNeural.value *= k;
      this.u.uGlitchRate.value *= 1 - 0.85 * this.blend;
      this.u.uDust.value *= 1 - 0.7 * this.blend;
      if (this.u.uSpeed) {
        const base = this._savedSpeed ?? this.u.uSpeed.value;
        this.u.uSpeed.value = base * (1 - 0.72 * this.blend);
      }
    } else if (!this.active && this.u?.uSpeed && this._savedSpeed != null) {
      this.u.uSpeed.value = this._savedSpeed;
      this._savedSpeed = null;
    }
  }
}
