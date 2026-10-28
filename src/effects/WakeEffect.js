/**
 * Short wake flourish: eye brighten + optional energy pulse.
 */
export class WakeEffect {
  constructor(eyes, pulse) {
    this.eyes = eyes;
    this.pulse = pulse;
    this.timer = 0;
    this._baseGain = 1;
  }

  trigger() {
    this._baseGain = this.eyes?.gain ?? 1;
    this.timer = 1.1;
    try { this.pulse?.trigger?.(); } catch { /* ignore */ }
  }

  update(dt) {
    if (this.timer <= 0) return;
    this.timer = Math.max(0, this.timer - dt);
    const t = this.timer;
    // Gradual illumination then settle
    const boost = t > 0.55 ? (1.1 - t) * 1.4 : t * 0.9;
    if (this.eyes) this.eyes.setGain(this._baseGain * (1 + Math.max(0, boost)));
  }
}
