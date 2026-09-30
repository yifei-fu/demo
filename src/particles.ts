/** The particle cloud: one fused compute pass integrates, respawns and splats every frame. */
import { createShader, createUniform, type Gpu } from './gpu';
import { ExtentProbe } from './extent';
import { LAW_LEN } from './law';
import type { CameraState } from './navigator';
import lawWgsl from './shaders/law.wgsl?raw';
import particlesWgsl from './shaders/particles.wgsl?raw';
import type { Variant } from './variants/types';

const WORKGROUP = 64;
const MAX_GROUPS_X = 65535;
const FRAME_FLOATS = 52; // 13 vec4
const FLAG_INIT = 1;
const FLAG_SPLAT = 2;
const SHAKE_DECAY = 3.2; // 1/s
const APERTURE = 0.0072; // circle of confusion per unit relative depth, as a fraction of height
const MAX_COC = 0.045; // fraction of height
const NEAR = 0.03;
const MAX_SUBSTEP_DT = 0.03; // world time; keeps RK2 accurate on a fast law at low fps
const MAX_SUBSTEPS = 4;
/** About this many particles feed the extent measurement each frame. */
const EXTENT_SAMPLES = 2048;
/** The least a slow particle may weigh next to a typical one (dwell equalisation). */
const DWELL_FLOOR = 0.15;
const TAN_HALF = 0.31;
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

const vec4 = (f: Float32Array, o: number, x: number, y: number, z: number, w: number): void => {
  f[o] = x;
  f[o + 1] = y;
  f[o + 2] = z;
  f[o + 3] = w;
};

export class Particles {
  readonly capacity: number;
  readonly extent: ExtentProbe;
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
  /** Set once by the engine when GPU timing is on (?perf). */
  timestamps: GPUComputePassTimestampWrites | undefined;
  /** Set each frame by the engine from the framing measurement. */
  refSpeed = 0.3;
  equalise = 0;
  radius = 0.8;
  depthCue = 0;
  private shakeEnergy = 0;
  private shakeId = 0;
  private readonly seed: number;
  private readonly seedFraction: number;
  private readonly aperture: number;

  constructor(gpu: Gpu, count: number, seed: number, variant: Variant) {
    this.device = gpu.device;
    this.seed = seed >>> 0;
    this.seedFraction = (Math.imul(seed >>> 0, 2654435761) >>> 0) / 2 ** 32;
    this.aperture = APERTURE * variant.render.dof;
    this.capacity = count;
    this.count = count;
    const device = gpu.device;
    this.particles = device.createBuffer({
      label: 'particles',
      size: count * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.extent = new ExtentProbe(device);
    this.lawBuf = createUniform(device, LAW_LEN * 4 + 16, 'law');
    this.frameBuf = createUniform(device, FRAME_FLOATS * 4, 'frame');
    const module = createShader(
      device,
      lawWgsl + variant.shadeWgsl + particlesWgsl,
      `particles/${variant.id}`,
    );
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
        { binding: 4, resource: { buffer: this.extent.buffer } },
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
    // (no temporary arrays: this runs every frame and the GC pauses show on phones)
    vec4(f, 0, cam.right[0], cam.right[1], cam.right[2], fx);
    vec4(f, 4, cam.up[0], cam.up[1], cam.up[2], fy);
    vec4(f, 8, cam.fwd[0], cam.fwd[1], cam.fwd[2], 0);
    vec4(f, 12, cam.eye[0], cam.eye[1], cam.eye[2], 0);

    // stir ray through the touch point
    const s = p.stir;
    const rx = s.x / fx;
    const ry = s.y / fy;
    const dx = cam.fwd[0] + cam.right[0] * rx + cam.up[0] * ry;
    const dy = cam.fwd[1] + cam.right[1] * rx + cam.up[1] * ry;
    const dz = cam.fwd[2] + cam.right[2] * rx + cam.up[2] * ry;
    const dl = Math.hypot(dx, dy, dz) || 1;
    vec4(f, 16, dx / dl, dy / dl, dz / dl, STIR_RADIUS / fy);

    this.shakeEnergy *= Math.exp(-SHAKE_DECAY * p.dt);
    if (this.shakeEnergy < 0.004) this.shakeEnergy = 0;

    vec4(f, 20, width, height, p.dt, p.time);
    vec4(f, 24, cam.focus, this.aperture * height, NEAR, MAX_COC * height);
    vec4(f, 28, s.x, s.y, s.active ? s.strength : 0, 0);
    vec4(f, 32, s.vx, s.vy, this.shakeEnergy, this.shakeId);
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(2, Math.ceil(p.dt / MAX_SUBSTEP_DT)));
    vec4(
      f,
      36,
      this.seedFraction,
      substeps,
      Math.max(1, Math.floor(this.count / EXTENT_SAMPLES)),
      0,
    );
    const probe = this.extent.probe;
    vec4(f, 40, probe[0], probe[1], probe[2], this.radius);
    vec4(f, 44, this.refSpeed, this.equalise, DWELL_FLOOR, this.depthCue);
    const u = this.u32;
    u[48] = p.frame >>> 0;
    u[49] = this.count;
    u[50] = this.seed;
    u[51] = extraFlags | (p.splat ? FLAG_SPLAT : 0);
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);

    const groups = Math.ceil(this.count / WORKGROUP);
    const pass = encoder.beginComputePass({
      label: 'particles',
      timestampWrites: this.timestamps,
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.min(groups, MAX_GROUPS_X), Math.ceil(groups / MAX_GROUPS_X));
    pass.end();
  }
}
