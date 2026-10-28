import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceInteractionController } from '../src/assistant/VoiceInteractionController.js';

function mockAssistant() {
  return {
    setState: vi.fn(),
    playEnergyPulse: vi.fn(),
  };
}

function mockSpeech() {
  return {
    setExternalAmplitude: vi.fn(),
    mode: 'off',
  };
}

describe('VoiceInteractionController', () => {
  let voice;

  beforeEach(() => {
    voice = new VoiceInteractionController({
      assistant: mockAssistant(),
      speech: mockSpeech(),
      backend: null,
      onUi: () => {},
    });
    // Avoid real mic / recognition
    voice.session.enable = vi.fn(async () => {
      voice.session.active = true;
      voice.session.stream = { getTracks: () => [] };
      voice.session.permission = 'granted';
    });
    voice.session.active = true;
    voice.session.stream = { getTracks: () => [] };
    voice.session.stop = vi.fn();
    Object.defineProperty(voice.session, 'isActive', { get: () => true, configurable: true });
    voice.clap.start = vi.fn();
    voice.clap.stop = vi.fn();
    voice.wake.start = vi.fn();
    voice.wake.stop = vi.fn();
    voice.wake.isSupported = () => true;
  });

  it('TC-14 text question returns to standby after speak', async () => {
    voice.ttsEnabled = false;
    voice.useMockResponses = true; // explicit mock path for unit test
    // Silent path (TTS off) still completes the speak lifecycle
    await voice.handleTextQuestion('Who are you?');
    expect(voice.phase).toBe('standby');
    expect(voice.responseText).toMatch(/I am RA-ONE/);
    expect(voice.assistant.setState).toHaveBeenCalled();
  });

  it('TC-15 speaking disarms detectors', async () => {
    voice.handsFree = true;
    voice._armDetectors = vi.fn();
    voice.stt.cancel = vi.fn();
    voice.ttsEnabled = false;
    await voice._speak('test');
    expect(voice._armDetectors).toHaveBeenCalledWith(false);
    expect(voice.stt.cancel).toHaveBeenCalled();
    expect(voice.phase).toBe('standby');
  });

  it('routes questions to conversation API when mock is off', async () => {
    voice.ttsEnabled = false;
    voice.useMockResponses = false;
    voice.conversation.turn = vi.fn(async () => ({
      success: true,
      text: 'Artificial intelligence is machine learning systems that perform tasks.',
      source: 'llm',
      simulated: false,
      intent: 'general_question',
      model: 'qwen3:1.7b',
      latency_ms: 12,
    }));
    await voice.handleTextQuestion('What is artificial intelligence?');
    expect(voice.conversation.turn).toHaveBeenCalled();
    expect(voice.responseText).toMatch(/Artificial intelligence/);
    expect(voice.lastSource).toBe('llm');
    expect(voice.phase).toBe('standby');
  });

  it('TC-19 disableHandsFree releases session', () => {
    voice.handsFree = true;
    voice.disableHandsFree();
    expect(voice.handsFree).toBe(false);
    expect(voice.session.stop).toHaveBeenCalled();
    expect(voice.clap.stop).toHaveBeenCalled();
    expect(voice.wake.stop).toHaveBeenCalled();
  });

  it('activation blocked during cooldown', async () => {
    voice.handsFree = true;
    voice.phase = 'standby';
    voice._cooldownUntil = performance.now() + 5000;
    await voice._onActivation({ source: 'clap' });
    expect(voice.phase).toBe('standby');
  });
});
