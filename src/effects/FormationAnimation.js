function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Drives uForm from 0 to 1 over ~6.5 s. The shaders stagger each layer by its
 * aPhase: stars and dust, then the hood, the face, the neural links, and the
 * eyes last. onComplete fires once the figure has fully formed.
 */
export class FormationAnimation {
  constructor(uniform, duration = 6.5) {
    this.u = uniform;
    this.duration = duration;
    this.onComplete = null;
    this.restart();
  }

  restart() {
    this.time = 0;
    this.u.value = 0;
    this.active = true;
  }

  get done() {
    return !this.active;
  }

  update(dt) {
    if (!this.active) return;
    this.time += dt;
    const x = Math.min(this.time / this.duration, 1);
    this.u.value = easeInOutCubic(x);
    if (x >= 1) {
      this.active = false;
      this.onComplete?.();
    }
  }
}
