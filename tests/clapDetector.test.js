import { describe, expect, it, vi } from 'vitest';
import { ClapDetector } from '../src/audio/ClapDetector.js';

const FRAME_MS = 10;

/** Feed 10 ms worklet frames; `shape` is a list of [energy, peak, zcr]. */
function feed(clap, shape, clock) {
  for (const [energy, peak, zcr] of shape) {
    clap._onFrame({ energy, peak, zcr, t: clock.t });
    clock.t += FRAME_MS;
  }
}

const quiet = (ms) => Array.from({ length: ms / FRAME_MS }, () => [0.004, 0.015, 0.1]);
// Sharp onset, gone within ~30 ms
const clapShape = () => [[0.25, 0.9, 0.2], [0.09, 0.4, 0.2], [0.03, 0.12, 0.15], [0.012, 0.05, 0.1], ...quiet(200)];
// Loud word onset ("Hey…") that stays loud like a vowel
const speechShape = () => [[0.2, 0.7, 0.12], ...Array.from({ length: 30 }, () => [0.16, 0.55, 0.08]), ...quiet(200)];

function makeDetector(opts = {}) {
  const clap = new ClapDetector({ audioSession: { isActive: true }, cooldownMs: 1500, ...opts });
  const hits = [];
  const reasons = [];
  clap.on('clap', (e) => hits.push(e));
  clap.on('debug', (d) => reasons.push(d.reason));
  const clock = { t: 0 };
  feed(clap, quiet(1000), clock); // settle the noise floor
  return { clap, hits, reasons, clock };
}

describe('ClapDetector transient check', () => {
  it('accepts a sharp clap that decays quickly', () => {
    const { clap, hits, clock } = makeDetector();
    feed(clap, clapShape(), clock);
    expect(hits).toHaveLength(1);
    expect(clap.lastDebug.reason).toBe('accepted');
  });

  it('rejects a loud word onset that stays loud (speech is not a clap)', () => {
    const { clap, hits, reasons, clock } = makeDetector();
    feed(clap, speechShape(), clock);
    expect(hits).toHaveLength(0);
    expect(reasons).toContain('sustained');
  });

  it('rejects a voiced syllable with a sharp, short onset (low zero-crossing rate)', () => {
    const { clap, hits, reasons, clock } = makeDetector();
    feed(clap, [[0.25, 0.9, 0.056], [0.05, 0.2, 0.05], ...quiet(200)], clock);
    expect(hits).toHaveLength(0);
    expect(reasons).toContain('zcr_voice_like');
  });

  it('TC-07: a second clap inside the cooldown is ignored, after it is accepted', () => {
    const { clap, hits, reasons, clock } = makeDetector();
    feed(clap, clapShape(), clock);
    feed(clap, quiet(300), clock);
    feed(clap, clapShape(), clock);
    expect(hits).toHaveLength(1);
    expect(reasons).toContain('cooldown');
    feed(clap, quiet(1500), clock);
    feed(clap, clapShape(), clock);
    expect(hits).toHaveLength(2);
  });

  it('ignores audio while disarmed (RA-ONE speaking)', () => {
    const { clap, hits, clock } = makeDetector();
    clap.setArmed(false);
    feed(clap, clapShape(), clock);
    expect(hits).toHaveLength(0);
  });

  it('disarming mid-check drops the pending candidate', () => {
    const { clap, hits, clock } = makeDetector();
    feed(clap, clapShape().slice(0, 2), clock);
    clap.setArmed(false);
    clap.setArmed(true);
    feed(clap, quiet(300), clock);
    expect(hits).toHaveLength(0);
  });
});

describe('ClapDetector worklet wiring', () => {
  function fakeSession() {
    const node = { port: { onmessage: null }, connect: vi.fn((x) => x), disconnect: vi.fn() };
    const ctx = {
      audioWorklet: { addModule: vi.fn(async () => {}) },
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn((x) => x), disconnect: vi.fn() }),
      destination: {},
    };
    globalThis.AudioWorkletNode = vi.fn(() => node);
    return { session: { isActive: true, audioContext: ctx, sourceNode: { connect: vi.fn() } }, node, ctx };
  }

  it('taps the mic through the level worklet and stops cleanly', async () => {
    const { session, node, ctx } = fakeSession();
    const clap = new ClapDetector({ audioSession: session });
    await clap.start();
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(globalThis.AudioWorkletNode).toHaveBeenCalledWith(ctx, 'raone-level');
    expect(session.sourceNode.connect).toHaveBeenCalledWith(node);
    expect(clap.running).toBe(true);
    expect(typeof node.port.onmessage).toBe('function');

    clap.stop();
    expect(clap.running).toBe(false);
    expect(node.disconnect).toHaveBeenCalled();
    expect(node.port.onmessage).toBeNull();

    await clap.start(); // same context → module not loaded twice
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
  });

  it('a stop() during the async attach leaves nothing connected', async () => {
    const { session } = fakeSession();
    const clap = new ClapDetector({ audioSession: session });
    const p = clap.start();
    clap.stop();
    await p;
    expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
    expect(clap.running).toBe(false);
  });

  it('throws when the mic session is inactive', () => {
    const clap = new ClapDetector({ audioSession: { isActive: false } });
    expect(() => clap.start()).toThrow('Audio session inactive');
  });
});
