import { describe, expect, it, beforeAll } from 'vitest';

let Processor;

beforeAll(async () => {
  // Minimal AudioWorkletGlobalScope stand-ins
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { posted: [], postMessage(msg) { this.posted.push(msg); }, onmessage: null };
    }
  };
  globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
  await import('../src/audio/pcm-worklet.js');
});

function run(proc, samples, blockSize = 128) {
  for (let i = 0; i < samples.length; i += blockSize) {
    proc.process([[samples.subarray(i, i + blockSize)]]);
  }
}

describe('pcm16-capture worklet', () => {
  it('turns 48 kHz input into 20 ms 16 kHz PCM16 frames', () => {
    const proc = new Processor();
    run(proc, new Float32Array(48000).fill(0.5)); // 1 s of audio
    const frames = proc.port.posted;
    expect(frames.length).toBe(50); // 1 s / 20 ms
    const pcm = new Int16Array(frames[0]);
    expect(pcm.length).toBe(320);
    expect(pcm[100]).toBe(Math.floor(0.5 * 0x7fff));
  });

  it('clips out-of-range samples', () => {
    const proc = new Processor();
    run(proc, new Float32Array(960).fill(-3));
    expect(new Int16Array(proc.port.posted[0])[0]).toBe(-0x8000);
  });

  it('stops posting when disabled', () => {
    const proc = new Processor();
    proc.port.onmessage({ data: { type: 'enable', value: false } });
    run(proc, new Float32Array(4800));
    expect(proc.port.posted.length).toBe(0);
  });
});
