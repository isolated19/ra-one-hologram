import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { VoiceInteractionController } from '../src/assistant/VoiceInteractionController.js';
import { WAKE_DICTIONARY } from '../src/assistant/identityConfig.js';
import { wakeAcknowledgement } from '../src/assistant/nameNormalizer.js';

function makeVoice() {
  const voice = new VoiceInteractionController({
    assistant: { setState: vi.fn(), playEnergyPulse: vi.fn() },
    speech: { setExternalAmplitude: vi.fn(), mode: 'off' },
    character: { setSleeping: vi.fn(), triggerWake: vi.fn() },
    backend: null,
    onUi: () => {},
  });
  Object.defineProperty(voice.session, 'isActive', { get: () => true, configurable: true });
  voice.clap.start = vi.fn();
  voice.clap.stop = vi.fn();
  voice.wake.start = vi.fn();
  voice.wake.stop = vi.fn();
  voice.wake.isSupported = () => true;
  voice.stt.startQuestionCapture = vi.fn(() => true);
  voice.stt.cancel = vi.fn();
  voice.useOfflineTts = false;
  voice.tts.speak = vi.fn(async () => {});
  voice.handsFree = true;
  return voice;
}

describe('calling RA-ONE again while awake', () => {
  let voice;
  beforeEach(() => {
    vi.useFakeTimers();
    voice = makeVoice();
  });
  afterEach(() => vi.useRealTimers());

  it('answers out loud every time instead of going silent', async () => {
    voice.phase = 'standby';
    await voice._onQuestion('RA-ONE', { fromText: false });
    await voice._onQuestion('RA-ONE', { fromText: false });
    await voice._onQuestion('hey RA-ONE', { fromText: false });
    expect(voice.tts.speak).toHaveBeenCalledTimes(3);
    expect(voice.stt.startQuestionCapture).toHaveBeenCalledTimes(3);
    expect(voice.phase).toBe('listening');
  });

  it('switches to "still here" lines on repeated calls', async () => {
    voice.phase = 'standby';
    await voice._onQuestion('RA-ONE', { fromText: false });
    await voice._onQuestion('RA-ONE', { fromText: false });
    expect(WAKE_DICTIONARY.acknowledgements.repeat).toContain(voice.responseText);
  });

  it('a real question resets the repeat counter', async () => {
    voice.useMockResponses = true;
    voice.ttsEnabled = false;
    voice.phase = 'standby';
    await voice._onQuestion('RA-ONE', { fromText: false });
    await voice._onQuestion('what can you do', { fromText: false });
    expect(voice._bareCalls).toBe(0);
  });

  it('sends the camera mood with the question', async () => {
    voice.ttsEnabled = false;
    voice.phase = 'standby';
    voice.setMoodProvider(() => ({ present: true, emotion: 'sad', confidence: 0.8 }));
    voice.conversation.turn = vi.fn(async () => ({ text: 'I am here for you.', source: 'llm' }));
    await voice._onQuestion('I had a rough day', { fromText: false });
    expect(voice.conversation.turn).toHaveBeenCalledWith('I had a rough day', expect.objectContaining({
      emotion: { present: true, emotion: 'sad', confidence: 0.8 },
    }));
  });

  it('checkIn speaks only while awake in standby', async () => {
    voice.ttsEnabled = false;
    voice.phase = 'sleeping';
    expect(await voice.checkIn('You seem down.')).toBe(false);
    voice.phase = 'standby';
    expect(await voice.checkIn('You seem down.')).toBe(true);
    expect(voice.responseText).toBe('You seem down.');
  });
});

describe('wakeAcknowledgement', () => {
  it('never repeats the same line twice in a row', () => {
    let prev = wakeAcknowledgement('hey', 'wake');
    for (let i = 0; i < 20; i++) {
      const next = wakeAcknowledgement('hey', 'wake');
      expect(next).not.toBe(prev);
      prev = next;
    }
  });

  it('fills in the time of day', () => {
    const line = wakeAcknowledgement('hello', 'wake', { hour: 9, rng: () => 0 });
    expect(line).toMatch(/^Good morning/);
  });

  it('uses a mood line when the camera sees a clear expression', () => {
    const line = wakeAcknowledgement('hey', 'wake', { mood: 'happy' });
    expect(WAKE_DICTIONARY.moodAcknowledgements.happy).toContain(line);
  });
});
