/** Boot: WebGPU check, start gate, frame loop, adaptive quality, URL flags and test hooks. */
import './style.css';
import { Engine } from './engine';
import { initGpu, watchHdr, type GpuOptions } from './gpu';
import { bindHooks, installHooks } from './hooks';
import { Hud, showFallback } from './hud';
import { fireBegin, fireBeginTap, fireMute } from './lifecycle';
import { enterFullscreen, isPhone, keepAwake } from './platform';
import { Quality } from './quality';

const PHONE_PARTICLES = 262_144;
const DESKTOP_PARTICLES = 1_048_576;
const MAX_PARTICLES = 4_000_000;

interface Flags {
  seed: number;
  variant: string;
  n: number | null;
  debug: boolean;
  skipintro: boolean;
  capture: boolean;
  hdr: GpuOptions['hdr'];
}

function parseFlags(): Flags {
  const q = new URLSearchParams(location.search);
  const seedParam = Number(q.get('seed'));
  const n = Number(q.get('n'));
  const hdr = q.get('hdr');
  return {
    seed: q.has('seed') && Number.isFinite(seedParam) ? seedParam >>> 0 : (Math.random() * 2 ** 32) >>> 0,
    variant: q.get('v') || 'default',
    n: n > 0 ? Math.min(MAX_PARTICLES, Math.max(1024, Math.floor(n))) : null,
    debug: q.has('debug'),
    skipintro: q.has('skipintro') || q.has('capture'),
    capture: q.has('capture'),
    hdr: hdr === '0' || hdr === '1' ? hdr : 'auto',
  };
}

async function boot(): Promise<void> {
  const flags = parseFlags();
  const hooks = installHooks(flags.variant);
  const ui = document.getElementById('ui') as HTMLElement;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;

  let gpu;
  try {
    gpu = await initGpu(canvas, { hdr: flags.hdr });
  } catch (err) {
    console.error('[axiom] WebGPU initialisation failed:', err);
    gpu = null;
  }
  if (!gpu) {
    showFallback(ui);
    return;
  }
  watchHdr(gpu, { hdr: flags.hdr });

  const budget = flags.n ?? (isPhone() ? PHONE_PARTICLES : DESKTOP_PARTICLES);
  const engine = new Engine(gpu, flags.seed, budget);
  const quality = new Quality(budget);
  const hud = new Hud(
    ui,
    {
      onBegin: () => {
        // everything permission- or gesture-bound is started synchronously here, inside the tap
        const answered = engine.sensors.requestPermissions();
        enterFullscreen();
        keepAwake();
        fireBeginTap();
        void answered.then(() => {
          engine.sensors.arm();
          engine.begun = true;
          hud.dismissGate();
          fireBegin();
        });
      },
      onMute: fireMute,
    },
    { debug: flags.debug, gate: !flags.skipintro },
  );
  void gpu.lost.then((reason) => hud.showLost(reason));

  if (flags.skipintro) {
    engine.sensors.arm();
    engine.begun = true;
  }

  let fps = 0;
  bindHooks(hooks, engine, flags.variant, () => fps, () => hud.setLaw(engine.law));
  new ResizeObserver(() => engine.resize()).observe(canvas);

  // first frame: the lone point is already burning behind the gate
  engine.advance(1 / 60, true);
  await engine.settled();
  hud.setLaw(engine.law);
  hooks.ready = true;
  if (flags.capture) return; // deterministic: frames advance only through __axiom.step

  let last = 0;
  let n = 0;
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    if (document.hidden) {
      last = 0;
      return;
    }
    const ms = last ? now - last : 1000 / 60;
    last = now;
    engine.advance(Math.min(ms, 1000 / 30) / 1000, true);

    const change = quality.sample(ms, now);
    if (change) {
      engine.particles.setCount(change.particles);
      if (change.scale !== engine.scale) engine.setScale(change.scale);
    }
    fps = 1000 / quality.frameMs;
    if (++n % 6 === 0) hud.setLaw(engine.law);
    if (flags.debug && n % 15 === 0) {
      hud.setDebug(
        `${fps.toFixed(0)} fps  ${quality.frameMs.toFixed(1)} ms\n` +
          `scale ${engine.scale.toFixed(2)}  ${engine.width}x${engine.height}\n` +
          `n ${engine.particles.active}  bead ${engine.bead.u.toFixed(2)} ${engine.bead.v.toFixed(2)}` +
          `${engine.bead.autopilot ? ' auto' : ''}\n` +
          `${gpu.extended ? `hdr x${gpu.hdrHeadroom.toFixed(1)}` : 'sdr'}  seed ${flags.seed}`,
      );
    }
  };
  requestAnimationFrame(tick);
}

void boot();
