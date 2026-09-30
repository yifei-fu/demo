/** The lens's DOM: the disk box and its open / close motion, the bead, legend and picking. */
import './map.css';

const OPEN_MS = 600;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const BEAD_CLOSED = 4;
const BEAD_OPEN = 10;
const TAP_SLOP = 12;
const TAP_MS = 500;
const MAX_BACKING = 2048;
/** Legend swatches: the palette's own colours at D = 0, 1, 2, 3. */
const LEGEND: readonly (readonly [string, string])[] = [
  ['0', '#5b6a95'],
  ['1', '#4f83ff'],
  ['2', '#ffb347'],
  ['3', '#ffffff'],
];

export interface ViewEvents {
  /** Dragging on the open map: u right, v up, inside the unit disk. */
  pick(u: number, v: number): void;
  /** The user opened or closed the map (tap, key, backdrop or close button). */
  toggle(open: boolean): void;
  /** The canvas was resized or the look changed: draw it again now. */
  redraw(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export class MapView {
  readonly canvas = el('canvas', 'axm-canvas');
  isOpen = false;

  private readonly root = el('div', 'axm-map');
  private readonly disk = el('div', 'axm-disk');
  private readonly bead = el('div', 'axm-bead');
  private readonly resizer: ResizeObserver;
  private readonly abort = new AbortController();
  private anims: Animation[] = [];
  private animating = false;
  private dragging = false;
  private size = 0;
  private bu = 0;
  private bv = 0;

  constructor(
    host: HTMLElement,
    accent: string,
    private readonly events: ViewEvents,
  ) {
    const { root, disk } = this;
    root.style.setProperty('--axm-accent', accent);
    disk.tabIndex = 0;
    disk.setAttribute('role', 'button');
    disk.setAttribute('aria-label', 'Parameter map');
    disk.setAttribute('aria-expanded', 'false');
    disk.append(this.canvas, this.bead);

    const scrim = el('div', 'axm-scrim');
    const legend = el('div', 'axm-legend');
    legend.append('D');
    LEGEND.forEach(([label, colour], i) => {
      if (i > 0) legend.append(Object.assign(el('span', 'sep'), { textContent: '·' }));
      const s = el('i', '');
      s.style.setProperty('--c', colour);
      s.textContent = label;
      legend.append(s);
    });
    const close = el('button', 'axm-close');
    close.type = 'button';
    close.ariaLabel = 'Close map';
    close.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    root.append(scrim, disk, legend, close);
    host.append(root);

    this.listen(scrim, close);
    this.fit();
    this.resizer = new ResizeObserver(() => {
      this.size = this.disk.clientWidth;
      if (!this.animating && this.fit()) this.events.redraw();
      this.placeBead(this.bu, this.bv, true);
    });
    this.resizer.observe(disk);
  }

  /** Match the canvas backing store to the box's layout size; true if it changed. */
  fit(): boolean {
    this.size = this.disk.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.min(MAX_BACKING, Math.max(32, Math.round(this.size * dpr)));
    if (this.canvas.width === px) return false;
    this.canvas.width = this.canvas.height = px;
    return true;
  }

  placeBead(u: number, v: number, force = false): void {
    if (!force && u === this.bu && v === this.bv) return;
    this.bu = u;
    this.bv = v;
    const s = this.size;
    this.bead.style.transform = `translate(${((u + 1) * s) / 2}px, ${((1 - v) * s) / 2}px)`;
  }

  /** Animate between the lens and the full-screen map. Safe to call mid-flight. */
  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    const from = this.disk.getBoundingClientRect();
    for (const a of this.anims) a.cancel();
    this.anims.length = 0;
    this.root.classList.toggle('is-open', open);
    this.disk.setAttribute('aria-expanded', String(open));
    // Opening draws at the final size at once (a big canvas shrunk stays crisp); closing keeps
    // the big canvas until it has arrived.
    if (open) this.fit();
    else this.size = this.disk.clientWidth;
    this.events.redraw();
    this.placeBead(this.bu, this.bv, true);

    const to = this.disk.getBoundingClientRect();
    const scale = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timing = { duration: still ? 1 : OPEN_MS, easing: EASE };
    // the bead keeps a steady apparent size through the change of scale
    const now = open ? BEAD_OPEN : BEAD_CLOSED;
    const then = open ? BEAD_CLOSED : BEAD_OPEN;
    const move = this.disk.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }],
      timing,
    );
    this.anims.push(move, this.bead.animate([{ scale: then / (now * scale) }, { scale: 1 }], timing));
    this.animating = true;
    move.onfinish = () => {
      this.animating = false;
      if (this.fit()) this.events.redraw();
    };
  }

  dispose(): void {
    this.abort.abort();
    this.resizer.disconnect();
    for (const a of this.anims) a.cancel();
    this.root.remove();
  }

  private listen(scrim: HTMLElement, close: HTMLElement): void {
    const on = { signal: this.abort.signal };
    const { root, disk } = this;
    const toggle = (open: boolean): void => {
      if (open !== this.isOpen) this.events.toggle(open);
    };
    disk.addEventListener('click', () => toggle(true), on);
    close.addEventListener('click', () => toggle(false), on);
    window.addEventListener('keydown', (e) => e.key === 'Escape' && toggle(false), on);
    disk.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggle(!this.isOpen);
      },
      on,
    );

    // Only a lone finger picks or closes: a pinch (which the engine hears) must neither move the
    // bead nor shut the map at its first touch.
    const down = new Set<number>();
    let tap: { id: number; x: number; y: number; t: number } | null = null;
    const lift = (e: PointerEvent): void => void down.delete(e.pointerId);
    root.addEventListener('pointerdown', (e) => down.add(e.pointerId), { ...on, capture: true });
    root.addEventListener('pointerup', lift, on);
    root.addEventListener('pointercancel', lift, on);

    disk.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.isOpen) return;
        e.preventDefault();
        this.dragging = down.size === 1;
        if (!this.dragging) return;
        disk.setPointerCapture(e.pointerId);
        this.pick(e);
      },
      on,
    );
    disk.addEventListener('pointermove', (e) => this.dragging && down.size === 1 && this.pick(e), on);
    const release = (): void => void (this.dragging = false);
    disk.addEventListener('pointerup', release, on);
    disk.addEventListener('pointercancel', release, on);

    scrim.addEventListener(
      'pointerdown',
      (e) =>
        (tap = down.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null),
      on,
    );
    scrim.addEventListener(
      'pointermove',
      (e) => tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP && (tap = null),
      on,
    );
    scrim.addEventListener(
      'pointerup',
      (e) => {
        const ok = tap && tap.id === e.pointerId && e.timeStamp - tap.t < TAP_MS;
        tap = null;
        if (ok) toggle(false);
      },
      on,
    );
    scrim.addEventListener('pointercancel', () => (tap = null), on);
  }

  private pick(e: PointerEvent): void {
    const r = this.disk.getBoundingClientRect();
    let u = ((e.clientX - r.left) / r.width) * 2 - 1;
    let v = 1 - ((e.clientY - r.top) / r.height) * 2;
    const m = Math.hypot(u, v);
    if (m > 1) {
      u /= m;
      v /= m;
    }
    this.events.pick(u, v);
  }
}
