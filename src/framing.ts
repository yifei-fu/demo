/**
 * Auto-framing: keep the attractor centred and about three quarters of the short side wide.
 * Measurements arrive a few times a second and are eased hard, so a loop growing out of a point
 * makes the camera drift back gently and never pumps.
 */
import type { Extent } from './extent';

/** Radius (world units, 90th percentile) that fills about 75 % of the short side at the default distance. */
const RADIUS_AT_UNITY = 0.74;
const SCALE_MIN = 0.9;
const SCALE_MAX = 1.7;
/** Below this radius the cloud is a point: hold the default framing. */
const POINT_RADIUS = 0.05;
const POINT_FULL = 0.22;
const TAU_SIZE = 2;
const TAU_CENTER = 3;
/** Largest change of ln(distance) per second. */
const MAX_LOG_RATE = 0.22;
const CENTER_FOLLOW = 0.95;
/** Kaplan-Yorke dimensions between which an attractor counts as volume-filling. */
const VOLUME_D0 = 2.15;
const VOLUME_D1 = 2.7;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Framing {
  readonly center: [number, number, number] = [0, 0, 0];
  /** multiplier on the default camera distance */
  scale = 1;
  /** Slowish speed of the settled cloud (world units / s), eased. */
  refSpeed = 0.3;
  /** 0 for a point (keep its star), 1 for an extended attractor (equalise dwell). */
  equalise = 0;
  /** How volume-filling the attractor is, 0..1 (from its Kaplan-Yorke dimension). */
  volume = 0;
  private radius = 0;
  private logScale = 0;

  /** Smoothed extent of the attractor (world units), for depth cueing. */
  get size(): number {
    return this.radius;
  }

  update(measured: Extent | null, dky: number, dt: number): void {
    this.volume +=
      (smoothstep(VOLUME_D0, VOLUME_D1, dky) - this.volume) * (1 - Math.exp(-dt / TAU_SIZE));
    if (!measured) return;
    const kc = 1 - Math.exp(-dt / TAU_CENTER);
    for (let i = 0; i < 3; i++)
      this.center[i] += (measured.center[i] * CENTER_FOLLOW - this.center[i]) * kc;

    this.radius += (measured.radius - this.radius) * (1 - Math.exp(-dt / TAU_SIZE));
    this.refSpeed += (measured.speed - this.refSpeed) * (1 - Math.exp(-dt / TAU_SIZE));
    this.equalise = smoothstep(POINT_RADIUS, POINT_FULL, this.radius);
    const fit = Math.min(SCALE_MAX, Math.max(SCALE_MIN, this.radius / RADIUS_AT_UNITY));
    const target = Math.log(fit) * smoothstep(POINT_RADIUS, POINT_FULL, this.radius);
    const step = MAX_LOG_RATE * dt;
    this.logScale += Math.min(step, Math.max(-step, target - this.logScale));
    this.scale = Math.exp(this.logScale);
  }
}
