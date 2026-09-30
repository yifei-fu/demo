/**
 * Adaptive quality: an EMA of frame time with hysteresis. Drop resolution first (0.5..1.0),
 * then the particle count; creep back up only after a long stretch of headroom.
 */

export interface QualityChange {
  scale: number;
  particles: number;
}

const SCALE_MIN = 0.5;
const SCALE_STEP = 0.1;
const PARTICLE_FLOOR = 0.25; // never below a quarter of the budget
const SLOW_MS = 21; // ~ below 48 fps
const FAST_MS = 17.6; // comfortably at 60 fps
const MAX_SAMPLE_MS = 1000;
const WARMUP_MS = 2500;
const DOWN_AFTER_MS = 700;
const UP_AFTER_MS = 6000;
const UP_AFTER_MAX_MS = 60000;
const RETRY_WINDOW_MS = 15000;
const COOLDOWN_MS = 1800;

export class Quality {
  scale = 1;
  particles: number;
  private ema = 16.7;
  private slowFor = 0;
  private fastFor = 0;
  private lastChange = 0;
  private started = -1;
  private upAfter = UP_AFTER_MS;
  private lastUp = -1e9;

  constructor(private readonly budget: number) {
    this.particles = budget;
  }

  get frameMs(): number {
    return this.ema;
  }

  /** Feed one frame interval (ms); returns the new settings when they change. */
  sample(frameMs: number, now: number): QualityChange | null {
    if (this.started < 0) this.started = now;
    if (frameMs <= 0) return null;
    frameMs = Math.min(frameMs, MAX_SAMPLE_MS); // hidden-tab gaps never reach here; slow frames must
    this.ema += (frameMs - this.ema) * 0.06;
    if (now - this.started < WARMUP_MS || now - this.lastChange < COOLDOWN_MS) return null;

    if (this.ema > SLOW_MS) {
      this.slowFor += frameMs;
      this.fastFor = 0;
    } else if (this.ema < FAST_MS) {
      this.fastFor += frameMs;
      this.slowFor = 0;
    } else {
      this.slowFor = this.fastFor = 0;
    }

    if (this.slowFor > DOWN_AFTER_MS) {
      this.slowFor = 0;
      // stepping back up did not hold: wait longer before trying again
      if (now - this.lastUp < RETRY_WINDOW_MS)
        this.upAfter = Math.min(UP_AFTER_MAX_MS, this.upAfter * 2);
      if (this.scale > SCALE_MIN + 1e-6) {
        // far below target (under ~25 fps): take a bigger step
        const step = this.ema > 40 ? 2 * SCALE_STEP : SCALE_STEP;
        this.scale = Math.max(SCALE_MIN, +(this.scale - step).toFixed(2));
      } else if (this.particles > this.budget * PARTICLE_FLOOR) {
        this.particles = Math.max(this.budget * PARTICLE_FLOOR, Math.floor(this.particles * 0.75));
      } else return null;
      return this.commit(now);
    }
    if (this.fastFor > this.upAfter) {
      this.fastFor = 0;
      if (this.particles < this.budget) {
        this.particles = Math.min(this.budget, Math.floor(this.particles * 1.25));
      } else if (this.scale < 1 - 1e-6) {
        this.scale = Math.min(1, +(this.scale + SCALE_STEP).toFixed(2));
      } else return null;
      this.lastUp = now;
      return this.commit(now);
    }
    return null;
  }

  private commit(now: number): QualityChange {
    this.lastChange = now;
    this.ema = 16.7; // measure afresh under the new settings
    return { scale: this.scale, particles: this.particles };
  }
}
