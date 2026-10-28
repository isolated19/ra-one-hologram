/**
 * Eases uDissolve toward 0 (formed) or 1 (dissolved). Calling toggle() again
 * reverses it, so the particles reform from wherever they are.
 */
export class DissolveAnimation {
  constructor(uniform, rate = 1.8) {
    this.u = uniform;
    this.rate = rate;
    this.target = 0;
  }

  toggle() {
    this.target = this.target > 0.5 ? 0 : 1;
    return this.target > 0.5;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * this.rate);
    this.u.value += (this.target - this.u.value) * k;
  }
}
