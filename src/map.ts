/**
 * The lens: the parameter disk coloured by Kaplan-Yorke dimension, and the navigator it opens
 * into. A compute shader estimates the Lyapunov spectrum of the world field at every grid point
 * (progressively, a few RK4 steps per frame); a fragment shader draws the result. The DOM, the
 * open / close motion and the picking live in map-dom.ts.
 */
import { createShader, createUniform, type Gpu } from './gpu';
import { LAW_LEN } from './law';
import { MapView } from './map-dom';
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
/** Cells computed beyond the unit circle, so the smoothed field is right up to the rim. */
const RIM_CELLS = 2.5;
/** World time per RK4 step (the field's fastest eigenvalues are ~13), the finite-difference step
 *  of the Jacobian-vector products, and the transient and horizon of the estimate. */
const DT = 0.05;
const FD_STEP = 0.01;
const T_TRANSIENT = 24;
const T_TOTAL = 120;
/** GPU time the progressive compute may take per frame, and the most steps it may take. */
const BUDGET_MS = 2;
const MAX_STEPS = 64;
/** Steps per frame in `?capture`, where frames are deterministic. */
const CAPTURE_STEPS = 200;
const CELL_BYTES = 96;
const PARAM_BYTES = 48;
const LENS_BYTES = 32;

const COMPUTE_PASS: GPUComputePassDescriptor = { label: 'axiom map lyap' };

/** Steps come in pairs: the tangent frame is re-orthonormalised every second step. */
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

  private readonly device: GPUDevice;
  private readonly view: MapView;
  private readonly ctx: GPUCanvasContext;
  private readonly n: number;
  private readonly rim: number;
  private readonly groups: number;
  private readonly buffers: GPUBuffer[] = [];
  private readonly field: GPUTexture;
  private readonly lyap: GPUComputePipeline;
  private readonly lensPipe: GPURenderPipeline;
  private readonly computeBG: GPUBindGroup;
  private readonly lensBG: GPUBindGroup;
  private readonly paramBuf: GPUBuffer;
  private readonly lensBuf: GPUBuffer;
  private readonly pass: GPURenderPassDescriptor;
  private readonly params = new ArrayBuffer(PARAM_BYTES);
  private readonly paramsU32 = new Uint32Array(this.params);
  private readonly paramsF32 = new Float32Array(this.params);
  private readonly lensData = new Float32Array(LENS_BYTES / 4);
  /** Fixed steps per frame (tests and `?capture`); otherwise the rate is measured and guarded. */
  private readonly pinned: boolean;

  private remaining = even(T_TOTAL / DT);
  private stepsPerFrame = 0;
  private fresh = true;
  private dirty = true;
  private disposed = false;
  private lastNow = 0;
  private slow = 0;

  constructor(
    gpu: Gpu,
    core: Core,
    private readonly seed: number,
    host: HTMLElement,
    accent: string,
  ) {
    const device = (this.device = gpu.device);
    const q = new URLSearchParams(location.search);
    const gridFlag = Number(q.get('mapn'));
    this.n =
      gridFlag >= 16 ? Math.min(256, Math.floor(gridFlag)) : isPhone() ? GRID_PHONE : GRID_DESKTOP;
    this.rim = (RIM_CELLS * 2) / this.n;
    this.groups = Math.ceil(this.n / 8);
    // ?mapsteps= pins the rate; so does ?capture, whose frames must not depend on the wall clock
    const stepsFlag = Number(q.get('mapsteps'));
    this.pinned = stepsFlag >= 2 || q.has('capture');
    if (this.pinned) this.stepsPerFrame = even(stepsFlag >= 2 ? stepsFlag : CAPTURE_STEPS);

    const laws = lawGrid(core, seed, this.n, this.rim);
    const lawBuf = device.createBuffer({
      label: 'axiom map laws',
      size: laws.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(lawBuf, 0, laws);
    const cellBuf = device.createBuffer({
      label: 'axiom map cells',
      size: this.n * this.n * CELL_BYTES,
      usage: GPUBufferUsage.STORAGE,
    });
    this.paramBuf = createUniform(device, PARAM_BYTES, 'axiom map params');
    this.lensBuf = createUniform(device, LENS_BYTES, 'axiom map lens');
    this.buffers.push(lawBuf, cellBuf, this.paramBuf, this.lensBuf);
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
        { binding: 1, resource: { buffer: lawBuf } },
        { binding: 2, resource: { buffer: cellBuf } },
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

    this.view = new MapView(host, accent, {
      pick: (u, v) => this.onPick?.(u, v),
      toggle: (open) => {
        this.setOpen(open);
        this.onToggle?.(open);
      },
      redraw: () => this.redraw(),
    });
    const ctx = this.view.canvas.getContext('webgpu');
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
    this.lensData.set([...cssRgb(accent), 0, this.n]);
    if (!this.pinned) void this.calibrate();
  }

  get open(): boolean {
    return this.view.isOpen;
  }

  setOpen(open: boolean): void {
    if (!this.disposed) this.view.setOpen(open);
  }

  frame(encoder: GPUCommandEncoder, bead: [number, number], _time: number): void {
    if (this.disposed) return;
    this.view.placeBead(bead[0], bead[1]);
    if (this.remaining > 0 && this.stepsPerFrame > 0) {
      this.encodeCompute(encoder, Math.min(this.stepsPerFrame, this.remaining));
      this.dirty = true;
      this.guardFrameTime();
    }
    if (this.dirty) this.draw(encoder);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view.dispose();
    this.ctx.unconfigure();
    for (const b of this.buffers) b.destroy();
    this.field.destroy();
  }

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
    const pass = enc.beginComputePass(COMPUTE_PASS);
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
      const shows = tMore > tFewer + 2;
      perStep = shows ? (tMore - tFewer) / (more - fewer) : tMore / more;
      if (shows) break;
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

  private draw(enc: GPUCommandEncoder): void {
    this.dirty = false;
    const canvas = this.view.canvas;
    this.lensData[3] = this.view.isOpen ? 1 : 0;
    this.lensData[5] = canvas.width;
    this.lensData[6] = Math.min(window.devicePixelRatio || 1, 3);
    this.device.queue.writeBuffer(this.lensBuf, 0, this.lensData);
    const attachment = (this.pass.colorAttachments as GPURenderPassColorAttachment[])[0];
    attachment.view = this.ctx.getCurrentTexture().createView();
    const pass = enc.beginRenderPass(this.pass);
    pass.setPipeline(this.lensPipe);
    pass.setBindGroup(0, this.lensBG);
    pass.draw(3);
    pass.end();
  }

  /** Draw outside the engine's frame: after a resize, which clears the canvas. */
  private redraw(): void {
    if (this.disposed) return;
    const enc = this.device.createCommandEncoder();
    this.draw(enc);
    this.device.queue.submit([enc.finish()]);
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
