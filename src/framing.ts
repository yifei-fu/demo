/**
 * Auto-framing: keep the attractor centred and about three quarters of the short side wide.
 * Measurements arrive a few times a second and are eased hard, so a loop growing out of a point
 * makes the camera drift back gently and never pumps.
 */
import type { Extent } from './extent';

/** RMS radius (world units) that fills FILL of the short side at the default distance. */
const RMS_AT_UNITY = 0.42;
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.7;
/** Below this RMS radius the cloud is a point: hold the default framing. */
const POINT_RMS = 0.05;
const POINT_FULL = 0.22;
const TAU_SIZE = 2;
const TAU_CENTER = 3;
/** Largest change of ln(distance) per second. */
const MAX_LOG_RATE = 0.22;
const CENTER_FOLLOW = 0.95;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Framing {
  readonly center: [number, number, number] = [0, 0, 0];
  /** multiplier on the default camera distance */
  scale = 1;
  private rms = 0;
  private logScale = 0;

  update(measured: Extent | null, dt: number): void {
    if (!measured) return;
    const kc = 1 - Math.exp(-dt / TAU_CENTER);
    for (let i = 0; i < 3; i++)
      this.center[i] += (measured.center[i] * CENTER_FOLLOW - this.center[i]) * kc;

    this.rms += (measured.rms - this.rms) * (1 - Math.exp(-dt / TAU_SIZE));
    const fit = Math.min(SCALE_MAX, Math.max(SCALE_MIN, this.rms / RMS_AT_UNITY));
    const target = Math.log(fit) * smoothstep(POINT_RMS, POINT_FULL, this.rms);
    const step = MAX_LOG_RATE * dt;
    this.logScale += Math.min(step, Math.max(-step, target - this.logScale));
    this.scale = Math.exp(this.logScale);
  }
}
