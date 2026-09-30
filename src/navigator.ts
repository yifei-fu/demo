/** Bead physics on the parameter disk, the idle autopilot and the camera rig. */
import type { Input } from './input';

const TAU = Math.PI * 2;
const TILT_GAIN = 1.45; // disk radii per second^2 at full tilt
const FRICTION = 2.3; // 1/s
const WALL_START = 0.9;
const WALL_DRAG = 30;
const IDLE_SECONDS = 20;
const AUTOPILOT_RAMP = 6;

export const DIST_FAR = 3.2;
export const DIST_NEAR = 0.25;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Rolling-ball physics with a soft rim, and a slow wandering autopilot when nobody is there. */
export class Bead {
  u = 0;
  v = 0;
  private vu = 0;
  private vv = 0;
  private idle = 0;
  private ap = 0; // autopilot blend 0..1
  private path = { phase: 0, angle: 0, t: 0 };

  set(u: number, v: number): void {
    const r = Math.hypot(u, v);
    const k = r > 1 ? 1 / r : 1;
    this.u = u * k;
    this.v = v * k;
    this.vu = 0;
    this.vv = 0;
    this.cancelAutopilot();
  }

  get autopilot(): boolean {
    return this.ap > 0;
  }

  private cancelAutopilot(): void {
    this.idle = 0;
    this.ap = 0;
  }

  update(input: Input, dt: number, autopilotAllowed = true): void {
    if (input.active || !autopilotAllowed) this.cancelAutopilot();
    else {
      this.idle += dt;
      if (this.idle > IDLE_SECONDS) {
        if (this.ap === 0) this.beginPath();
        this.ap = Math.min(1, this.ap + dt / AUTOPILOT_RAMP);
      }
    }

    let au = input.tilt[0] * TILT_GAIN;
    let av = input.tilt[1] * TILT_GAIN;

    if (this.ap > 0) {
      const [tu, tv] = this.pathPoint(dt);
      // critically damped pull toward the path point, faded in so the hand-over has no jerk
      const k = 0.9;
      au += this.ap * ((tu - this.u) * k - this.vu * 2 * Math.sqrt(k) + FRICTION * this.vu);
      av += this.ap * ((tv - this.v) * k - this.vv * 2 * Math.sqrt(k) + FRICTION * this.vv);
    }

    const damp = Math.exp(-FRICTION * dt);
    this.vu = (this.vu + au * dt) * damp;
    this.vv = (this.vv + av * dt) * damp;

    // soft rim: outward speed is bled off ever harder toward r = 1, so the bead glides to a stop
    // against the wall and a bead resting in the rim zone stays where it was put
    const r = Math.hypot(this.u, this.v);
    if (r > WALL_START) {
      const nu = this.u / r;
      const nv = this.v / r;
      const vr = this.vu * nu + this.vv * nv;
      if (vr > 0) {
        const s = (r - WALL_START) / (1 - WALL_START);
        const keep = Math.exp(-WALL_DRAG * s * s * dt);
        this.vu -= vr * (1 - keep) * nu;
        this.vv -= vr * (1 - keep) * nv;
      }
    }
    this.u += this.vu * dt;
    this.v += this.vv * dt;

    const r2 = Math.hypot(this.u, this.v);
    if (r2 > 1) {
      const nu = this.u / r2;
      const nv = this.v / r2;
      const vr = this.vu * nu + this.vv * nv;
      if (vr > 0) {
        this.vu -= vr * nu;
        this.vv -= vr * nv;
      }
      this.u = nu;
      this.v = nv;
    }
  }

  /** Start the path at the bead's current radius and angle so nothing jumps. */
  private beginPath(): void {
    const r = clamp(Math.hypot(this.u, this.v) / 0.96, 0, 1);
    this.path = { phase: Math.acos(1 - 2 * r), angle: Math.atan2(this.v, this.u), t: 0 };
  }

  /** Centre -> mid -> rim -> mid -> centre in about a minute, angle wandering on incommensurate beats. */
  private pathPoint(dt: number): [number, number] {
    const p = this.path;
    p.t += dt * this.ap;
    const s = 0.5 - 0.5 * Math.cos(p.phase + (TAU * p.t) / 62);
    const r = clamp(0.96 * smoothstep(s) + 0.035 * Math.sin((TAU * p.t) / 11.3), 0, 0.97);
    const a = p.angle + (TAU * p.t) / 43 + 0.8 * Math.sin((TAU * p.t) / 27);
    return [r * Math.cos(a), r * Math.sin(a)];
  }
}

export interface CameraState {
  eye: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  fwd: [number, number, number];
  /** distance from the eye to the centre of the attractor */
  dist: number;
  /** focal-plane distance for depth of field */
  focus: number;
  /** 0..1 dive amount */
  dive: number;
  /** how fast the view is changing, for reducing trail smear */
  motion: number;
}

/** Orbit camera: azimuth from body yaw + drag + slow drift; a spring-driven dive toward the core. */
export class CameraRig {
  readonly state: CameraState = {
    eye: [0, 0, DIST_FAR],
    right: [1, 0, 0],
    up: [0, 1, 0],
    fwd: [0, 0, -1],
    dist: DIST_FAR,
    focus: DIST_FAR,
    dive: 0,
    motion: 0,
  };
  private dive = 0;
  private diveVel = 0;
  private prevAz = 0;
  private prevPitch = 0;
  private prevLogDist = Math.log(DIST_FAR);
  private time = 0;

  /** Snap the dive spring (test hook); the matching manual target lives in Input. */
  snapDive(dive: number): void {
    this.dive = clamp(dive, 0, 1);
    this.diveVel = 0;
  }

  /**
   * `recede` is a fraction of extra distance (e.g. while the map is open); `look` is the point the
   * camera orbits and looks at, the centre of the attractor rather than always the origin.
   */
  update(
    input: Input,
    dt: number,
    recede = 0,
    look: readonly [number, number, number] = [0, 0, 0],
  ): CameraState {
    this.time += dt;
    const target = Math.max(input.dive, input.hold ? 1 : 0);
    // stiffer going in than coming out: diving is intent, drifting back is release
    const w = target > this.dive ? 4.2 : 2.4;
    const acc = (target - this.dive) * w * w - 2 * w * this.diveVel;
    this.diveVel += acc * dt;
    this.dive = clamp(this.dive + this.diveVel * dt, 0, 1);
    if (this.dive === 0 || this.dive === 1) this.diveVel = 0;

    const ease = smoothstep(this.dive);
    const dist = DIST_FAR * Math.pow(DIST_NEAR / DIST_FAR, ease) * (1 + recede);

    const drift = 0.012 * this.time + 0.18 * Math.sin(this.time * 0.05);
    const az = input.yaw + input.orbitYaw + drift;
    const pitch = clamp(0.2 + input.orbitPitch + input.parallax[1] * 0.03, -1.35, 1.35);

    const cp = Math.cos(pitch);
    const base: [number, number, number] = [
      Math.sin(az) * cp * dist,
      Math.sin(pitch) * dist,
      Math.cos(az) * cp * dist,
    ];
    // holographic parallax: slide the eye sideways/up a little while still looking at the target
    const rx = Math.cos(az);
    const rz = -Math.sin(az);
    const par = dist * 0.09;
    const eye: [number, number, number] = [
      base[0] + rx * input.parallax[0] * par,
      base[1] + input.parallax[1] * par * 0.6,
      base[2] + rz * input.parallax[0] * par,
    ];

    const s = this.state;
    const len = Math.hypot(eye[0], eye[1], eye[2]) || 1;
    s.fwd = [-eye[0] / len, -eye[1] / len, -eye[2] / len];
    // right = normalize(fwd x worldUp), up = right x fwd
    let r: [number, number, number] = [-s.fwd[2], 0, s.fwd[0]];
    const rl = Math.hypot(r[0], r[2]) || 1;
    r = [r[0] / rl, 0, r[2] / rl];
    s.right = r;
    s.up = [
      r[1] * s.fwd[2] - r[2] * s.fwd[1],
      r[2] * s.fwd[0] - r[0] * s.fwd[2],
      r[0] * s.fwd[1] - r[1] * s.fwd[0],
    ];
    s.eye = [eye[0] + look[0], eye[1] + look[1], eye[2] + look[2]];
    s.dist = len;
    s.dive = this.dive;
    s.focus = len * (1 - 0.45 * ease);

    const logDist = Math.log(len);
    const rate =
      (Math.abs(az - this.prevAz) +
        Math.abs(pitch - this.prevPitch) +
        Math.abs(logDist - this.prevLogDist)) /
      Math.max(dt, 1e-3);
    s.motion += (rate - s.motion) * (1 - Math.exp(-dt / 0.12));
    this.prevAz = az;
    this.prevPitch = pitch;
    this.prevLogDist = logDist;
    return s;
  }
}
