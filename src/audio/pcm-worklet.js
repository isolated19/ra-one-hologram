/**
 * AudioWorklet: mic Float32 → 16 kHz mono PCM16, posted as 20 ms frames (640 bytes).
 * Runs on the audio thread, so it keeps working when the window is hidden.
 * Loaded via audioWorklet.addModule() — must stay import-free.
 */
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz

class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a global in AudioWorkletGlobalScope
    this.ratio = sampleRate / TARGET_RATE;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.fill = 0;
    this.pos = 0; // fractional read position for downsampling
    this.enabled = true;
    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'enable') this.enabled = !!ev.data.value;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || !this.enabled) return true;

    if (this.ratio === 1) {
      for (let i = 0; i < channel.length; i++) this._push(channel[i]);
      return true;
    }
    // Box-filter decimation: average the source samples that map onto each output sample
    while (this.pos < channel.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(channel.length, Math.floor(this.pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i];
      this._push(end > start ? sum / (end - start) : channel[start]);
      this.pos += this.ratio;
    }
    this.pos -= channel.length;
    return true;
  }

  _push(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.frame[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.fill === FRAME_SAMPLES) {
      const out = this.frame.buffer.slice(0);
      this.port.postMessage(out, [out]);
      this.fill = 0;
    }
  }
}

registerProcessor('pcm16-capture', Pcm16CaptureProcessor);
