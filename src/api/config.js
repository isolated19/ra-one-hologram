/**
 * Backend connection settings for Module 1.
 * Override with Vite env: VITE_BACKEND_URL=http://localhost:8000
 * Production builds default to the page's own origin: the desktop backend serves dist/
 * itself, and `vite preview` proxies /api and /ws to :8000 (vite.config.js).
 */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const BACKEND_URL = (
  params.get('backend')
  || import.meta.env.VITE_BACKEND_URL
  || (import.meta.env.DEV || typeof location === 'undefined' ? 'http://localhost:8000' : location.origin)
).replace(/\/$/, '');

export function httpToWs(url) {
  if (url.startsWith('https://')) return `wss://${url.slice(8)}`;
  if (url.startsWith('http://')) return `ws://${url.slice(7)}`;
  return url;
}

export const WS_ASSISTANT_URL = `${httpToWs(BACKEND_URL)}/ws/assistant`;
export const WS_STT_URL = `${httpToWs(BACKEND_URL)}/ws/stt`;

/** 'server' = offline backend STT (default); 'browser' = Chrome Web Speech (needs Google). */
export const STT_PROVIDER = (
  params.get('stt')
  || import.meta.env.VITE_STT_PROVIDER
  || 'server'
) === 'browser' ? 'browser' : 'server';

export const ASSISTANT_STATES = ['idle', 'listening', 'thinking', 'speaking'];
