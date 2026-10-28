/**
 * Module 6 — login-item preference helpers (pure logic mirrored from main.cjs).
 * Electron APIs are not available under Vitest; we unit-test the pref file contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makePrefApi(dir) {
  const file = path.join(dir, 'login-pref.json');
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    write(openAtLogin) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ openAtLogin: !!openAtLogin }, null, 2));
    },
    /** Same rule as applyLoginItemOnStartup: null pref → enable once. */
    resolveWanted() {
      const pref = this.read();
      if (pref === null) return true;
      return !!pref.openAtLogin;
    },
  };
}

describe('Module 6 login preference', () => {
  let dir;
  let api;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raone-login-'));
    api = makePrefApi(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to openAtLogin true when no pref file exists', () => {
    expect(api.read()).toBeNull();
    expect(api.resolveWanted()).toBe(true);
  });

  it('persists an explicit disable across restarts', () => {
    api.write(false);
    expect(api.read()).toEqual({ openAtLogin: false });
    expect(api.resolveWanted()).toBe(false);
  });

  it('persists an explicit enable', () => {
    api.write(true);
    expect(api.resolveWanted()).toBe(true);
  });
});
