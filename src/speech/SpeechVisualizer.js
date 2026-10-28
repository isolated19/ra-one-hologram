import { DemoSpeechGenerator } from './DemoSpeechGenerator.js';
import { VoiceAmplitudeAnalyzer } from './VoiceAmplitudeAnalyzer.js';

/**
 * Chooses where the mouth amplitude comes from and feeds MouthController.
 *
 * Modes:
 *   'off'      silent; the mouth settles closed
 *   'demo'     synthetic speech envelope (not lip-sync)
 *   'audio'    real amplitude of a connected source (test file, element, node, stream)
 *   'external' a value pushed with setExternalAmplitude() (e.g. from a TTS engine)
 *
 * intensity scales whatever the source produces (the "speech intensity" slider).
 */
export class SpeechVisualizer {
  constructor(mouth) {
    this.mouth = mouth;
    this.mode = 'off';
    this.intensity = 1;
    this.external = 0;
    this.demo = new DemoSpeechGenerator();
    this.analyzer = new VoiceAmplitudeAnalyzer();
    this.testAudio = null;
    this.testUrl = null;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  setIntensity(v) {
    this.intensity = v;
  }

  startDemo() {
    this.demo.reset();
    this.mode = 'demo';
  }

  stop() {
    this.mode = 'off';
  }

  /** Push an amplitude (0..1) from an external engine; null returns to 'off'. */
  setExternalAmplitude(v) {
    if (v === null || v === undefined) {
      this.mode = 'off';
      return;
    }
    this.external = Math.max(0, Math.min(1, v));
    this.mode = 'external';
  }

  /** Analyse any audio source: an <audio>/<video> element, an AudioNode or a MediaStream. */
  async connectSource(source, opts) {
    if (source instanceof HTMLMediaElement) this.analyzer.connectMediaElement(source, opts);
    else if (source instanceof MediaStream) await this.analyzer.connectStream(source, opts);
    else this.analyzer.connectNode(source, opts);
    this.mode = 'audio';
  }

  // --- Local test audio (developer panel) -----------------------------------

  loadTestAudio(file) {
    this.stopTestAudio();
    if (this.testUrl) URL.revokeObjectURL(this.testUrl);
    this.testUrl = URL.createObjectURL(file);
    if (!this.testAudio) {
      this.testAudio = new Audio();
      this.testAudio.addEventListener('ended', () => {
        this.mode = 'off';
        this.emit('test-audio', 'ended');
      });
    }
    this.testAudio.src = this.testUrl;
    this.emit('test-audio', 'loaded');
  }

  async playTestAudio() {
    if (!this.testAudio) return false;
    // Connecting must happen after a user gesture (AudioContext autoplay policy)
    this.analyzer.connectMediaElement(this.testAudio, { audible: true });
    await this.testAudio.play();
    this.mode = 'audio';
    this.emit('test-audio', 'playing');
    return true;
  }

  pauseTestAudio() {
    if (!this.testAudio) return;
    this.testAudio.pause();
    this.mode = 'off';
    this.emit('test-audio', 'paused');
  }

  stopTestAudio() {
    if (!this.testAudio) return;
    this.testAudio.pause();
    this.testAudio.currentTime = 0;
    if (this.mode === 'audio') this.mode = 'off';
    this.emit('test-audio', 'stopped');
  }

  update(dt) {
    let amp = 0;
    if (this.mode === 'demo') amp = this.demo.update(dt);
    else if (this.mode === 'external') amp = this.external;
    // The analyser keeps decaying smoothly even after a source stops
    const analysed = this.analyzer.sample(dt);
    if (this.mode === 'audio') amp = analysed;
    this.mouth.setTarget(amp * this.intensity);
    this.mouth.update(dt);
  }
}
