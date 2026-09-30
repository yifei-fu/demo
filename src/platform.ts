/** Small platform helpers used by the Begin tap: wake lock, fullscreen, device class. */

export const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** A touch device with a small screen gets the phone particle budget. */
export const isPhone = (): boolean =>
  matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;

let wakeLock: WakeLockSentinel | null = null;
let wakeWanted = false;

async function acquire(): Promise<void> {
  if (!wakeWanted || document.visibilityState !== 'visible') return;
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    wakeLock?.addEventListener('release', () => (wakeLock = null));
  } catch {
    wakeLock = null; // denied or unsupported: the screen may dim, nothing else
  }
}

/** Keep the screen awake; re-acquired whenever the page becomes visible again. */
export function keepAwake(): void {
  if (wakeWanted) return;
  wakeWanted = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) void acquire();
  });
  void acquire();
}

/** Fullscreen where it exists; iOS Safari has none for pages, so skip it there. */
export function enterFullscreen(): void {
  if (isIOS() || document.fullscreenElement) return;
  const el = document.documentElement;
  try {
    void el.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined);
  } catch {
    /* fullscreen refused: not essential */
  }
}
