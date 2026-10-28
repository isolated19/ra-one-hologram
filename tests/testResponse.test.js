import { describe, expect, it } from 'vitest';
import {
  TestResponseService,
  TEST_FALLBACK_RESPONSE,
} from '../src/assistant/TestResponseService.js';

const svc = new TestResponseService();

describe('Module 2 TestResponseService', () => {
  it('TC-09 identity', () => {
    const r = svc.respond('Who are you?');
    expect(r.id).toBe('identity');
    expect(r.response).toMatch(/I am RA-ONE/);
  });

  it('TC-10 labour challenges includes six themes', () => {
    const r = svc.respond('What are the challenges in labour market analysis?');
    expect(r.id).toBe('labour-challenges');
    const text = r.response.toLowerCase();
    for (const key of [
      'outdated',
      'skill',
      'regional',
      'mismatch',
      'privacy',
      'hiring',
    ]) {
      expect(text).toContain(key);
    }
  });

  it('TC-11 unsupported fallback', () => {
    const r = svc.respond('What is the price of bitcoin tomorrow?');
    expect(r.id).toBe('unsupported');
    expect(r.response).toBe(TEST_FALLBACK_RESPONSE);
  });

  it('greeting', () => {
    expect(svc.respond('Hello').id).toBe('greeting');
    expect(svc.respond('Hi there').response).toMatch(/How can I assist/);
  });

  it('capabilities', () => {
    expect(svc.respond('What can you do?').id).toBe('capabilities');
  });
});
