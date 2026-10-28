import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { VoiceInteractionController } from '../src/assistant/VoiceInteractionController.js';
import { IDENTITY } from '../src/assistant/identityConfig.js';

function mockAssistant() {
  return { setState: vi.fn(), playEnergyPulse: vi.fn() };
}
function mockSpeech() {
  return { setExternalAmplitude: vi.fn(), mode: 'off' };
}
function mockCharacter() {
  return { setSleeping: vi.fn(), triggerWake: vi.fn() };
}

describe('lifecycle sleep/wake', () => {
  let voice;
  let character;

  beforeEach(() => {
    vi.useFakeTimers();
    character = mockCharacter();
    voice = new VoiceInteractionController({
      assistant: mockAssistant(),
      speech: mockSpeech(),
      character,
      backend: null,
      onUi: () => {},
    });
    voice.session.enable = vi.fn(async () => {
      voice.session.active = true;
      voice.session.stream = { getTracks: () => [] };
      voice.session.permission = 'granted';
    });
    Object.defineProperty(voice.session, 'isActive', { get: () => true, configurable: true });
    voice.session.stop = vi.fn();
    voice.clap.start = vi.fn();
    voice.clap.stop = vi.fn();
    voice.wake.start = vi.fn();
    voice.wake.stop = vi.fn();
    voice.wake.isSupported = () => true;
    voice.stt.startQuestionCapture = vi.fn(() => true);
    voice.stt.cancel = vi.fn();
    voice.ttsEnabled = false;
    voice.useOfflineTts = false;
    voice.useMockResponses = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC-08 clap wakes once from sleeping', async () => {
    voice.handsFree = true;
    voice.phase = 'sleeping';
    await voice._onActivation({ source: 'clap' });
    expect(character.triggerWake).toHaveBeenCalled();
    expect(voice.phase).toBe('listening');
    expect(voice.responseText).toMatch(/listening/i);
  });

  it('TC-08b clap with spoken ack still opens question capture', async () => {
    voice.handsFree = true;
    voice.phase = 'sleeping';
    voice.ttsEnabled = true;
    voice.tts.speak = vi.fn(async () => {});
    await voice._onActivation({ source: 'clap' });
    expect(voice.tts.speak).toHaveBeenCalled();
    expect(voice.stt.startQuestionCapture).toHaveBeenCalled();
    expect(voice.phase).toBe('listening');
  });

  it('TC-09 second activation during cooldown ignored', async () => {
    voice.handsFree = true;
    voice.phase = 'sleeping';
    voice._cooldownUntil = performance.now() + 5000;
    await voice._onActivation({ source: 'clap' });
    expect(voice.phase).toBe('sleeping');
  });

  it('TC-10 sleeping ignores ordinary questions', async () => {
    voice.handsFree = true;
    voice.phase = 'sleeping';
    await voice._onQuestion('what is the weather', { fromText: false });
    expect(voice.phase).toBe('sleeping');
  });

  it('TC-11 waking triggers character wake effect', async () => {
    voice.handsFree = true;
    voice.phase = 'sleeping';
    await voice._onActivation({ source: 'wake', greeting: 'hey' });
    expect(character.triggerWake).toHaveBeenCalled();
    expect(character.setSleeping).toHaveBeenCalledWith(false);
  });

  it('TC-15 after speak enters standby', async () => {
    voice.handsFree = true;
    const done = voice.handleTextQuestion('Who are you?');
    await vi.advanceTimersByTimeAsync(800);
    await done;
    expect(voice.phase).toBe('standby');
    expect(voice.responseText).toContain(IDENTITY.displayName);
  });

  it('TC-16 follow-up in standby accepted', async () => {
    voice.handsFree = true;
    voice.phase = 'standby';
    const done = voice._onQuestion('tell me more', { fromText: false });
    await vi.advanceTimersByTimeAsync(800);
    await done;
    expect(voice.phase).toBe('standby');
    expect(voice.responseText.length).toBeGreaterThan(0);
  });

  it('TC-17 inactivity timeout enters sleeping', async () => {
    voice.handsFree = true;
    voice.standbyFollowupMs = 1000;
    voice._enterStandby();
    expect(voice.phase).toBe('standby');
    await vi.advanceTimersByTimeAsync(1100);
    expect(voice.phase).toBe('sleeping');
    expect(character.setSleeping).toHaveBeenCalledWith(true);
  });

  it('TC-18 go to sleep command', async () => {
    voice.handsFree = true;
    voice.phase = 'standby';
    await voice._onQuestion('RA-ONE, go to sleep', { fromText: true });
    expect(voice.phase).toBe('sleeping');
  });

  it('TC-19 wake monitoring resumes while sleeping hands-free', async () => {
    voice.handsFree = true;
    voice._enterSleep({ silent: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(voice.wake.start).toHaveBeenCalled();
    expect(voice.wakeStatus).toMatch(/sleep|monitor/);
  });

  it('TC-20 disable hands-free releases mic', () => {
    voice.handsFree = true;
    voice.disableHandsFree();
    expect(voice.handsFree).toBe(false);
    expect(voice.session.stop).toHaveBeenCalled();
  });

  it('TC-14 late STT after cancel is ignored', async () => {
    voice.handsFree = true;
    const gen = voice._sessionGen;
    voice.cancel();
    await voice._onQuestion('late result', { sessionGen: gen });
    expect(voice.phase).not.toBe('thinking');
  });
});
