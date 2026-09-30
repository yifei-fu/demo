/** `window.__axiom`: the test hooks of DESIGN §5. Always present; live once the engine is bound. */
import type { Engine } from './engine';

export interface AxiomStats {
  fps: number;
  scale: number;
  particles: number;
  bead: [number, number];
  regime: number | null;
  dky: number | null;
  variant: string;
}

export interface AxiomHooks {
  ready: boolean;
  setBead(u: number, v: number): void;
  setCamera(c: { yaw?: number; pitch?: number; dive?: number }): void;
  step(frames?: number, dt?: number): Promise<void>;
  shake(): void;
  stir(x: number, y: number, strength: number): void;
  stats(): AxiomStats;
}

declare global {
  interface Window {
    __axiom: AxiomHooks;
  }
}

/** Frames of a `step` that are actually drawn (the rest only simulate, which keeps tests quick). */
const RENDERED_TAIL = 8;

export function installHooks(variant: string): AxiomHooks {
  const hooks: AxiomHooks = {
    ready: false,
    setBead: () => undefined,
    setCamera: () => undefined,
    step: () => Promise.resolve(),
    shake: () => undefined,
    stir: () => undefined,
    stats: () => ({ fps: 0, scale: 1, particles: 0, bead: [0, 0], regime: null, dky: null, variant }),
  };
  window.__axiom = hooks;
  return hooks;
}

export function bindHooks(
  hooks: AxiomHooks,
  engine: Engine,
  variant: string,
  fps: () => number,
  afterStep: () => void,
): void {
  hooks.setBead = (u, v) => engine.setBead(u, v);
  hooks.setCamera = (c) => engine.setCamera(c);
  hooks.shake = () => engine.sensors.fireShake();
  hooks.stir = (x, y, strength) => engine.stir(x, y, strength);
  hooks.step = async (frames = 1, dt = 1 / 60) => {
    const n = Math.max(1, Math.floor(frames));
    for (let i = 0; i < n; i++) engine.advance(dt, i >= n - RENDERED_TAIL);
    await engine.settled();
    afterStep();
  };
  hooks.stats = () => ({
    fps: fps(),
    scale: engine.scale,
    particles: engine.particles.active,
    bead: [engine.bead.u, engine.bead.v],
    regime: null,
    dky: null,
    variant,
  });
}
