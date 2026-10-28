import { describe, expect, it } from 'vitest';
import { matchWakePhrase, normalizeTranscript } from '../src/audio/WakeWordDetector.js';

describe('TC-05 wake phrase matching', () => {
  it.each([
    'Hey RA-ONE',
    'hey ra one',
    'Hey Ray One',
    'hey r one',
    'HEY RAONE',
    'hey are a one what time is it',
  ])('matches %s', (phrase) => {
    expect(matchWakePhrase(phrase).matched).toBe(true);
  });

  it('rejects mid-sentence accidental hits far from start', () => {
    const long = `${'um '.repeat(30)}hey ra one`;
    expect(matchWakePhrase(long).matched).toBe(false);
  });

  it('preserves remainder after wake (wake + question)', () => {
    const hit = matchWakePhrase('Hey RA-ONE what are the challenges in labour market analysis');
    expect(hit.matched).toBe(true);
    expect(hit.remainder).toMatch(/challenges/);
  });

  it('normalizes punctuation', () => {
    expect(normalizeTranscript('Hey, RA-ONE!!!')).toContain('hey');
  });
});
