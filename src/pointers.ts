/** Pointer, wheel and keyboard input: touch hold/drag/pinch and the desktop equivalents. */
import type { Input } from './input';

const HOLD_MS = 220;
const SLOP_PX = 14;
const KEY_TILT: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

interface Touch {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  moved: boolean;
  /** Started on the map, or while it is open: takes part in pinching but never dives or stirs. */
  passive: boolean;
}

const overMap = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest('.map-host') !== null;
const overControl = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest('button, a') !== null;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class Pointers {
  /** Keyboard joystick, smoothed by the owner. */
  readonly joystick: [number, number] = [0, 0];
  /** Mouse hover offset in [-1, 1], for desktop parallax. */
  readonly hover: [number, number] = [0, 0];
  onShake: (() => void) | null = null;
  /** While the map is open every touch is passive, so only pinching (to close it) is heard. */
  suspended = false;

  private readonly touches = new Map<number, Touch>();
  private readonly keys = new Set<string>();
  private orbitYaw = 0;
  private orbitPitch = 0;
  private dive = 0;
  private pinch = 0;
  private pinchDist = 0;
  private pulse = false;
  private mapKey = false;
  private mouseDrag = false;
  private stirV: [number, number] = [0, 0];
  private stirPos: [number, number] = [0, 0];
  private stirLast = 0;
  /** Set by the owner: false while the start gate is up. */
  enabled = false;

  constructor(private readonly el: HTMLElement) {
    // Listen on the document so a pinch that lands on the map still reaches us.
    document.addEventListener('pointerdown', this.down);
    document.addEventListener('pointermove', this.move);
    document.addEventListener('pointerup', this.up);
    document.addEventListener('pointercancel', this.up);
    document.addEventListener('wheel', this.wheel, { passive: false });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', () => this.keys.clear());
    // iOS Safari pinch-zoom gestures would otherwise scale the page
    for (const g of ['gesturestart', 'gesturechange', 'gestureend'])
      document.addEventListener(g, (e) => e.preventDefault());
  }

  /** Fold accumulated pointer state into `input`; marks `input.active` on any human input. */
  apply(input: Input, now: number): void {
    const only = this.touches.size === 1 ? this.touches.values().next().value : undefined;
    const single = only && !only.passive ? only : undefined;
    input.hold = !!single && !single.moved && now - single.t0 > HOLD_MS;
    const dragging = !!single?.moved;
    input.stir.active = dragging;
    if (dragging) {
      // a finger that stops moving stops pushing: decay the last measured velocity
      const fade = Math.exp(-Math.max(0, now - this.stirLast) / 150);
      input.stir.x = this.stirPos[0];
      input.stir.y = this.stirPos[1];
      input.stir.vx = this.stirV[0] * fade;
      input.stir.vy = this.stirV[1] * fade;
    }
    input.orbitYaw = this.orbitYaw;
    input.orbitPitch = this.orbitPitch;
    input.dive = this.dive;
    input.pinch = this.pinch;
    this.pinch = 0;

    let jx = 0;
    let jy = 0;
    for (const k of this.keys) {
      const v = KEY_TILT[k];
      if (v) {
        jx += v[0];
        jy += v[1];
      }
    }
    this.joystick[0] = jx;
    this.joystick[1] = jy;
    if (this.pulse || input.hold || dragging || this.touches.size > 1 || jx !== 0 || jy !== 0)
      input.active = true;
    input.map = this.mapKey;
    if (this.mapKey) input.active = true;
    this.mapKey = false;
    this.pulse = false;
  }

  /** Programmatic dive (test hook): sets the manual dive target. */
  setDive(v: number): void {
    this.dive = clamp(v, 0, 1);
  }
  setOrbit(yaw?: number, pitch?: number): void {
    if (yaw !== undefined) this.orbitYaw = yaw;
    if (pitch !== undefined) this.orbitPitch = pitch;
  }

  private ndc(e: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
  }

  private down = (e: PointerEvent): void => {
    if (!this.enabled || overControl(e.target)) return;
    const passive = this.suspended || overMap(e.target);
    if (e.pointerType === 'mouse') {
      this.mouseDrag = e.button === 0 && !passive;
      this.pulse = true;
      return;
    }
    this.pulse = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this.touches.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      t0: performance.now(),
      moved: false,
      passive,
    });
    this.stirPos = this.ndc(e);
    this.stirV = [0, 0];
    this.stirLast = performance.now();
    if (this.touches.size === 2) this.pinchDist = this.touchDistance();
  };

  private move = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      this.hover[0] = clamp((e.clientX / innerWidth) * 2 - 1, -1, 1);
      this.hover[1] = clamp(1 - (e.clientY / innerHeight) * 2, -1, 1);
      if (this.enabled && this.mouseDrag && e.buttons & 1) {
        this.pulse = true;
        this.orbitYaw -= e.movementX * 0.006;
        this.orbitPitch = clamp(this.orbitPitch + e.movementY * 0.005, -1.2, 1.2);
      }
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t || !this.enabled) return;
    t.x = e.clientX;
    t.y = e.clientY;
    if (!t.moved && Math.hypot(t.x - t.sx, t.y - t.sy) > SLOP_PX) t.moved = true;
    if (this.touches.size === 2) {
      const d = this.touchDistance();
      if (this.pinchDist > 0) this.pinch += (d - this.pinchDist) / this.pinchDist;
      this.pinchDist = d;
      return;
    }
    if (t.passive) return;
    const now = performance.now();
    const p = this.ndc(e);
    const dt = Math.max(0.004, (now - this.stirLast) / 1000);
    const k = Math.min(1, dt / 0.06);
    this.stirV[0] += ((p[0] - this.stirPos[0]) / dt - this.stirV[0]) * k;
    this.stirV[1] += ((p[1] - this.stirPos[1]) / dt - this.stirV[1]) * k;
    this.stirPos = p;
    this.stirLast = now;
  };

  private up = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    this.mouseDrag = false;
    this.pinchDist = this.touches.size === 2 ? this.touchDistance() : 0;
  };

  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.enabled) return;
    this.pulse = true;
    if (e.ctrlKey)
      this.pinch += -e.deltaY * 0.01; // trackpad pinch
    else if (!this.suspended && !overMap(e.target))
      this.dive = clamp(this.dive + e.deltaY * -0.0012, 0, 1);
  };

  private keyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code in KEY_TILT) {
      this.keys.add(e.code);
      e.preventDefault();
    } else if (e.code === 'KeyM') {
      if (!e.repeat) this.mapKey = true;
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) {
        this.pulse = true;
        this.onShake?.();
      }
    }
  };

  private keyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private touchDistance(): number {
    const [a, b] = [...this.touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
