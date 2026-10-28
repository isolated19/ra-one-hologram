import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../src/assistant/identityConfig.js';
import {
  isNonWakeBackground,
  matchSleepCommand,
  matchWakePhrase,
  toSpokenText,
} from '../src/assistant/nameNormalizer.js';

describe('TC-01 display name', () => {
  it('is always RA-ONE', () => {
    expect(IDENTITY.displayName).toBe('RA-ONE');
    expect(IDENTITY.canonicalId).toBe('ra_one');
  });
});

describe('TC-02 TTS pronunciation', () => {
  it('converts RA-ONE to Raw-One without changing display string', () => {
    const display = 'I am RA-ONE. How can I assist you?';
    expect(toSpokenText(display)).toBe('I am Raw-One. How can I assist you?');
    expect(display).toContain('RA-ONE');
  });

  it('handles letter-spaced and Ray One variants', () => {
    expect(toSpokenText('R A - ONE online')).toMatch(/Raw-One/);
    expect(toSpokenText('Ray One ready')).toBe('Raw-One ready');
  });

  it('supports phonetic override', () => {
    expect(toSpokenText('I am RA-ONE.', { usePhonetic: true })).toContain('Rawwun');
  });
});

describe('TC-03..06 wake phrases', () => {
  it.each([
    ['Hey RA-ONE', 'hey', ''],
    ['Hi RA-ONE', 'hi', ''],
    ['RA-ONE', null, ''],
    ['Hey Raw One', 'hey', ''],
    ['Hi Raw One', 'hi', ''],
    ['Raw One', null, ''],
    ['Ray One', null, ''],
    ['R A One', null, ''],
    ['Are A One', null, ''],
  ])('matches %s', (phrase, greeting, rem) => {
    const hit = matchWakePhrase(phrase);
    expect(hit.matched).toBe(true);
    expect(hit.canonical).toBe('ra_one');
    expect(hit.greeting).toBe(greeting);
    expect(hit.remainder).toBe(rem);
  });

  it('TC-12 preserves question after wake', () => {
    const hit = matchWakePhrase('Hey RA-ONE, what is artificial intelligence?');
    expect(hit.matched).toBe(true);
    expect(hit.remainder).toMatch(/artificial intelligence/);
  });
});

describe('TC-07 background speech', () => {
  it('does not wake on unrelated talk', () => {
    expect(matchWakePhrase('what time is the meeting tomorrow').matched).toBe(false);
    expect(isNonWakeBackground('please pass the salt')).toBe(true);
    expect(matchWakePhrase('random one two three').matched).toBe(false);
  });
});

describe('TC-18 sleep commands', () => {
  it.each([
    'RA-ONE, go to sleep',
    'RA-ONE sleep now',
    'Hey RA-ONE stop listening',
  ])('detects %s', (phrase) => {
    expect(matchSleepCommand(phrase).matched).toBe(true);
  });
});
