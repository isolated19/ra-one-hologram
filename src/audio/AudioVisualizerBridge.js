/**
 * Bridges voice pipeline amplitudes into SpeechVisualizer / mouth without
 * owning a second render loop — call update() from the existing frame loop.
 */
export class AudioVisualizerBridge {
  /**
   * @param {{ speech: import('../speech/SpeechVisualizer.js').SpeechVisualizer }} opts
   */
  constructor({ speech }) {
    this.speech = speech;
    this.mode = 'off'; // off | simulated | analyser
    this._envelope = null;
    this._analyser = null;
    this._data = null;
  }

  useSimulated(envelope) {
    this._envelope = envelope;
    this.mode = 'simulated';
    this.speech.setExternalAmplitude(0);
  }

  useAnalyser(analyser) {
    this._analyser = analyser;
    this._data = new Uint8Array(analyser.frequencyBinCount);
    this.mode = 'analyser';
  }

  clear() {
    this.mode = 'off';
    this._envelope = null;
    this._analyser = null;
    this._data = null;
    this.speech.setExternalAmplitude(null);
  }

  update() {
    if (this.mode === 'simulated' && this._envelope) {
      this.speech.setExternalAmplitude(this._envelope.update());
      return;
    }
    if (this.mode === 'analyser' && this._analyser && this._data) {
      this._analyser.getByteTimeDomainData(this._data);
      let sum = 0;
      for (let i = 0; i < this._data.length; i++) {
        const v = (this._data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this._data.length);
      this.speech.setExternalAmplitude(Math.min(1, rms * 3.2));
    }
  }
}
