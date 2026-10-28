import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AudioSessionManager } from '../src/audio/AudioSessionManager.js';

describe('AudioSessionManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('TC-16 handles permission denial', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const err = new Error('denied');
          err.name = 'NotAllowedError';
          throw err;
        }),
      },
    });
    const session = new AudioSessionManager();
    await expect(session.enable()).rejects.toThrow();
    expect(session.permission).toBe('denied');
  });

  it('TC-17 / unavailable when getUserMedia missing', async () => {
    vi.stubGlobal('navigator', { mediaDevices: undefined });
    const session = new AudioSessionManager();
    await expect(session.enable()).rejects.toThrow(/unavailable/i);
    expect(session.permission).toBe('unavailable');
  });
});
