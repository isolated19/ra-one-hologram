/**
 * Page visibility that also works in the desktop shell. Electron runs RA-ONE with
 * backgroundThrottling off (so wake keeps working in the tray), which pins document.hidden
 * to false; the shell's preload reports the real window visibility instead.
 */
const desktop = typeof window !== 'undefined' ? window.raoneDesktop : undefined;

export const isDesktop = !!desktop?.isDesktop;

export function isPageHidden() {
  return desktop ? !desktop.isVisible() : document.hidden;
}

/** Calls fn(hidden) on every change; returns an unsubscribe function. */
export function onPageVisibility(fn) {
  if (desktop) return desktop.onVisibilityChange((visible) => fn(!visible));
  const handler = () => fn(document.hidden);
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
