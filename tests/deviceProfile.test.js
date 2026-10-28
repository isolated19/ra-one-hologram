import { describe, it, expect } from 'vitest';
import { choosePreset } from '../src/scene/deviceProfile.js';

const desktop = { webgl: true, software: false, gpu: 'NVIDIA GeForce RTX 3060', memory: 16, cores: 12, mobile: false };

describe('choosePreset', () => {
  it('gives a dedicated GPU the medium preset', () => {
    expect(choosePreset(desktop)).toBe('medium');
  });

  it('drops to minimal without WebGL or on CPU (software) rendering', () => {
    expect(choosePreset({ ...desktop, webgl: false })).toBe('minimal');
    expect(choosePreset({ ...desktop, software: true, gpu: 'Google SwiftShader' })).toBe('minimal');
  });

  it('drops to minimal on very weak machines', () => {
    expect(choosePreset({ ...desktop, memory: 2 })).toBe('minimal');
    expect(choosePreset({ ...desktop, cores: 2 })).toBe('minimal');
  });

  it('uses low for integrated GPUs, mobiles and mid-range machines', () => {
    expect(choosePreset({ ...desktop, gpu: 'Intel(R) UHD Graphics 620' })).toBe('low');
    expect(choosePreset({ ...desktop, mobile: true })).toBe('low');
    expect(choosePreset({ ...desktop, memory: 4 })).toBe('low');
  });

  it('lets the URL override, then a remembered setting', () => {
    expect(choosePreset({ ...desktop, software: true }, { forced: 'high' })).toBe('high');
    expect(choosePreset(desktop, { saved: 'minimal' })).toBe('minimal');
    expect(choosePreset(desktop, { forced: 'bogus', saved: 'low' })).toBe('low');
  });
});
