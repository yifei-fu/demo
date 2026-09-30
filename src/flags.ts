/** URL flags (DESIGN §5). */
import type { GpuOptions } from './gpu';

const MAX_PARTICLES = 4_000_000;

export interface Flags {
  seed: number;
  variant: string | null;
  n: number | null;
  debug: boolean;
  /** no HUD, lens or readout: the render alone, for hero captures */
  clean: boolean;
  /** a tiny frame-time overlay for testing on a real device */
  perf: boolean;
  skipintro: boolean;
  capture: boolean;
  hdr: GpuOptions['hdr'];
}

export function parseFlags(search: string = location.search): Flags {
  const q = new URLSearchParams(search);
  const seedParam = Number(q.get('seed'));
  const n = Number(q.get('n'));
  const hdr = q.get('hdr');
  return {
    seed:
      q.has('seed') && Number.isFinite(seedParam)
        ? seedParam >>> 0
        : (Math.random() * 2 ** 32) >>> 0,
    variant: q.get('v'),
    n: n > 0 ? Math.min(MAX_PARTICLES, Math.max(1024, Math.floor(n))) : null,
    debug: q.has('debug'),
    clean: q.has('clean'),
    perf: q.has('perf'),
    // capture is deterministic and silent, so it implies skipintro
    skipintro: q.has('skipintro') || q.has('capture'),
    capture: q.has('capture'),
    hdr: hdr === '0' || hdr === '1' ? hdr : 'auto',
  };
}
