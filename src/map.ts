/** The lens: a Lyapunov / Kaplan-Yorke map of the parameter disk, and the full-screen navigator. */
import './map.css';
import { createShader, createUniform, type Gpu } from './gpu';
import { LAW_LEN } from './law';
import { isPhone } from './platform';
import lawWgsl from './shaders/law.wgsl?raw';
import mapWgsl from './shaders/map.wgsl?raw';
import type { Core } from './wasm';

export interface ParamMap {
  frame(encoder: GPUCommandEncoder, bead: [number, number], time: number): void;
  setOpen(open: boolean): void;
  readonly open: boolean;
  onPick: ((u: number, v: number) => void) | null;
  onToggle: ((open: boolean) => void) | null;
  dispose(): void;
}

const GRID_PHONE = 128;
const GRID_DESKTOP = 192;
/** Cells computed beyond the unit circle, so the bilinear rim is the true rim. */
const RIM_CELLS = 2.5;
/** World time per RK4 step, the finite-difference step of the Jacobian products, and the horizon. */
const DT = 0.05;
const FD_STEP = 0.01;
const T_TRANSIENT = 24;
const T_TOTAL = 120;
/** GPU time the progressive compute may take per frame. */
const BUDGET_MS = 2;
const MAX_STEPS = 64;
const OPEN_MS = 600;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const TAP_SLOP = 12;
const TAP_MS = 500;
const BEAD_CLOSED = 4;
const BEAD_OPEN = 10;
const MAX_BACKING = 2048;
const PARAM_BYTES = 48;
const LENS_BYTES = 32;

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Any CSS colour to sRGB 0..1, by letting a 2D canvas parse it. */
function cssRgb(css: string): [number, number, number] {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return [0.62, 0.72, 1];
  ctx.fillStyle = '#9db8ff';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const p = ctx.getImageData(0, 0, 1, 1).data;
  return [p[0] / 255, p[1] / 255, p[2] / 255];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** Rust's law block for every cell of the grid (and a rim of cells beyond the circle). */
function lawGrid(core: Core, seed: number, n: number, rim: number): Float32Array {
  const laws = new Float32Array(n * n * LAW_LEN);
  const lim = (1 + rim) * (1 + rim);
  for (let j = 0; j < n; j++) {
    const v = 1 - ((j + 0.5) / n) * 2;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * 2 - 1;
      if (u * u + v * v > lim) continue;
      const o = (j * n + i) * LAW_LEN;
      core.lawParams(u, v, seed, laws.subarray(o, o + LAW_LEN));
    }
  }
  return laws;
}

class Lens implements ParamMap {
  onPick: ((u: number, v: number) => void) | null = null;
  onToggle: ((open: boolean) => void) | null = null;

  private isOpen = false;
  private disposed = false;
  private animating = false;
  private dragging = false;
  private anims: Animation[] = [];
  private bu = 0;
  private bv = 0;
  private placedSize = 0;

  private readonly n: number;
  private readonly rim: number;
  private readonly groups: number;
  private readonly params = new ArrayBuffer(PARAM_BYTES);
  private readonly paramsU32 = new Uint32Array(this.params);
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly lensData = new Float32Array(LENS_BYTES / 4);
  private readonly totalSteps = even(T_TOTAL / DT);
  private remaining = this.totalSteps;
  private stepsPerFrame = 0;
  private fresh = true;
  private dirty = true;
  private lastNow = 0;
  private slow = 0;
  /** `?mapsteps=` pins the rate (tests on software GPUs); otherwise it is measured and guarded. */
  private readonly pinned: boolean;

  private readonly device: GPUDevice;
  private readonly paramBuf: GPUBuffer;
  private readonly lawBuf: GPUBuffer;
  private readonly cellBuf: GPUBuffer;
  private readonly lensBuf: GPUBuffer;
  private readonly field: GPUTexture;
  private readonly lyap: GPUComputePipeline;
  private readonly lensPipe: GPURenderPipeline;
  private readonly computeBG: GPUBindGroup;
  private readonly lensBG: GPUBindGroup;
  private readonly ctx: GPUCanvasContext;
  private readonly pass: GPURenderPassDescriptor;

  private readonly root = el('div', 'axm-map');
  private readonly disk = el('div', 'axm-disk');
  private readonly canvas = el('canvas', 'axm-canvas');
  private readonly beadEl = el('div', 'axm-bead');
  private readonly resizer: ResizeObserver;
  private readonly abort = new AbortController();

  constructor(
    gpu: Gpu,
    core: Core,
    private readonly seed: number,
    private readonly host: HTMLElement,
    accent: string,
  ) {
    const device = (this.device = gpu.device);
    const q = new URLSearchParams(location.search);
    const gridFlag = Number(q.get('mapn'));
    this.n =
      gridFlag >= 16 ? Math.min(256, Math.floor(gridFlag)) : isPhone() ? GRID_PHONE : GRID_DESKTOP;
    this.rim = (RIM_CELLS * 2) / this.n;
    this.groups = Math.ceil(this.n / 8);
    const stepsFlag = Number(q.get('mapsteps'));
    this.pinned = stepsFlag >= 2;
    if (this.pinned) this.stepsPerFrame = even(stepsFlag);

    const cells = this.n * this.n;
    const laws = lawGrid(core, seed, this.n, this.rim);
    this.lawBuf = device.createBuffer({
      label: 'axiom map laws',
      size: laws.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.lawBuf, 0, laws);
    this.cellBuf = device.createBuffer({
      label: 'axiom map cells',
      size: cells * 96,
      usage: GPUBufferUsage.STORAGE,
    });
    this.paramBuf = createUniform(device, PARAM_BYTES, 'axiom map params');
    this.lensBuf = createUniform(device, LENS_BYTES, 'axiom map lens');
    this.field = device.createTexture({
      label: 'axiom map field',
      size: [this.n, this.n],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    const module = createShader(device, `${lawWgsl}\n${mapWgsl}`, 'axiom map');
    this.lyap = device.createComputePipeline({
      label: 'axiom map lyap',
      layout: 'auto',
      compute: { module, entryPoint: 'lyap' },
    });
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.lensPipe = device.createRenderPipeline({
      label: 'axiom map lens',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
    this.computeBG = device.createBindGroup({
      layout: this.lyap.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramBuf } },
        { binding: 1, resource: { buffer: this.lawBuf } },
        { binding: 2, resource: { buffer: this.cellBuf } },
        { binding: 3, resource: this.field.createView() },
      ],
    });
    this.lensBG = device.createBindGroup({
      layout: this.lensPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.lensBuf } },
        { binding: 1, resource: this.field.createView() },
        {
          binding: 2,
          resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        },
      ],
    });

    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error('the lens could not get a WebGPU context');
    this.ctx = ctx;
    ctx.configure({ device, format, alphaMode: 'premultiplied' });
    this.pass = {
      colorAttachments: [
        {
          view: undefined as unknown as GPUTextureView,
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const [r, g, b] = cssRgb(accent);
    this.lensData.set([r, g, b, 0, this.n]);
    this.buildDom(accent);
    this.fit();
    this.resizer = new ResizeObserver(() => {
      if (!this.animating && this.fit()) this.redraw();
    });
    this.resizer.observe(this.disk);
    if (this.stepsPerFrame === 0) void this.calibrate();
  }

  get open(): boolean {
    return this.isOpen;
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen || this.disposed) return;
    this.isOpen = open;
    this.transition(open);
  }

  frame(encoder: GPUCommandEncoder, bead: [number, number], _time: number): void {
    if (this.disposed) return;
    this.placeBead(bead[0], bead[1]);
    if (this.remaining > 0 && this.stepsPerFrame > 0) {
      const steps = Math.min(this.stepsPerFrame, this.remaining);
      this.encodeCompute(encoder, steps);
      this.dirty = true;
      this.guardFrameTime();
    }
    if (this.dirty) this.draw(encoder);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resizer.disconnect();
    for (const a of this.anims) a.cancel();
    this.root.remove();
    this.ctx.unconfigure();
    for (const b of [this.paramBuf, this.lawBuf, this.cellBuf, this.lensBuf]) b.destroy();
    this.field.destroy();
  }

  // ------------------------------------------------------------------------ compute

  private encodeCompute(enc: GPUCommandEncoder, steps: number): void {
    const u = this.paramsU32;
    const f = this.paramsF32;
    u[0] = this.n;
    u[1] = steps;
    u[2] = this.fresh ? 1 : 0;
    u[3] = this.seed;
    f[4] = DT;
    f[5] = FD_STEP;
    f[6] = T_TRANSIENT;
    f[7] = T_TOTAL;
    f[8] = this.rim;
    this.device.queue.writeBuffer(this.paramBuf, 0, this.params);
    this.fresh = false;
    const pass = enc.beginComputePass({ label: 'axiom map lyap' });
    pass.setPipeline(this.lyap);
    pass.setBindGroup(0, this.computeBG);
    pass.dispatchWorkgroups(this.groups, this.groups);
    pass.end();
    this.remaining -= steps;
  }

  /**
   * Time real dispatches against the queue to choose steps per frame for the GPU-time budget.
   * The queue latency is a constant offset, so it drops out of the difference of two runs.
   */
  private async calibrate(): Promise<void> {
    const run = async (steps: number): Promise<number> => {
      const enc = this.device.createCommandEncoder();
      this.encodeCompute(enc, steps);
      this.device.queue.submit([enc.finish()]);
      const t0 = performance.now();
      await this.device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    await run(0); // warm the pipeline (this also initialises the cells)
    let fewer = 2;
    let tFewer = await run(fewer);
    let perStep = tFewer / fewer;
    // a fast GPU hides in the queue latency: lengthen the second run until the difference shows
    for (let more = 8; tFewer < 40 && more <= 4 * MAX_STEPS; more *= 4) {
      const tMore = await run(more);
      perStep = tMore > tFewer + 2 ? (tMore - tFewer) / (more - fewer) : tMore / more;
      if (tMore > tFewer + 2) break;
      [fewer, tFewer] = [more, tMore];
    }
    if (this.disposed) return;
    this.stepsPerFrame = Math.min(MAX_STEPS, even(BUDGET_MS / Math.max(perStep, 1e-3)));
    this.dirty = true;
  }

  /** If frames turn slow while the map is still computing, ease off whatever the cause. */
  private guardFrameTime(): void {
    if (this.pinned) return;
    const now = performance.now();
    const ms = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    this.slow = ms > 42 ? this.slow + 1 : Math.max(0, this.slow - 1);
    if (this.slow > 6 && this.stepsPerFrame > 2) {
      this.stepsPerFrame = even(this.stepsPerFrame / 2);
      this.slow = 0;
    }
  }

  // ------------------------------------------------------------------------ drawing

  private draw(enc: GPUCommandEncoder): void {
    this.dirty = false;
    this.lensData[3] = this.isOpen ? 1 : 0;
    this.lensData[5] = this.canvas.width;
    this.lensData[6] = Math.min(window.devicePixelRatio || 1, 3);
    this.device.queue.writeBuffer(this.lensBuf, 0, this.lensData);
    const att = (this.pass.colorAttachments as GPURenderPassColorAttachment[])[0];
    att.view = this.ctx.getCurrentTexture().createView();
    const pass = enc.beginRenderPass(this.pass);
    pass.setPipeline(this.lensPipe);
    pass.setBindGroup(0, this.lensBG);
    pass.draw(3);
    pass.end();
  }

  private redraw(): void {
    const enc = this.device.createCommandEncoder();
    this.draw(enc);
    this.device.queue.submit([enc.finish()]);
  }

  /** Match the backing store to the box's layout size. Returns true if it changed. */
  private fit(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = Math.min(MAX_BACKING, Math.max(32, Math.round(this.disk.clientWidth * dpr)));
    if (this.canvas.width === px) return false;
    this.canvas.width = this.canvas.height = px;
    return true;
  }

  private placeBead(u: number, v: number): void {
    const s = this.disk.clientWidth;
    if (u === this.bu && v === this.bv && s === this.placedSize) return;
    this.bu = u;
    this.bv = v;
    this.placedSize = s;
    this.beadEl.style.transform = `translate(${((u + 1) * s) / 2}px, ${((1 - v) * s) / 2}px)`;
  }

  // ------------------------------------------------------------------------ open / close

  private transition(opening: boolean): void {
    const from = this.disk.getBoundingClientRect();
    for (const a of this.anims) a.cancel();
    this.anims.length = 0;
    this.root.classList.toggle('is-open', opening);
    this.disk.setAttribute('aria-expanded', String(opening));
    // opening draws at the final size at once (a big canvas shrunk is crisp); closing keeps the
    // big canvas until it has arrived
    if (opening) this.fit();
    this.redraw();
    this.placeBead(this.bu, this.bv);
    const to = this.disk.getBoundingClientRect();
    const scale = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const beadNow = opening ? BEAD_OPEN : BEAD_CLOSED;
    const beadThen = opening ? BEAD_CLOSED : BEAD_OPEN;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timing = { duration: still ? 1 : OPEN_MS, easing: EASE };
    const move = this.disk.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }],
      timing,
    );
    this.anims.push(
      move,
      this.beadEl.animate([{ scale: beadThen / (beadNow * scale) }, { scale: 1 }], timing),
    );
    this.animating = true;
    move.onfinish = () => {
      this.animating = false;
      if (this.disposed) return;
      if (this.fit()) this.redraw();
    };
  }

  private userToggle(open: boolean): void {
    if (open === this.isOpen) return;
    this.setOpen(open);
    this.onToggle?.(open);
  }

  // ------------------------------------------------------------------------ DOM

  private buildDom(accent: string): void {
    const { root, disk, canvas, beadEl } = this;
    const on = { signal: this.abort.signal };
    root.style.setProperty('--axm-accent', accent);

    disk.tabIndex = 0;
    disk.setAttribute('role', 'button');
    disk.setAttribute('aria-label', 'Parameter map');
    disk.setAttribute('aria-expanded', 'false');
    disk.append(canvas, beadEl);

    const scrim = el('div', 'axm-scrim');
    const legend = el('div', 'axm-legend');
    const swatches: [string, string][] = [
      ['0', '#5b6a95'],
      ['1', '#4f83ff'],
      ['2', '#ffb347'],
      ['3', '#ffffff'],
    ];
    legend.append('D');
    swatches.forEach(([label, colour], i) => {
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
    this.host.append(root);

    disk.addEventListener('click', () => !this.isOpen && this.userToggle(true), on);
    disk.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this.userToggle(!this.isOpen);
      },
      on,
    );
    // Only a lone finger picks or closes: a pinch (which the engine hears) must not move the bead
    // or shut the map at its first touch.
    const down = new Set<number>();
    let tap: { id: number; x: number; y: number; t: number } | null = null;
    root.addEventListener('pointerdown', (e) => down.add(e.pointerId), { ...on, capture: true });
    const lift = (e: PointerEvent): void => void down.delete(e.pointerId);
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
    disk.addEventListener(
      'pointermove',
      (e) => this.dragging && down.size === 1 && this.pick(e),
      on,
    );
    const release = (): void => void (this.dragging = false);
    disk.addEventListener('pointerup', release, on);
    disk.addEventListener('pointercancel', release, on);
    scrim.addEventListener(
      'pointerdown',
      (e) =>
        (tap =
          down.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null),
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
        if (ok) this.userToggle(false);
      },
      on,
    );
    scrim.addEventListener('pointercancel', () => (tap = null), on);
    close.addEventListener('click', () => this.userToggle(false), on);
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.userToggle(false), on);
  }

  /** Pointer to disk coordinates: u right, v up, clamped to the unit disk. */
  private pick(e: PointerEvent): void {
    const r = this.disk.getBoundingClientRect();
    let u = ((e.clientX - r.left) / r.width) * 2 - 1;
    let v = 1 - ((e.clientY - r.top) / r.height) * 2;
    const m = Math.hypot(u, v);
    if (m > 1) {
      u /= m;
      v /= m;
    }
    this.onPick?.(u, v);
  }
}

export function createParamMap(
  gpu: Gpu,
  core: Core,
  seed: number,
  host: HTMLElement,
  accent: string,
): ParamMap {
  return new Lens(gpu, core, seed >>> 0, host, accent);
}
