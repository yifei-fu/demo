/** Owns the simulation-and-render pipeline; `advance` is one frame, whether from rAF or a test. */
import { backingSize, type Gpu } from './gpu';
import { lawParams, LAW_LEN } from './law';
import { Bead, CameraRig } from './navigator';
import { Particles, type StirParams } from './particles';
import { DEFAULT_POST, Post, type PostSettings } from './post';
import { Sensors } from './sensors';

const STIR_STRENGTH = 1;

export class Engine {
  readonly sensors: Sensors;
  readonly bead = new Bead();
  readonly rig = new CameraRig();
  readonly particles: Particles;
  readonly post: Post;
  readonly law = new Float32Array(LAW_LEN);
  readonly settings: PostSettings = { ...DEFAULT_POST };

  scale = 1;
  time = 0;
  frame = 0;
  width = 0;
  height = 0;
  /** After Begin: the autopilot may start and the opening breath calms down. */
  begun = false;

  private stirGain = 0;
  private hookStir: { x: number; y: number; strength: number; left: number } | null = null;
  private sinceReset = 0;

  constructor(
    readonly gpu: Gpu,
    readonly seed: number,
    particleCount: number,
  ) {
    this.sensors = new Sensors(gpu.canvas);
    this.particles = new Particles(gpu, particleCount, seed);
    this.post = new Post(gpu);
    this.sensors.onShake = () => this.particles.shake();
    this.resize(true);
  }

  /** Re-fit the backing store to the CSS size and adaptive scale. */
  resize(force = false): void {
    const { canvas } = this.gpu;
    const { width, height } = backingSize(this.gpu, canvas.clientWidth || 1, canvas.clientHeight || 1, this.scale);
    if (!force && width === this.width && height === this.height) return;
    this.width = canvas.width = width;
    this.height = canvas.height = height;
    this.post.resize(width, height);
    this.particles.setTarget(this.post.accum);
    if (this.frame === 0) this.particles.initialise(width, height);
    this.sinceReset = 0;
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.resize();
  }

  setBead(u: number, v: number): void {
    this.bead.set(u, v);
    lawParams(this.bead.u, this.bead.v, this.seed, this.law);
  }

  /** Inject a synthetic stir for a short while (test hook). x, y in NDC. */
  stir(x: number, y: number, strength: number): void {
    this.hookStir = { x, y, strength, left: 0.6 };
  }

  setCamera(c: { yaw?: number; pitch?: number; dive?: number }): void {
    this.sensors.setOrbit(c.yaw, c.pitch);
    if (c.dive !== undefined) {
      this.sensors.setDive(c.dive);
      this.rig.snapDive(c.dive);
    }
  }

  /** One frame: sense, navigate, simulate and (optionally) draw. Submits its own command buffer. */
  advance(dt: number, render = true): void {
    const input = this.sensors.update(dt, performance.now());
    this.bead.update(input, dt, this.begun);
    lawParams(this.bead.u, this.bead.v, this.seed, this.law);
    this.particles.setLaw(this.law);
    const cam = this.rig.update(input, dt);

    const stir = this.stirParams(input.stir, dt);
    this.time += dt;
    this.frame++;

    const enc = this.gpu.device.createCommandEncoder({ label: 'frame' });
    if (render) this.post.beginFrame(enc);
    this.particles.encode(enc, {
      cam,
      dt,
      time: this.time,
      frame: this.frame,
      width: this.width,
      height: this.height,
      stir,
      splat: render,
    });
    if (render) {
      // ramp trail persistence up from zero after any gap so a fresh image is a plain average
      const n = this.sinceReset++;
      const s = this.settings;
      const still = 1 - Math.min(0.7, cam.motion * 0.35);
      const breathAmp = this.begun ? 0.015 : 0.05;
      const trail = Math.min(s.trail * still, n / (n + 1));
      this.post.encode(
        enc,
        this.gpu.context.getCurrentTexture().createView(),
        { ...s, trail, breath: 1 + breathAmp * Math.sin((this.time * Math.PI * 2) / 6.5) },
        this.particles.active,
        this.time,
        this.frame,
      );
    } else {
      this.sinceReset = 0;
    }
    this.gpu.device.queue.submit([enc.finish()]);
  }

  settled(): Promise<void> {
    return this.gpu.device.queue.onSubmittedWorkDone();
  }

  private stirParams(s: { active: boolean; x: number; y: number; vx: number; vy: number }, dt: number): StirParams {
    let active = s.active;
    let { x, y, vx, vy } = s;
    let strength = STIR_STRENGTH;
    const h = this.hookStir;
    if (h && !active) {
      h.left -= dt;
      if (h.left > 0) {
        active = true;
        x = h.x;
        y = h.y;
        vx = vy = 0;
        strength = h.strength * Math.min(1, h.left / 0.25);
      } else this.hookStir = null;
    }
    const target = active ? 1 : 0;
    this.stirGain += (target - this.stirGain) * (1 - Math.exp(-dt / (active ? 0.08 : 0.25)));
    if (this.stirGain < 0.002) this.stirGain = 0;
    return { active: this.stirGain > 0, x, y, vx, vy, strength: strength * this.stirGain };
  }
}
