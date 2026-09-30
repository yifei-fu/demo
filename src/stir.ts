/** Touch-drag stirring: eases raw pointer input into the force the particle pass applies. */
import type { StirParams } from './particles';

const STRENGTH = 1;
/** Seconds the gain takes to rise while a finger is down, and to fall once it lifts. */
const ATTACK = 0.08;
const RELEASE = 0.25;
/** A test-hook stir lasts this long, fading over the last `HOOK_FADE`. */
const HOOK_SECONDS = 0.6;
const HOOK_FADE = 0.25;

interface PointerStir {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export class Stir {
  /** The parameters for this frame's particle pass (one object, rewritten in place). */
  readonly params: StirParams = { active: false, x: 0, y: 0, vx: 0, vy: 0, strength: 0 };
  /** 0..1 stirring energy, for the sound of it. */
  level = 0;
  private gain = 0;
  private hook: { x: number; y: number; strength: number; left: number } | null = null;

  /** Fake a drag at `x, y` (NDC) for a short while; the test hook. */
  inject(x: number, y: number, strength: number): void {
    this.hook = { x, y, strength, left: HOOK_SECONDS };
  }

  update(s: PointerStir, dt: number): void {
    let active = s.active;
    let { x, y, vx, vy } = s;
    let strength = STRENGTH;
    const h = this.hook;
    if (h && !active) {
      h.left -= dt;
      if (h.left > 0) {
        active = true;
        x = h.x;
        y = h.y;
        vx = vy = 0;
        strength = h.strength * Math.min(1, h.left / HOOK_FADE);
      } else this.hook = null;
    }
    const target = active ? 1 : 0;
    this.gain += (target - this.gain) * (1 - Math.exp(-dt / (active ? ATTACK : RELEASE)));
    if (this.gain < 0.002) this.gain = 0;
    this.level = Math.min(1, this.gain * strength * (0.45 + 0.35 * Math.hypot(vx, vy)));
    const out = this.params;
    out.active = this.gain > 0;
    out.x = x;
    out.y = y;
    out.vx = vx;
    out.vy = vy;
    out.strength = strength * this.gain;
  }
}
