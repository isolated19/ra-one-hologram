/**
 * AudioWorklet: per-10 ms mic features (mean |x|, peak, zero-crossing rate) for the clap detector.
 * Runs on the audio thread, so clap wake keeps working when the window is hidden or minimised.
 * Loaded via audioWorklet.addModule() — must stay import-free.
 */
const FRAME_MS = 10;

class LevelMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate / currentTime are globals in AudioWorkletGlobalScope
    this.frameSamples = Math.max(32, Math.round((sampleRate * FRAME_MS) / 1000));
    this.n = 0;
    this.sum = 0;
    this.peak = 0;
    this.zeroX = 0;
    this.prev = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      const a = Math.abs(v);
      this.sum += a;
      if (a > this.peak) this.peak = a;
      if ((this.prev >= 0 && v < 0) || (this.prev < 0 && v >= 0)) this.zeroX += 1;
      this.prev = v;
      if (++this.n === this.frameSamples) {
        this.port.postMessage({
          energy: this.sum / this.n,
          peak: this.peak,
          zcr: this.zeroX / this.n,
          t: currentTime * 1000,
        });
        this.n = 0;
        this.sum = 0;
        this.peak = 0;
        this.zeroX = 0;
      }
    }
    return true;
  }
}

registerProcessor('raone-level', LevelMeterProcessor);
