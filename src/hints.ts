/**
 * Two quiet, typographic hints, each shown at most once per device:
 *  - a tilt glyph for people whose phone reports motion, until the bead has really moved;
 *  - a line for phones that report none (permission denied, no gyro), pointing at the lens.
 */
import type { Engine } from './engine';

const WAIT_FOR_MOTION_MS = 1500;
const TILT_TIMEOUT_MS = 14_000;
const MOVED_ENOUGH = 0.1;
const NO_MOTION_TEXT = 'motion unavailable · open the lens to navigate';
const KEY_TILT = 'axiom.hint.tilt';
const KEY_NO_MOTION = 'axiom.hint.nomotion';
const PULSE_MS = 2200;

function once(key: string): boolean {
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, '1');
  } catch {
    /* storage blocked: show it anyway, this visit */
  }
  return true;
}

const seen = (key: string): boolean => {
  try {
    return !!localStorage.getItem(key);
  } catch {
    return false;
  }
};

export class Hints {
  private readonly el: HTMLElement;
  private startU = 0;
  private startV = 0;
  private tilting = false;
  private shownAt = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hint';
    this.el.setAttribute('aria-live', 'polite');
    root.append(this.el);
  }

  /** Called right after Begin has armed the sensors. */
  afterBegin(engine: Engine): void {
    const touch = matchMedia('(pointer: coarse)').matches;
    setTimeout(() => {
      if (engine.sensors.hasMotion) {
        if (!seen(KEY_TILT) && once(KEY_TILT)) this.showTilt(engine);
      } else if (touch && once(KEY_NO_MOTION)) {
        this.showText(NO_MOTION_TEXT);
        this.pulseLens();
      }
    }, WAIT_FOR_MOTION_MS);
  }

  /** Per frame, cheap. */
  update(engine: Engine, now: number): void {
    if (!this.tilting) return;
    const moved = Math.hypot(engine.bead.u - this.startU, engine.bead.v - this.startV);
    if (moved > MOVED_ENOUGH || now - this.shownAt > TILT_TIMEOUT_MS) this.hide();
  }

  private showTilt(engine: Engine): void {
    this.startU = engine.bead.u;
    this.startV = engine.bead.v;
    this.tilting = true;
    this.shownAt = performance.now();
    this.el.className = 'hint tilt';
    this.el.innerHTML =
      '<svg viewBox="0 0 24 32" aria-hidden="true"><rect x="5" y="2" width="14" height="28" rx="3"/>' +
      '<path d="M10 26h4"/></svg><span>tilt</span>';
    requestAnimationFrame(() => this.el.classList.add('on'));
  }

  private showText(text: string): void {
    this.el.className = 'hint text';
    this.el.textContent = text;
    requestAnimationFrame(() => this.el.classList.add('on'));
    setTimeout(() => this.hide(), 7000);
  }

  private hide(): void {
    this.tilting = false;
    this.el.classList.remove('on');
  }

  /** One gentle pulse of the closed lens, so the eye finds it. */
  private pulseLens(): void {
    document.body.classList.add('pulse-lens');
    setTimeout(() => document.body.classList.remove('pulse-lens'), PULSE_MS);
  }
}
