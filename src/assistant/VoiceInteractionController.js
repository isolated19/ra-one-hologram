/**
 * Hands-free lifecycle: sleeping → wake → listening → thinking → speaking → standby → sleep.
 * Uses existing AssistantStateManager for visuals (sleeping/standby → idle).
 */
import { AudioSessionManager } from '../audio/AudioSessionManager.js';
import { ClapDetector } from '../audio/ClapDetector.js';
import { WakeWordDetector } from '../audio/WakeWordDetector.js';
import { SpeechRecognitionService } from '../audio/SpeechRecognitionService.js';
import {
  SpeechSynthesisService,
  SimulatedSpeechEnvelope,
} from '../audio/SpeechSynthesisService.js';
import { AudioVisualizerBridge } from '../audio/AudioVisualizerBridge.js';
import { OfflineVoiceClient } from '../audio/OfflineVoiceClient.js';
import { ServerSttClient } from '../audio/ServerSttClient.js';
import { ConversationClient } from '../api/ConversationClient.js';
import { STT_PROVIDER } from '../api/config.js';
import { TestResponseService } from './TestResponseService.js';
import { IDENTITY, LIFECYCLE } from './identityConfig.js';
import { PipelineEvents } from './PipelineEvents.js';
import {
  matchSleepCommand,
  matchWakePhrase,
  toSpokenText,
  wakeAcknowledgement,
} from './nameNormalizer.js';

const VOICE_PHASES = ['sleeping', 'standby', 'listening', 'thinking', 'speaking', 'error'];

export class VoiceInteractionController {
  /**
   * @param {{
   *   assistant: import('./RaOneAssistant.js').RaOneAssistant,
   *   speech: import('../speech/SpeechVisualizer.js').SpeechVisualizer,
   *   character?: import('../character/CosmicCharacter.js').CosmicCharacter | null,
   *   backend?: import('../api/BackendClient.js').BackendClient | null,
   *   onUi?: (patch: object) => void,
   *   sttProvider?: 'server' | 'browser',
   *   sttClient?: ServerSttClient | null,
   * }} deps
   */
  constructor({
    assistant,
    speech,
    character = null,
    backend = null,
    onUi = () => {},
    sttProvider = STT_PROVIDER,
    sttClient = null,
  }) {
    this.assistant = assistant;
    this.speech = speech;
    this.character = character;
    this.backend = backend;
    this.onUi = onUi;

    this.phase = 'sleeping';
    this.handsFree = false;
    this.ttsEnabled = true;
    this.postSpeakCooldownMs = LIFECYCLE.POST_SPEAK_COOLDOWN_MS;
    this.standbyFollowupMs = LIFECYCLE.STANDBY_FOLLOWUP_MS;
    this._cooldownUntil = 0;
    this._activating = false;
    this._sessionGen = 0;
    this._standbyTimer = null;
    this._listeners = new Map();
    this._clapDebug = { confidence: 0, reason: 'idle' };
    /** () => { present, emotion, confidence } | null — camera mood, when tracking is on */
    this._moodProvider = null;

    this.session = new AudioSessionManager();
    this.clap = new ClapDetector({
      audioSession: this.session,
      cooldownMs: LIFECYCLE.CLAP_COOLDOWN_MS,
    });
    // Offline backend STT by default; Chrome Web Speech only when explicitly requested
    this.serverStt = sttProvider === 'server' ? (sttClient || new ServerSttClient()) : null;
    this.wake = new WakeWordDetector({ serverClient: this.serverStt });
    this.wake.debounceMs = LIFECYCLE.WAKE_DEBOUNCE_MS;
    this.stt = new SpeechRecognitionService({ serverClient: this.serverStt });
    this.tts = new SpeechSynthesisService();
    this.offlineVoice = new OfflineVoiceClient({ speech });
    this.useOfflineTts = true;
    this.voicePreset = 'raone_jarvis';
    /** Dev-only mock answers — never the default path when LLM is available. */
    this.useMockResponses = false;
    this.responses = new TestResponseService();
    this.conversation = new ConversationClient();
    this.pipeline = new PipelineEvents({
      onEvent: (ev) => this.emit('pipeline', ev),
    });
    this.envelope = new SimulatedSpeechEnvelope();
    this.bridge = new AudioVisualizerBridge({ speech });

    this.transcript = '';
    this.responseText = '';
    this.lastSource = null;
    this.lastError = null;
    this.micPermission = 'unknown';
    this.wakeStatus = 'off';
    this.uiStatus = 'SLEEPING';
    this.diagnostics = {
      stt: 'idle',
      llm: 'idle',
      tts: 'idle',
      ollama: 'unknown',
    };

    this._wire();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  _wire() {
    this.session.on('permission', ({ permission }) => {
      this.micPermission = permission;
      this._ui();
    });
    this.session.on('active', ({ active }) => {
      if (!active && this.handsFree) {
        this.handsFree = false;
        this._teardownDetectors();
        this._setPhase('sleeping');
      }
      this._ui();
    });
    this.session.on('error', ({ message }) => {
      this._setPhase('error', { message });
      this._ui({ error: message });
    });
    this.session.on('interrupted', () => {
      this._ui({ error: 'Microphone interrupted — recovering…' });
      if (this.handsFree) {
        this.session.enable().then(async () => {
          await this._attachServerStt();
          this._resumeWakeMonitoring();
        }).catch((err) => {
          this._ui({ error: err.message });
        });
      }
    });

    this.clap.on('clap', () => this._onActivation({ source: 'clap' }));
    this.clap.on('debug', (d) => {
      this._clapDebug = d;
      this._ui({ clapDebug: d });
    });
    this.wake.on('wake', (ev) => this._onActivation({
      source: 'wake',
      remainder: ev.remainder,
      transcript: ev.transcript,
      greeting: ev.greeting,
    }));
    this.wake.on('unsupported', () => {
      this.wakeStatus = 'unsupported';
      this.responseText = 'Wake listening needs Chrome or Edge (browser speech recognition).';
      this._ui();
    });
    this.wake.on('started', () => {
      this.wakeStatus = this.phase === 'sleeping' ? 'sleep-monitor' : 'monitoring';
      // Clear sticky connection error banner once recognition recovers
      if (String(this.diagnostics.stt).startsWith('error:')) this.diagnostics.stt = 'idle';
      this._ui();
    });
    // Show what the wake mic hears while sleeping so “not listening” is diagnosable
    this.wake.on('partial', ({ text, final }) => {
      if (this.phase !== 'sleeping' && this.phase !== 'standby') return;
      const t = String(text || '').trim();
      if (!t) return;
      this.transcript = t;
      if (final && this.phase === 'sleeping' && !matchWakePhrase(t).matched) {
        this.responseText = `Heard “${t.slice(0, 48)}” — say “Hey RA-ONE” or clap first, then ask.`;
      }
      this._ui();
    });
    this.wake.on('error', ({ error }) => {
      this.wakeStatus = `error:${error}`;
      if (error === 'not-allowed') {
        this.responseText = 'Microphone blocked for speech recognition. Allow mic in the browser address bar.';
      } else if (error === 'server-unreachable' || error === 'server-disconnected') {
        this.responseText = (
          'Offline speech service is not reachable — is the RA-ONE backend running? '
          + 'Clap still wakes me; you can also type.'
        );
        this.diagnostics.stt = `error:${error}`;
      } else if (error === 'models-missing') {
        this.responseText = 'Offline speech models are missing. Run backend/scripts/download_stt_models.py.';
        this.diagnostics.stt = 'error:models-missing';
      } else if (error === 'network') {
        // Chrome Web Speech uses Google’s cloud STT — clap still works; spoken words will not
        this.responseText = (
          'Speech-to-text network error (Chrome needs internet to Google). '
          + 'Clap still wakes me — then type your question, or fix network/VPN/firewall and refresh.'
        );
        this.diagnostics.stt = 'error:network';
      }
      this._ui();
    });

    this.stt.on('partial', ({ text }) => {
      this.transcript = text;
      this.diagnostics.stt = 'transcribing';
      this._ui();
    });
    this.stt.on('started', () => {
      this.diagnostics.stt = 'listening';
      this.pipeline.emit('stt.started');
      this._ui();
    });
    this.stt.on('final', ({ text }) => {
      const gen = this._sessionGen;
      this.diagnostics.stt = 'idle';
      this.pipeline.emit('stt.final', { chars: String(text || '').length });
      this._onQuestion(text, { sessionGen: gen });
    });
    this.stt.on('empty', () => {
      this.diagnostics.stt = 'idle';
      if (this.phase === 'standby' && this.handsFree && this._standbyTimer) {
        // Keep follow-up window alive until inactivity sleep
        this.stt.startQuestionCapture({
          seed: '',
          timeoutMs: Math.max(3000, this.standbyFollowupMs),
        });
        return;
      }
      this.responseText = `Sorry, I didn't catch that. I'm still here, just say it again, or type it.`;
      this._ui();
      this._enterStandby();
    });
    this.stt.on('error', ({ error }) => {
      this.diagnostics.stt = `error:${error}`;
      if (error === 'network') {
        this.responseText = (
          'I woke up, but speech-to-text failed (network). '
          + 'Type your question below — Chrome STT needs a working internet path to Google.'
        );
        this.transcript = this.transcript || '(speech recognition offline — type instead)';
        this._ui({ error: 'STT network' });
        // Stay in listening briefly so typing still feels natural, then standby
        this._enterStandby();
        return;
      }
      this._ui({ error: `STT: ${error}` });
      if (this.phase === 'listening' || this.phase === 'thinking') this._enterStandby();
    });

    this.tts.on('start', ({ silent } = {}) => {
      if (silent || this.phase !== 'speaking') return;
      this.envelope.start();
      this.bridge.useSimulated(this.envelope);
    });
    this.tts.on('end', () => {
      if (this.phase === 'speaking') this._onSpeakEnd();
    });
    this.tts.on('cancel', () => {
      this.envelope.stop();
      this.bridge.clear();
    });
  }

  _ui(extra = {}) {
    this.onUi({
      phase: this.phase,
      uiStatus: this.uiStatus,
      handsFree: this.handsFree,
      micPermission: this.micPermission,
      wakeStatus: this.wakeStatus,
      transcript: this.transcript,
      response: this.responseText,
      ttsEnabled: this.ttsEnabled,
      clapSensitivity: this.clap.sensitivity,
      speechRate: this.tts.rate,
      clapDebug: this._clapDebug,
      displayName: IDENTITY.displayName,
      lastSource: this.lastSource,
      lastError: this.lastError,
      simulated: this.lastSource === 'mock',
      diagnostics: { ...this.diagnostics },
      sttProvider: this.serverStt ? 'server' : 'browser',
      ...extra,
    });
  }

  setMoodProvider(fn) {
    this._moodProvider = typeof fn === 'function' ? fn : null;
  }

  /** Camera mood worth reacting to: a face is visible and the expression reading is confident. */
  _mood() {
    const m = this._moodProvider?.();
    if (!m?.present || !m.emotion) return null;
    return m;
  }

  /**
   * Friend-style check-in (e.g. the camera sees the user looking down). Only speaks while
   * awake and idle in standby, never from sleep and never over a conversation.
   */
  async checkIn(text) {
    if (!this.handsFree || this.phase !== 'standby' || this._activating) return false;
    this._clearStandbyTimer();
    this.responseText = text;
    this.emit('turn', { role: 'ra', text });
    this._ui();
    await this._speak(text, { displayText: text, sessionGen: this._sessionGen });
    return true;
  }

  setUseMockResponses(on) {
    this.useMockResponses = !!on;
    this._ui();
  }

  update() {
    this.bridge.update();
  }

  async enableHandsFree() {
    if (this.handsFree && this.session.isActive) return;
    await this.session.enable();
    await this._attachServerStt();
    this.handsFree = true;
    this.wakeStatus = this.wake.isSupported() ? 'starting' : 'unsupported';
    this.clap.start();
    this.wake.start();
    this._armDetectors(true);
    this._enterSleep({ silent: true });
    this._ui();
    this.emit('handsFree', { enabled: true });
  }

  /** Route the shared mic graph into the offline STT socket (no-op for browser STT). */
  async _attachServerStt() {
    if (!this.serverStt) return;
    this.serverStt.connect();
    try {
      await this.serverStt.attach(this.session);
    } catch (err) {
      this.diagnostics.stt = 'error:audio-worklet';
      this._ui({ error: `Offline STT audio tap failed: ${err?.message || err}` });
    }
  }

  /** Fully stops microphone monitoring (distinct from sleep). */
  disableHandsFree() {
    this.handsFree = false;
    this._clearStandbyTimer();
    this._sessionGen += 1;
    this.stt.cancel();
    this.tts.cancel();
    this.offlineVoice.stop();
    this._teardownDetectors();
    this.serverStt?.detach();
    this.serverStt?.close();
    this.session.stop();
    this.bridge.clear();
    this.wakeStatus = 'off';
    this._setPhase('sleeping');
    this.character?.setSleeping?.(true);
    this._ui();
    this.emit('handsFree', { enabled: false });
  }

  _teardownDetectors() {
    this.clap.stop();
    this.wake.stop();
    this.wakeStatus = this.handsFree ? this.wakeStatus : 'off';
  }

  _armDetectors(on) {
    this.clap.setArmed(on);
    this.wake.setArmed(on);
  }

  setClapSensitivity(v) {
    this.clap.setSensitivity(v);
    this._ui();
  }

  setSpeechRate(v) {
    this.tts.setRate(v);
    this._ui();
  }

  setTtsEnabled(on) {
    this.ttsEnabled = !!on;
    this.tts.setEnabled(on);
    this._ui();
  }

  setStandbyFollowupMs(ms) {
    this.standbyFollowupMs = Math.max(3000, Number(ms) || LIFECYCLE.STANDBY_FOLLOWUP_MS);
  }

  async testVoice(sample = `Hello. I am ${IDENTITY.displayName}. Voice test.`) {
    this._armDetectors(false);
    this.stt.cancel();
    await this._speak(sample, { displayText: sample });
  }

  setVoicePreset(id) {
    this.voicePreset = id || 'raone_jarvis';
    this.offlineVoice.preset = this.voicePreset;
  }

  async handleTextQuestion(text) {
    // Text path can wake from sleep into conversation
    if (this.phase === 'sleeping') {
      this.character?.triggerWake?.();
      this._setPhase('listening', { source: 'text' });
    }
    await this._onQuestion(text, { fromText: true });
  }

  async _onActivation({ source, remainder = '', greeting = null }) {
    if (!this.handsFree) return;
    if (this._activating) return;
    if (performance.now() < this._cooldownUntil) return;
    // Only wake from sleeping or accept new turn from standby
    if (this.phase !== 'sleeping' && this.phase !== 'standby' && this.phase !== 'error') return;

    this._activating = true;
    this._clearStandbyTimer();
    this._sessionGen += 1;
    const gen = this._sessionGen;

    this._armDetectors(false);
    this.wake.stop();
    this.wakeStatus = 'paused';
    this.uiStatus = 'WAKE DETECTED';
    this.pipeline.begin();
    this.pipeline.emit('wake.detected', { source, has_remainder: !!(remainder && remainder.length > 2) });
    this._ui();

    try {
      this.character?.triggerWake?.();
      this.assistant.playEnergyPulse?.();
      this.transcript = remainder || '';

      const mood = this._mood();
      const ack = wakeAcknowledgement(greeting, source, {
        mood: mood && mood.emotion !== 'neutral' && mood.confidence >= 0.6 ? mood.emotion : null,
      });
      this._bareCalls = 0;
      this.responseText = ack;
      this._setPhase('listening', { source });
      this._syncBackend('listening');
      this._ui();

      if (remainder && remainder.length > 2) {
        await this._onQuestion(remainder, { sessionGen: gen });
        return;
      }

      // Short spoken ack (clap / bare wake). Detectors stay disarmed to avoid TTS feedback.
      if (this.ttsEnabled && (source === 'clap' || source === 'wake')) {
        try {
          await this._speakAck(ack, gen);
        } catch { /* ignore */ }
        if (gen !== this._sessionGen) return;
      }

      const ok = this.stt.startQuestionCapture({ seed: '' });
      if (!ok) {
        this.responseText = 'Speech recognition is unavailable. Type your question, or try Chrome/Edge.';
        this._setPhase('error');
        this._ui();
        this._enterStandby();
      }
    } finally {
      this._activating = false;
    }
  }

  /** Brief wake greeting; detectors stay disarmed so TTS cannot re-trigger wake. */
  async _speakAck(displayText, sessionGen) {
    this._armDetectors(false);
    this.stt.cancel();
    this._setPhase('speaking', { ack: true });
    this._syncBackend('speaking');
    this._ui();
    const spoken = toSpokenText(displayText);
    if (this.useOfflineTts) {
      try {
        this.bridge.clear();
        await this.offlineVoice.speak(spoken, { preset: this.voicePreset });
      } catch {
        try { await this.tts.speak(spoken); } catch { /* ignore */ }
      }
    } else {
      try { await this.tts.speak(spoken); } catch { /* ignore */ }
    }
    this.bridge.clear();
    this._cooldownUntil = performance.now() + this.postSpeakCooldownMs;
    if (sessionGen === this._sessionGen) {
      this._setPhase('listening', { afterAck: true });
      this._syncBackend('listening');
      this._ui();
    }
  }

  async _onQuestion(raw, { fromText = false, sessionGen = this._sessionGen } = {}) {
    if (sessionGen !== this._sessionGen) return; // late STT after cancel/sleep
    this._clearStandbyTimer();

    let text = String(raw || '').trim();
    if (!text) {
      this._enterStandby();
      return;
    }

    // Sleep commands during active session
    const sleepHit = matchSleepCommand(text);
    if (sleepHit.matched && (this.phase === 'listening' || this.phase === 'standby' || this.phase === 'thinking' || fromText)) {
      this.goToSleep({ reason: sleepHit.command });
      return;
    }

    // Sleeping mode ignores ordinary questions (text wake handled above)
    if (this.phase === 'sleeping' && !fromText) {
      return;
    }

    const wake = matchWakePhrase(text);
    if (wake.matched && wake.remainder) text = wake.remainder;
    else if (wake.matched && !wake.remainder) {
      if (!fromText) {
        // Name called again while awake: answer out loud (used to go silent and look stuck)
        this._bareCalls = (this._bareCalls || 0) + 1;
        const ack = this._bareCalls === 1
          ? wakeAcknowledgement(wake.greeting, 'wake')
          : wakeAcknowledgement(null, 'repeat');
        this.responseText = ack;
        this._setPhase('listening', { source: 'wake-repeat' });
        this._ui();
        if (this.ttsEnabled) {
          try { await this._speakAck(ack, sessionGen); } catch { /* ignore */ }
          if (sessionGen !== this._sessionGen) return;
        }
        this.stt.startQuestionCapture({ seed: '' });
        return;
      }
    }
    this._bareCalls = 0;

    this.transcript = text;
    this.emit('turn', { role: 'user', text, via: fromText ? 'text' : 'voice' });
    this.stt.cancel();
    this.lastError = null;
    this._setPhase('thinking');
    this._syncBackend('thinking');
    this.diagnostics.llm = 'generating';
    const cid = this.pipeline.correlationId || this.pipeline.begin();
    this.pipeline.emit('llm.request', { chars: text.length });
    this._ui();

    if (sessionGen !== this._sessionGen) return;

    // Explicit developer mock only — never the default when LLM can answer
    if (this.useMockResponses) {
      const { response, id } = this.responses.respond(text);
      this.lastSource = 'mock';
      this.responseText = response;
      this.emit('turn', { role: 'ra', text: response, simulated: true });
      this.diagnostics.llm = 'idle';
      this._ui({ intent: id, simulated: true });
      await this._speak(response, { displayText: response, sessionGen });
      return;
    }

    try {
      const result = await this.conversation.turn(text, {
        useMock: false,
        correlationId: cid,
        emotion: this._mood(),
      });
      if (sessionGen !== this._sessionGen) return;
      this.pipeline.emit('llm.response', {
        source: result.source,
        latency_ms: result.latency_ms,
      });
      this.lastSource = result.source || 'llm';
      this.responseText = result.text;
      this.emit('turn', { role: 'ra', text: result.text, simulated: !!result.simulated });
      this.diagnostics.llm = 'idle';
      this.diagnostics.ollama = 'online';
      this._ui({
        intent: result.intent,
        simulated: !!result.simulated,
        model: result.model,
        llmLatencyMs: result.latency_ms,
      });
      await this._speak(result.text, { displayText: result.text, sessionGen });
    } catch (err) {
      if (sessionGen !== this._sessionGen) return;
      const payload = err?.payload;
      const message =
        payload?.error
        || err?.message
        || 'Local AI is unavailable.';
      this.lastError = message;
      this.lastSource = 'error';
      this.diagnostics.llm = 'error';
      this.diagnostics.ollama = payload?.meta?.ollama_reachable === false ? 'offline' : this.diagnostics.ollama;
      this.pipeline.emit('llm.error', { message: String(message).slice(0, 160) });
      this.responseText = message;
      this.emit('turn', { role: 'ra', text: message });
      this._ui({ error: message, simulated: false });
      // Speak the real error so the user hears why — not a fake analysis answer
      await this._speak(message, { displayText: message, sessionGen });
    }
  }

  async _speak(displayText, { sessionGen = this._sessionGen } = {}) {
    this._armDetectors(false);
    this.stt.cancel();
    this.offlineVoice.stop();
    this.diagnostics.tts = 'generating';
    this.pipeline.emit('tts.started');
    // Stay in thinking until audio actually starts when possible
    this._ui();

    if (!this.ttsEnabled) {
      this._setPhase('speaking');
      this._onSpeakEnd();
      return;
    }

    const spoken = toSpokenText(displayText, {
      voiceId: this.offlineVoice.voiceId || undefined,
    });

    if (this.useOfflineTts) {
      try {
        this.bridge.clear();
        this._setPhase('speaking');
        this._syncBackend('speaking');
        this.diagnostics.tts = 'playing';
        this.pipeline.emit('audio.playing');
        this._ui();
        await this.offlineVoice.speak(spoken, { preset: this.voicePreset });
        this.pipeline.emit('audio.ended');
        this.diagnostics.tts = 'ready';
        if (sessionGen === this._sessionGen && this.phase === 'speaking') this._onSpeakEnd();
        return;
      } catch (err) {
        console.warn('[RA-ONE] Offline TTS failed, falling back:', err?.message || err);
      }
    }

    this.tts.setEnabled(true);
    this._setPhase('speaking');
    this._syncBackend('speaking');
    this.diagnostics.tts = 'playing';
    this.pipeline.emit('audio.playing');
    this.envelope.start();
    this.bridge.useSimulated(this.envelope);
    this._ui();
    try {
      await this.tts.speak(spoken);
    } catch { /* ignore */ }
    this.pipeline.emit('audio.ended');
    this.diagnostics.tts = 'ready';
    if (sessionGen === this._sessionGen && this.phase === 'speaking') this._onSpeakEnd();
  }

  _onSpeakEnd() {
    this.envelope.stop();
    this.bridge.clear();
    this.offlineVoice.stop();
    this._cooldownUntil = performance.now() + this.postSpeakCooldownMs;
    this._enterStandby();
  }

  _enterStandby() {
    this._setPhase('standby');
    this._syncBackend('idle');
    this.pipeline.emit('assistant.standby');
    this._scheduleSleepFromStandby();
    // Follow-up window: listen for questions without a wake phrase
    this._armDetectors(false);
    this.wake.stop();
    this.wakeStatus = 'standby-listen';
    if (this.handsFree && this.session.isActive) {
      const ok = this.stt.startQuestionCapture({
        seed: '',
        timeoutMs: this.standbyFollowupMs + 2000,
      });
      if (!ok) this._resumeWakeMonitoring();
    }
    this._ui();
  }

  _scheduleSleepFromStandby() {
    this._clearStandbyTimer();
    if (!this.handsFree) return;
    this._standbyTimer = setTimeout(() => {
      if (this.phase === 'standby') {
        this.stt.cancel();
        this._enterSleep({ reason: 'inactivity' });
      }
    }, this.standbyFollowupMs);
  }

  _clearStandbyTimer() {
    if (this._standbyTimer) clearTimeout(this._standbyTimer);
    this._standbyTimer = null;
  }

  goToSleep({ reason = 'command' } = {}) {
    this._sessionGen += 1;
    this.stt.cancel();
    this.tts.cancel();
    this.offlineVoice.stop();
    this.bridge.clear();
    this._enterSleep({ reason });
  }

  _enterSleep({ reason = 'init', silent = false } = {}) {
    this._clearStandbyTimer();
    this.stt.cancel();
    this._setPhase('sleeping', { reason });
    this._syncBackend('idle');
    this.character?.setSleeping?.(true);
    this.responseText = silent ? this.responseText : (reason === 'command' ? 'Entering sleep mode.' : this.responseText);
    this._resumeWakeMonitoring();
    this._ui({ sleepReason: reason });
  }

  _resumeWakeMonitoring() {
    if (!this.handsFree || !this.session.isActive) return;
    const wait = Math.max(0, this._cooldownUntil - performance.now());
    setTimeout(() => {
      if (!this.handsFree) return;
      if (this.phase !== 'sleeping' && this.phase !== 'standby') return;
      this._armDetectors(true);
      if (!this.wake.running && this.wake.isSupported()) this.wake.start();
      if (!this.clap.running) {
        try { this.clap.start(); } catch { /* ignore */ }
      }
      this.wakeStatus = this.wake.isSupported()
        ? (this.phase === 'sleeping' ? 'sleep-monitor' : 'monitoring')
        : 'unsupported';
      this._ui();
    }, wait);
  }

  _setPhase(phase, meta = {}) {
    if (!VOICE_PHASES.includes(phase)) return;
    const from = this.phase;
    this.phase = phase;
    this.uiStatus = {
      sleeping: 'SLEEPING',
      standby: 'STANDBY',
      listening: 'LISTENING',
      thinking: 'THINKING',
      speaking: 'SPEAKING',
      error: 'ERROR',
    }[phase] || phase.toUpperCase();

    if (phase === 'sleeping') this.character?.setSleeping?.(true);
    else if (from === 'sleeping') this.character?.setSleeping?.(false);

    const visual = (phase === 'sleeping' || phase === 'standby' || phase === 'error')
      ? 'idle'
      : phase;
    this.assistant.setState(visual, { source: 'voice', phase, ...meta });
    this.emit('phase', { from, to: phase, meta });
  }

  _syncBackend(state) {
    if (!this.backend?.isConnected) return;
    this.backend.setRemoteState(state, 'voice').catch(() => {});
  }

  cancel() {
    this._sessionGen += 1;
    this.stt.cancel();
    this.tts.cancel();
    this.offlineVoice.stop();
    this.bridge.clear();
    if (this.handsFree) this._enterStandby();
    else this._enterSleep({ reason: 'cancel' });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { VOICE_PHASES, IDENTITY };
