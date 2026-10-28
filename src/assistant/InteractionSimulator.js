import { mockReply, SAMPLE_VOICE_INPUTS } from './mockResponses.js';

class Cancelled extends Error {}

/**
 * Runs a simulated exchange: LISTENING → THINKING → SPEAKING → IDLE.
 * Every wait is cancellable; starting a new exchange cancels the running one.
 * Replace this class with a real pipeline (STT → LLM → TTS) later — the visuals
 * only depend on RaOneAssistant's methods.
 *
 * Hooks (all optional): onUserMessage(text), onReplyStart(), onReplyProgress(partialText),
 * onReplyEnd(text), onCancel().
 */
export class InteractionSimulator {
  constructor(assistant, listening, hooks = {}) {
    this.assistant = assistant;
    this.listening = listening;
    this.hooks = hooks;
    this.timers = new Set();
    this.token = null;
    this.voiceIndex = 0;
  }

  get running() {
    return this.token !== null;
  }

  _wait(ms, token) {
    return new Promise((resolve, reject) => {
      if (token.cancelled) return reject(new Cancelled());
      const id = setTimeout(() => {
        this.timers.delete(entry);
        token.cancelled ? reject(new Cancelled()) : resolve();
      }, ms);
      const entry = { id, reject };
      this.timers.add(entry);
    });
  }

  cancel({ toIdle = true } = {}) {
    if (!this.token) return;
    this.token.cancelled = true;
    this.token = null;
    for (const t of this.timers) {
      clearTimeout(t.id);
      t.reject(new Cancelled());
    }
    this.timers.clear();
    this.listening.setSimulatedVoice(false);
    this.assistant.stopSpeech();
    if (toIdle) this.assistant.setState('idle');
    this.hooks.onCancel?.();
  }

  /**
   * @param {{ text?: string, voice?: boolean }} input voice=true simulates spoken input
   */
  async run({ text, voice = false } = {}) {
    this.cancel({ toIdle: false });
    const token = { cancelled: false };
    this.token = token;
    const a = this.assistant;
    try {
      a.setState('listening', { simulated: true, voice });
      if (voice) {
        this.listening.setSimulatedVoice(true);
        await this._wait(2200, token);
        this.listening.setSimulatedVoice(false);
        text = text || SAMPLE_VOICE_INPUTS[this.voiceIndex++ % SAMPLE_VOICE_INPUTS.length];
      } else {
        await this._wait(650, token);
      }
      this.hooks.onUserMessage?.(text);

      a.setState('thinking', { simulated: true });
      await this._wait(1500 + Math.random() * 900, token);

      const reply = mockReply(text);
      a.setState('speaking', { simulated: true });
      a.startDemoSpeech();
      this.hooks.onReplyStart?.();
      // Reveal the reply at a speaking pace while the demo mouth animates
      const perChar = 48;
      for (let i = 1; i <= reply.length; i += 2) {
        this.hooks.onReplyProgress?.(reply.slice(0, i));
        await this._wait(perChar * 2, token);
      }
      this.hooks.onReplyProgress?.(reply);
      await this._wait(350, token);
      a.stopSpeech();
      this.hooks.onReplyEnd?.(reply);
      a.setState('idle');
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    } finally {
      if (this.token === token) this.token = null;
    }
  }
}
