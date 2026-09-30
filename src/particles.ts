/** The particle cloud: one fused compute pass integrates, respawns and splats every frame. */
import { createShader, createUniform, type Gpu } from './gpu';
import { LAW_LEN } from './law';
import type { CameraState } from './navigator';
import lawWgsl from './shaders/law.wgsl?raw';
import shadeWgsl from './shaders/shade.wgsl?raw';
import particlesWgsl from './shaders/particles.wgsl?raw';

const WORKGROUP = 64;
const MAX_GROUPS_X = 65535;
const FRAME_FLOATS = 44; // 11 vec4
const FLAG_INIT = 1;
const FLAG_SPLAT = 2;
const SHAKE_DECAY = 3.2; // 1/s
const APERTURE = 0.0072; // circle of confusion per unit relative depth, as a fraction of height
const MAX_COC = 0.045; // fraction of height
const NEAR = 0.03;
const TAN_HALF = 0.4;
const STIR_RADIUS = 0.16; // of the half-height of the screen
const PARTICLE_BYTES = 16;

export interface StirParams {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  strength: number;
}

export interface FrameParams {
  cam: CameraState;
  dt: number;
  time: number;
  frame: number;
  width: number;
  height: number;
  stir: StirParams;
  splat: boolean;
}

export class Particles {
  readonly capacity: number;
  private count: number;
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly particles: GPUBuffer;
  private readonly lawBuf: GPUBuffer;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new ArrayBuffer(FRAME_FLOATS * 4);
  private readonly f32 = new Float32Array(this.frameData);
  private readonly u32 = new Uint32Array(this.frameData);
  private bindGroup: GPUBindGroup | null = null;
  private shakeEnergy = 0;
  private shakeId = 0;
  private readonly seed: number;
  private readonly paletteShift: number;

  constructor(gpu: Gpu, count: number, seed: number) {
    this.device = gpu.device;
    this.seed = seed >>> 0;
    // seed -> a small slide along the palette, so every visit has its own cast
    this.paletteShift = ((Math.imul(seed >>> 0, 2654435761) >>> 0) / 2 ** 32) * 0.16 - 0.08;
    this.capacity = count;
    this.count = count;
    const device = gpu.device;
    this.particles = device.createBuffer({
      label: 'particles',
      size: count * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.lawBuf = createUniform(device, LAW_LEN * 4 + 16, 'law');
    this.frameBuf = createUniform(device, FRAME_FLOATS * 4, 'frame');
    const module = createShader(device, lawWgsl + shadeWgsl + particlesWgsl, 'particles');
    this.pipeline = device.createComputePipeline({
      label: 'particles',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  /** Point the splat at a (re)allocated accumulation buffer. */
  setTarget(accum: GPUBuffer): void {
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.lawBuf, size: LAW_LEN * 4 } },
        { binding: 1, resource: { buffer: this.frameBuf } },
        { binding: 2, resource: { buffer: this.particles } },
        { binding: 3, resource: { buffer: accum } },
      ],
    });
  }

  get active(): number {
    return this.count;
  }
  setCount(n: number): void {
    this.count = Math.max(WORKGROUP, Math.min(this.capacity, Math.floor(n)));
  }

  setLaw(params: Float32Array): void {
    this.device.queue.writeBuffer(this.lawBuf, 0, params.buffer, params.byteOffset, LAW_LEN * 4);
  }

  /** Scatter every particle; the attractor pulls them back. */
  shake(): void {
    this.shakeEnergy = 1;
    this.shakeId++;
  }

  /** Fill the cloud (uniformly in the spawn ball) without drawing. Call once after setTarget. */
  initialise(width: number, height: number, cam: CameraState): void {
    const enc = this.device.createCommandEncoder({ label: 'init particles' });
    const stir = { active: false, x: 0, y: 0, vx: 0, vy: 0, strength: 0 };
    const frame = { cam, dt: 0, time: 0, frame: 0, width, height, stir, splat: false };
    this.encode(enc, frame, FLAG_INIT);
    this.device.queue.submit([enc.finish()]);
  }

  encode(encoder: GPUCommandEncoder, p: FrameParams, extraFlags = 0): void {
    if (!this.bindGroup) return;
    const { cam, width, height } = p;
    // The short side of the screen spans TAN_HALF at unit depth, so at the default distance the
    // whole unit ball fits the width of a portrait phone.
    const focalPx = (0.5 * Math.min(width, height)) / TAN_HALF;
    const fx = focalPx / (width * 0.5);
    const fy = focalPx / (height * 0.5);
    const f = this.f32;
    f.set([...cam.right, fx], 0);
    f.set([...cam.up, fy], 4);
    f.set([...cam.fwd, 0], 8);
    f.set([...cam.eye, 0], 12);

    // stir ray through the touch point
    const s = p.stir;
    const rx = s.x / fx;
    const ry = s.y / fy;
    const dir = [
      cam.fwd[0] + cam.right[0] * rx + cam.up[0] * ry,
      cam.fwd[1] + cam.right[1] * rx + cam.up[1] * ry,
      cam.fwd[2] + cam.right[2] * rx + cam.up[2] * ry,
    ];
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    f.set([dir[0] / dl, dir[1] / dl, dir[2] / dl, STIR_RADIUS / fy], 16);

    this.shakeEnergy *= Math.exp(-SHAKE_DECAY * p.dt);
    if (this.shakeEnergy < 0.004) this.shakeEnergy = 0;

    f.set([width, height, p.dt, p.time], 20);
    f.set([cam.focus, APERTURE * height, NEAR, MAX_COC * height], 24);
    f.set([s.x, s.y, s.active ? s.strength : 0, 0], 28);
    f.set([s.vx, s.vy, this.shakeEnergy, this.shakeId], 32);
    f.set([this.paletteShift, 0, 0, 0], 36);
    this.u32.set(
      [p.frame >>> 0, this.count, this.seed, extraFlags | (p.splat ? FLAG_SPLAT : 0)],
      40,
    );
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);

    const groups = Math.ceil(this.count / WORKGROUP);
    const pass = encoder.beginComputePass({ label: 'particles' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.min(groups, MAX_GROUPS_X), Math.ceil(groups / MAX_GROUPS_X));
    pass.end();
  }
}
