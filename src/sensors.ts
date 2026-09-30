/** All senses in one place: device attitude, motion, pointers and keys feed one smoothed Input. */
import { deadZone, poseFromEuler, tiltFromPose, wrapAngle, type Pose } from './attitude';
import { createInput, type Input } from './input';
import { Pointers } from './pointers';

const TILT_DEAD_ZONE = 0.07;
const TILT_TAU = 0.07;
const YAW_TAU = 0.09;
const PARALLAX_TAU = 0.28;
const SHAKE_ACCEL = 12; // m/s^2, gravity-free
const SHAKE_HIGHPASS = 15;
const SHAKE_REFRACTORY_MS = 700;
const G = 9.81;

interface PermissionAPI {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

const smoothing = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

export class Sensors {
  readonly input: Input = createInput();
  /** Fires on every shake, from the accelerometer, the keyboard or a test hook. */
  onShake: (() => void) | null = null;

  private readonly pointers: Pointers;
  /** true once any real orientation reading has arrived (a phone without a gyro never sets it) */
  hasMotion = false;
  private armed = false;
  private rest: Pose | null = null;
  private restScreenAngle = 0;
  private latest: Pose | null = null;
  private latestAngle = 0;
  private lastHeading: number | null = null;
  private yawRaw = 0;
  private yawSmooth = 0;
  private rawTilt: [number, number] = [0, 0];
  private tilt: [number, number] = [0, 0];
  private joy: [number, number] = [0, 0];
  private parallax: [number, number] = [0, 0];
  private lastShake = -1e9;
  private gravityLp: [number, number, number] | null = null;
  private shakePending = false;

  constructor(target: HTMLElement) {
    this.pointers = new Pointers(target);
    this.pointers.onShake = () => this.fireShake();
    // Real DOM events on window: physical sensors and test tooling both dispatch there.
    window.addEventListener('deviceorientation', this.onOrientation);
    window.addEventListener('devicemotion', this.onMotion);
    screen.orientation?.addEventListener('change', () => (this.rest = null));
  }

  /**
   * Ask for iOS motion permissions. Must be called synchronously inside the Begin tap; the returned
   * promise resolves when the user has answered (or immediately where no prompt exists).
   */
  requestPermissions(): Promise<void> {
    const asks: Promise<unknown>[] = [];
    for (const api of [DeviceOrientationEvent, DeviceMotionEvent] as unknown as PermissionAPI[]) {
      if (typeof api.requestPermission === 'function')
        asks.push(api.requestPermission().catch(() => 'denied'));
    }
    return Promise.all(asks).then(() => undefined);
  }

  /** Start acting on input. The rest pose is the attitude at this instant (or the next event). */
  arm(): void {
    this.armed = true;
    this.pointers.enabled = true;
    this.rest = this.latest;
    this.restScreenAngle = this.latestAngle;
    this.lastHeading = this.latest ? this.latest.heading : null;
    this.yawRaw = 0;
    this.yawSmooth = 0;
  }

  /** Programmatic hooks used by tests and the debug tooling. */
  fireShake(): void {
    this.shakePending = true;
    this.onShake?.();
  }
  /** While the map is open, single touches belong to it; only pinching (to close it) is heard. */
  setMapOpen(open: boolean): void {
    this.pointers.suspended = open;
  }
  setDive(v: number): void {
    this.pointers.setDive(v);
  }
  setOrbit(yaw?: number, pitch?: number): void {
    this.pointers.setOrbit(yaw, pitch);
  }

  update(dt: number, now: number): Input {
    const inp = this.input;
    inp.active = false;
    inp.shake = this.shakePending;
    this.shakePending = false;
    this.pointers.apply(inp, now);

    const kt = smoothing(dt, TILT_TAU);
    const jx = this.pointers.joystick[0];
    const jy = this.pointers.joystick[1];
    this.joy[0] += (jx - this.joy[0]) * smoothing(dt, 0.12);
    this.joy[1] += (jy - this.joy[1]) * smoothing(dt, 0.12);
    const [dx, dy] = deadZone(this.rawTilt[0], this.rawTilt[1], TILT_DEAD_ZONE);
    this.tilt[0] += (dx - this.tilt[0]) * kt;
    this.tilt[1] += (dy - this.tilt[1]) * kt;
    inp.tilt[0] = this.tilt[0] + this.joy[0];
    inp.tilt[1] = this.tilt[1] + this.joy[1];
    if (dx !== 0 || dy !== 0 || inp.shake) inp.active = true;

    // parallax follows attitude on a phone and the hovering mouse on a desktop
    const kp = smoothing(dt, PARALLAX_TAU);
    const hover = this.pointers.hover;
    const px = Math.max(-1, Math.min(1, this.rawTilt[0])) + hover[0] * 0.8;
    const py = Math.max(-1, Math.min(1, this.rawTilt[1])) + hover[1] * 0.8;
    this.parallax[0] += (px - this.parallax[0]) * kp;
    this.parallax[1] += (py - this.parallax[1]) * kp;
    inp.parallax[0] = this.parallax[0];
    inp.parallax[1] = this.parallax[1];

    this.yawSmooth += (this.yawRaw - this.yawSmooth) * smoothing(dt, YAW_TAU);
    inp.yaw = this.yawSmooth;
    return inp;
  }

  private screenAngle(): number {
    return screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0;
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    this.hasMotion = true;
    const angle = this.screenAngle();
    const pose = poseFromEuler(e.alpha ?? 0, e.beta, e.gamma, angle);
    this.latest = pose;
    this.latestAngle = angle;
    if (!this.armed) return;
    if (!this.rest || angle !== this.restScreenAngle) {
      this.rest = pose;
      this.restScreenAngle = angle;
      this.lastHeading = pose.heading;
    }
    this.rawTilt = tiltFromPose(pose, this.rest);
    if (pose.headingConfidence > 0.3 && this.lastHeading !== null) {
      // heading grows counter-clockwise; turning right (clockwise) must increase yaw
      this.yawRaw -= wrapAngle(pose.heading - this.lastHeading);
      this.lastHeading = pose.heading;
    }
  };

  private onMotion = (e: DeviceMotionEvent): void => {
    if (!this.armed) return;
    let mag = 0;
    const a = e.acceleration;
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      mag = Math.hypot(a.x, a.y, a.z) / SHAKE_ACCEL;
    } else {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x === null || g.y === null || g.z === null) return;
      const lp = (this.gravityLp ??= [g.x, g.y, g.z]);
      const k = smoothing(Math.max(0.004, (e.interval || 16) / 1000), 0.4);
      lp[0] += (g.x - lp[0]) * k;
      lp[1] += (g.y - lp[1]) * k;
      lp[2] += (g.z - lp[2]) * k;
      const hp = Math.hypot(g.x - lp[0], g.y - lp[1], g.z - lp[2]);
      // a lone spike also shows up as a departure of |a| from 1 g
      const dev = Math.abs(Math.hypot(g.x, g.y, g.z) - G) * 1.6;
      mag = Math.max(hp, dev) / SHAKE_HIGHPASS;
    }
    const now = performance.now();
    if (mag >= 1 && now - this.lastShake > SHAKE_REFRACTORY_MS) {
      this.lastShake = now;
      this.fireShake();
    }
  };
}
