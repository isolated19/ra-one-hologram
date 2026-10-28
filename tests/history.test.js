// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConversationPanel } from '../src/ui/ConversationPanel.js';
import { VoiceInteractionController } from '../src/assistant/VoiceInteractionController.js';

function panel() {
  const box = document.createElement('div');
  const btn = document.createElement('button');
  return new ConversationPanel(box, btn);
}

describe('conversation history', () => {
  beforeEach(() => localStorage.clear());

  it('tags spoken turns and survives a restart', () => {
    const p = panel();
    p.add('user', 'what is the time', { via: 'voice' });
    p.add('ra', "It's 4:05 PM.");
    expect(p.el.querySelector('.ra-tag').textContent).toBe('VOICE');

    const reopened = panel();
    expect(reopened.count).toBe(2);
    expect([...reopened.el.querySelectorAll('.ra-msg-text')].map((n) => n.textContent))
      .toEqual(['what is the time', "It's 4:05 PM."]);
  });

  it('voice questions and answers both reach history', async () => {
    const voice = new VoiceInteractionController({
      assistant: { setState: vi.fn(), playEnergyPulse: vi.fn() },
      speech: { setExternalAmplitude: vi.fn(), mode: 'off' },
      onUi: () => {},
    });
    voice.stt.cancel = vi.fn();
    voice.stt.startQuestionCapture = vi.fn(() => true);
    voice.ttsEnabled = false;
    voice.phase = 'standby';
    voice.conversation.turn = vi.fn(async () => ({ text: "It's 4:05 PM.", source: 'fast' }));
    const p = panel();
    voice.on('turn', ({ role, text, via, simulated }) => p.add(role, text, { via, simulated }));

    await voice._onQuestion('what is the time', { fromText: false });
    expect(p.count).toBe(2);
    expect(p.items.map((i) => [i.role, i.via])).toEqual([['user', 'voice'], ['ra', 'text']]);
  });
});
