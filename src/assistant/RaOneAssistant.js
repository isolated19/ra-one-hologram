/**
 * RA-ONE public interface — the stable surface a future AI layer should call.
 * Available in the browser as `window.RAONE`.
 *
 *   assistant.setState('idle' | 'listening' | 'thinking' | 'speaking', meta?)
 *   assistant.getState()
 *   assistant.on(event, fn) → unsubscribe
 *       'change'   ({ from, to, meta })      any state change
 *       'idle' | 'listening' | 'thinking' | 'speaking'
 *       'ready'    ()                        formation finished
 *       'dissolve' ({ dissolved })           dissolve toggled
 *
 *   assistant.setSpeechAmplitude(0..1 | null)  drive the mouth from your TTS; null releases it
 *   assistant.connectAudioSource(source, { audible })
 *       analyse an <audio>/<video> element, an AudioNode or a MediaStream for mouth motion
 *   assistant.startDemoSpeech() / assistant.stopSpeech()
 *   assistant.setEyeIntensity(0..1.5 | null)   override eye brightness; null returns it to the state
 *   assistant.playEnergyPulse()
 *   assistant.form()                           replay the formation sequence
 *   assistant.dissolve(true | false)           scatter into dust / reform
 *
 * Nothing here talks to an AI service. The visuals run independently.
 */
export class RaOneAssistant {
  constructor({ state, character, speech }) {
    this.state = state;
    this.character = character;
    this.speech = speech;
    this.listeners = new Map();
    this.ready = false;
    character.formation.onComplete = () => {
      this.ready = true;
      this.emit('ready');
    };
  }

  setState(name, meta) {
    return this.state.setState(name, meta);
  }

  getState() {
    return this.state.getState();
  }

  on(event, fn) {
    if (['change', 'idle', 'listening', 'thinking', 'speaking'].includes(event)) return this.state.on(event, fn);
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  setSpeechAmplitude(v) {
    this.speech.setExternalAmplitude(v);
  }

  connectAudioSource(source, opts) {
    return this.speech.connectSource(source, opts);
  }

  startDemoSpeech() {
    this.speech.startDemo();
  }

  stopSpeech() {
    this.speech.stop();
  }

  setEyeIntensity(v) {
    this.character.eyes.setIntensity(v);
  }

  playEnergyPulse() {
    this.character.pulse.trigger();
  }

  form() {
    this.ready = false;
    if (this.character.dissolve.target > 0.5) this.dissolve(false);
    this.character.formation.restart();
  }

  /** @param {boolean} [on] omit to toggle */
  dissolve(on) {
    const d = this.character.dissolve;
    const want = on ?? d.target < 0.5;
    if ((d.target > 0.5) !== want) d.toggle();
    this.emit('dissolve', { dissolved: want });
    return want;
  }

  get dissolved() {
    return this.character.dissolve.target > 0.5;
  }
}
