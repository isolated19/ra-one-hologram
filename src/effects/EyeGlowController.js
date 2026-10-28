/**
 * Eye expression. Combines the state's base intensity with state-specific motion:
 * thinking pulses rhythmically, listening holds a steady, attentive glow,
 * speaking follows the mouth amplitude. Gated by formation and faded by dissolve.
 *
 * setIntensity(v) overrides the state base (null returns control to the state);
 * setGain(v) scales the result (the "eye glow" slider).
 */
export class EyeGlowController {
  constructor(uniforms, state) {
    this.u = uniforms;
    this.state = state;
    this.override = null;
    this.gain = 1;
    this.value = 0;
  }

  setIntensity(v) {
    this.override = v === null || v === undefined ? null : Math.max(0, Math.min(1.5, v));
  }

  setGain(v) {
    this.gain = v;
  }

  update(dt, elapsed, formGate) {
    const w = this.state.weights;
    const u = this.u;
    let target = this.override ?? this.state.params.eye;
    target += w.thinking * 0.2 * (0.5 + 0.5 * Math.sin(elapsed * 3.2));          // processing rhythm
    target += w.speaking * 0.3 * u.uMouthOpen.value;                               // brightens with speech
    target += w.listening * 0.05 * Math.sin(elapsed * 1.3);                        // attentive shimmer
    target *= this.gain * formGate * (1 - u.uDissolve.value);

    this.value += (target - this.value) * (1 - Math.exp(-dt * 8));
    u.uEyeIntensity.value = this.value;
  }
}
