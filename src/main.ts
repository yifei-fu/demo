/** Boot: WebGPU + core, start gate, frame loop, adaptive quality, sound, map, test hooks. */
import './style.css';
import { Engine } from './engine';
import { parseFlags } from './flags';
import { initGpu, watchHdr, type Gpu } from './gpu';
import { bindHooks, installHooks } from './hooks';
import { Hints } from './hints';
import { Hud, showFallback } from './hud';
import { createParamMap } from './map';
import { PerfProbe } from './perf';
import { enterFullscreen, isPhone, keepAwake } from './platform';
import { Quality } from './quality';
import { Sound } from './sound';
import { applyTheme } from './theme';
import { pickVariant, VARIANTS } from './variants';
import { loadCore, type Core } from './wasm';

const PHONE_PARTICLES = 262_144;
const DESKTOP_PARTICLES = 1_048_576;
const MAX_IN_FLIGHT = 3;
/** Longest frame the simulation will integrate in one go; slower frames run in slow motion. */
const MAX_FRAME_DT = 1 / 15;
const CPU_SMOOTHING = 0.1;

async function boot(): Promise<void> {
  const flags = parseFlags();
  const variant = pickVariant(flags.variant);
  applyTheme(variant);
  const hooks = installHooks(variant.id);
  const ui = document.getElementById('ui') as HTMLElement;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;

  const [gpu, core] = await Promise.all([
    initGpu(canvas, { hdr: flags.hdr, timestamps: flags.perf }).catch((err): Gpu | null => {
      console.error('[axiom] WebGPU initialisation failed:', err);
      return null;
    }),
    loadCore(flags.seed).catch((err): Core | null => {
      console.error('[axiom] could not load the core:', err);
      return null;
    }),
  ]);
  if (!gpu) return showFallback(ui);
  if (!core) return showFallback(ui, 'AXIOM could not load its core. Reload to try again.');
  watchHdr(gpu, { hdr: flags.hdr });

  const budget = flags.n ?? (isPhone() ? PHONE_PARTICLES : DESKTOP_PARTICLES);
  const engine = new Engine(gpu, core, variant, flags.seed, budget);
  const quality = new Quality(budget);
  const sound = new Sound();

  if (flags.clean) document.body.classList.add('clean');
  if (flags.perf) engine.attachPerf(new PerfProbe(gpu));
  const mapHost = document.createElement('div');
  mapHost.className = 'map-host';
  ui.append(mapHost);
  const hints = new Hints(ui);
  if (!flags.clean)
    engine.attachMap(
      createParamMap(gpu, core, flags.seed, mapHost, variant.hud.accent, variant.hud.theme),
    );

  const hud = new Hud(
    ui,
    {
      onBegin: () => {
        // everything permission- or gesture-bound is started synchronously here, inside the tap
        const answered = engine.sensors.requestPermissions();
        enterFullscreen();
        keepAwake();
        sound.unlock();
        void answered.then(() => {
          engine.sensors.arm();
          engine.begun = true;
          hud.dismissGate();
          hints.afterBegin(engine);
          void sound.start(engine, variant).then((muted) => muted !== null && hud.setMuted(muted));
        });
      },
      onMute: (muted) => sound.setMuted(muted),
    },
    {
      debug: flags.debug,
      perf: flags.perf,
      gate: !flags.skipintro,
      variants: VARIANTS,
      current: variant.id,
      seed: flags.seed,
    },
  );
  void gpu.lost.then((reason) => hud.showLost(reason));

  // tests drive the simulation themselves; everyone else opens on a cloud already in flow, which
  // fades in from the dark once its first frame is drawn
  if (!flags.capture) {
    canvas.classList.add('arriving');
    await engine.warmUp();
  }

  if (flags.skipintro) {
    engine.sensors.arm();
    engine.begun = true;
  }

  // with ?debug the engine is reachable from the console, for tuning the look
  if (flags.debug) Object.assign(window, { __axiomEngine: engine });

  let fps = 0;
  const refreshReadout = (): void => hud.setReadout(engine.law, engine.spectrum, engine.time);
  bindHooks(hooks, engine, () => fps, refreshReadout);
  new ResizeObserver(() => engine.resize()).observe(canvas);

  // first frame: the lone point is already burning behind the gate
  engine.advance(1 / 60, true);
  await engine.settled();
  refreshReadout();
  hooks.ready = true;
  requestAnimationFrame(() => canvas.classList.remove('arriving'));
  if (flags.capture) return; // deterministic and silent: frames advance only through __axiom.step

  let last = 0;
  let n = 0;
  let inFlight = 0;
  let cpuMs = 0;
  let lost = false;
  void gpu.lost.then(() => (lost = true));
  const tick = (now: number): void => {
    if (lost) return;
    requestAnimationFrame(tick);
    if (document.hidden) {
      last = 0;
      return;
    }
    // If the GPU is behind, drop the frame instead of queueing more work; the interval between
    // frames we do draw then reflects real GPU throughput, which is what adaptive quality reads.
    if (inFlight >= MAX_IN_FLIGHT) return;
    const ms = last ? now - last : 1000 / 60;
    last = now;
    const t0 = performance.now();
    engine.advance(Math.min(ms / 1000, MAX_FRAME_DT), true);
    sound.frame(engine);
    cpuMs += (performance.now() - t0 - cpuMs) * CPU_SMOOTHING;
    inFlight++;
    void engine.settled().then(() => inFlight--);

    const change = quality.sample(ms, now);
    if (change) {
      engine.particles.setCount(change.particles);
      if (change.scale !== engine.scale) engine.setScale(change.scale);
    }
    fps = 1000 / quality.frameMs;
    if (++n % 6 === 0) {
      refreshReadout();
      hints.update(engine, now);
    }
    if (flags.perf && n % 12 === 0) {
      const gpuMs = engine.perf?.gpuMs;
      hud.setPerf(
        `${quality.frameMs.toFixed(1)} ms  ${fps.toFixed(0)} fps\n` +
          (gpuMs != null ? `gpu ${gpuMs.toFixed(1)} ms` : 'gpu n/a') +
          `  cpu ${cpuMs.toFixed(1)} ms\n` +
          `x${engine.scale.toFixed(2)}  ${(engine.particles.active / 1000).toFixed(0)}k`,
      );
    }
    if (flags.debug && n % 15 === 0) {
      hud.setDebug(
        `${fps.toFixed(0)} fps  ${quality.frameMs.toFixed(1)} ms\n` +
          `scale ${engine.scale.toFixed(2)}  ${engine.width}x${engine.height}\n` +
          `n ${engine.particles.active}  bead ${engine.bead.u.toFixed(2)} ${engine.bead.v.toFixed(2)}` +
          `${engine.bead.autopilot ? ' auto' : ''}\n` +
          `${gpu.extended ? `hdr x${gpu.hdrHeadroom.toFixed(1)}` : 'sdr'}  ${variant.id}  seed ${flags.seed}`,
      );
    }
  };
  requestAnimationFrame(tick);
}

void boot();
