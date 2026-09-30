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
const TAU_EQUALISE = 0.8;
/** Easing of the readings variants may sample (axiom_dky, axiom_still). */
const TAU_LIVE = 0.5;
/** Slowest reference speed (world units / s) dwell equalisation will use. */
const REF_SPEED_MIN = 0.15;
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

/** What the frame's shaders are told about the attractor, all eased. Shared by reference. */
export interface SceneTone {
  /** Slowish speed of the settled cloud (world units / s). */
  refSpeed: number;
  /** 0 for a point (keep its star), 1 for an extended attractor (equalise dwell). */
  equalise: number;
  /** Smoothed extent of the attractor (world units). */
  radius: number;
  /** 0..1 depth cue: how volume-filling the attractor is, off while diving. */
  depthCue: number;
  /** Kaplan-Yorke dimension and "stable fixed point" flag, for a variant's axiom_dky / axiom_still. */
  dky: number;
  still: number;
  /** 1 for a closed orbit or torus, whose inside is empty: what lingers there is stranded. */
  hollow: number;
}

export class Framing {
  readonly center: [number, number, number] = [0, 0, 0];
  readonly tone: SceneTone = {
    refSpeed: 0.3,
    equalise: 0,
    radius: 0,
    depthCue: 0,
    dky: 0,
    still: 1,
    hollow: 0,
  };
  /** multiplier on the default camera distance */
  scale = 1;
  private volume = 0;
  private logScale = 0;

  update(measured: Extent | null, dky: number, regime: number, dive: number, dt: number): void {
    const tone = this.tone;
    this.volume +=
      (smoothstep(VOLUME_D0, VOLUME_D1, dky) - this.volume) * (1 - Math.exp(-dt / TAU_SIZE));
    tone.depthCue = this.volume * (1 - dive);
    const kl = 1 - Math.exp(-dt / TAU_LIVE);
    tone.dky += (dky - tone.dky) * kl;
    tone.still += ((regime === 0 ? 1 : 0) - tone.still) * kl;
    tone.hollow += ((regime === 1 || regime === 2 ? 1 : 0) - tone.hollow) * kl;
    if (!measured) return;
    const kc = 1 - Math.exp(-dt / TAU_CENTER);
    for (let i = 0; i < 3; i++)
      this.center[i] += (measured.center[i] * CENTER_FOLLOW - this.center[i]) * kc;

    tone.radius += (measured.radius - tone.radius) * (1 - Math.exp(-dt / TAU_SIZE));
    // (floored, so a cloud still parked on the old star cannot make "slow" the norm)
    const ref = Math.max(REF_SPEED_MIN, measured.speed);
    tone.refSpeed += (ref - tone.refSpeed) * (1 - Math.exp(-dt / TAU_SIZE));
    // A law that is not a stable fixed point makes slow particles a hotspot straight away, even if
    // most of the cloud has not left the old star yet; only a true fixed point keeps its star.
    // Volume-filling fog has no hotspot, and weighting a periodic speed field only prints it.
    const gate =
      (regime === 0 ? smoothstep(POINT_RADIUS, POINT_FULL, tone.radius) : 1) * (1 - this.volume);
    tone.equalise += (gate - tone.equalise) * (1 - Math.exp(-dt / TAU_EQUALISE));
    const fit = Math.min(SCALE_MAX, Math.max(SCALE_MIN, tone.radius / RADIUS_AT_UNITY));
    const target = Math.log(fit) * smoothstep(POINT_RADIUS, POINT_FULL, tone.radius);
    const step = MAX_LOG_RATE * dt;
    this.logScale += Math.min(step, Math.max(-step, target - this.logScale));
    this.scale = Math.exp(this.logScale);
  }
}
