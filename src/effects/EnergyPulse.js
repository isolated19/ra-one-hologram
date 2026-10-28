/**
 * A band of brightness that climbs from the hem to the crown of the figure.
 * The shader multiplies particle brightness by this band.
 */
export class EnergyPulse {
  constructor(uniforms, duration = 1.6) {
    this.u = uniforms;
    this.duration = duration;
    this.t = -1;
  }

  trigger() {
    this.t = 0;
  }

  update(dt) {
    if (this.t < 0) return;
    this.t += dt;
    const x = this.t / this.duration;
    if (x >= 1) {
      this.t = -1;
      this.u.uPulseAmp.value = 0;
      this.u.uPulseY.value = -9;
      return;
    }
    this.u.uPulseY.value = -1.6 + x * 4.0;
    this.u.uPulseAmp.value = Math.sin(Math.PI * x) * 2.2;
  }
}
