/** Owns the simulation-and-render pipeline; `advance` is one frame, whether from rAF or a test. */
import { backingSize, type Gpu } from './gpu';
import type { ParamMap } from './map';
import { Bead, CameraRig } from './navigator';
import { Particles, type StirParams } from './particles';
import { Post, settingsFor, type PostSettings } from './post';
import { Sensors } from './sensors';
import type { Variant } from './variants/types';
import { LAW_LEN } from './law';
import type { Core, SpectrumReading } from './wasm';

const STIR_STRENGTH = 1;
/** World-time units the spectrum probe advances per frame (about 24x real time, so it converges). */
const SPECTRUM_STEP = 0.4;
/** Pinch travel (sum of relative finger-distance changes, decaying) that opens / closes the map. */
const PINCH_OPEN = 0.3;
const PINCH_CLOSE = -0.25;
/** The 3D view yields to the open map: dimmer and a little further away. */
const MAP_DIM = 0.78;
const MAP_RECEDE = 0.12;

export class Engine {
  readonly sensors: Sensors;
  readonly bead = new Bead();
  readonly rig = new CameraRig();
  readonly particles: Particles;
  readonly post: Post;
  readonly law = new Float32Array(LAW_LEN);
  readonly settings: PostSettings;
  spectrum: SpectrumReading;
  /** 0..1 touch-drag energy, for the sound of stirring. */
  stirLevel = 0;

  scale = 1;
  time = 0;
  frame = 0;
  width = 0;
  height = 0;
  /** After Begin: the autopilot may start and the opening breath calms down. */
  begun = false;

  private map: ParamMap | null = null;
  private mapAmount = 0;
  private pinchAcc = 0;
  private stirGain = 0;
  private hookStir: { x: number; y: number; strength: number; left: number } | null = null;
  private sinceReset = 0;

  constructor(
    readonly gpu: Gpu,
    readonly core: Core,
    readonly variant: Variant,
    readonly seed: number,
    particleCount: number,
  ) {
    this.sensors = new Sensors(gpu.canvas);
    this.particles = new Particles(gpu, particleCount, seed, variant);
    this.post = new Post(gpu, variant);
    this.settings = settingsFor(variant);
    this.sensors.onShake = () => this.particles.shake();
    this.updateLaw();
    this.spectrum = core.spectrumRead();
    this.resize(true);
  }

  /** The map is optional; once attached the engine drives it and yields to it. */
  attachMap(map: ParamMap): void {
    this.map = map;
    map.onPick = (u, v) => this.setBead(u, v);
    map.onToggle = () => this.syncMap();
  }

  /** Re-fit the backing store to the CSS size and adaptive scale. */
  resize(force = false): void {
    const { canvas } = this.gpu;
    const { width, height } = backingSize(
      this.gpu,
      canvas.clientWidth || 1,
      canvas.clientHeight || 1,
      this.scale,
    );
    if (!force && width === this.width && height === this.height) return;
    this.width = canvas.width = width;
    this.height = canvas.height = height;
    this.post.resize(width, height);
    this.particles.setTarget(this.post.accum);
    if (this.frame === 0) this.particles.initialise(width, height, this.rig.state);
    this.sinceReset = 0;
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.resize();
  }

  setBead(u: number, v: number): void {
    this.bead.set(u, v);
    this.updateLaw();
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
    this.driveMap(input.pinch, input.map, dt);
    this.bead.update(input, dt, this.begun);
    this.updateLaw();
    this.core.spectrumStep(this.law, SPECTRUM_STEP);
    this.spectrum = this.core.spectrumRead();
    this.particles.setLaw(this.law);
    const cam = this.rig.update(input, dt, this.mapAmount * MAP_RECEDE);

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
      const breath = 1 + breathAmp * Math.sin((this.time * Math.PI * 2) / 6.5);
      this.post.encode(
        enc,
        this.gpu.context.getCurrentTexture().createView(),
        {
          ...s,
          trail: Math.min(s.trail * still, n / (n + 1)),
          breath: breath * (1 - MAP_DIM * this.mapAmount),
        },
        this.particles.active,
        this.time,
      );
      this.map?.frame(enc, [this.bead.u, this.bead.v], this.time);
    } else {
      this.sinceReset = 0;
    }
    this.gpu.device.queue.submit([enc.finish()]);
  }

  settled(): Promise<void> {
    return this.gpu.device.queue.onSubmittedWorkDone();
  }

  private updateLaw(): void {
    this.core.lawParams(this.bead.u, this.bead.v, this.seed, this.law);
  }

  /** Pinch-out / pinch-in / M open and close the map; the 3D view eases away while it is open. */
  private driveMap(pinch: number, keyPressed: boolean, dt: number): void {
    const map = this.map;
    if (!map) return;
    this.pinchAcc = this.pinchAcc * Math.exp(-dt / 0.5) + pinch;
    const open = map.open;
    if (keyPressed) map.setOpen(!open);
    else if (!open && this.pinchAcc > PINCH_OPEN) map.setOpen(true);
    else if (open && this.pinchAcc < PINCH_CLOSE) map.setOpen(false);
    if (map.open !== open) this.pinchAcc = 0;
    this.syncMap();
    this.mapAmount += ((map.open ? 1 : 0) - this.mapAmount) * (1 - Math.exp(-dt / 0.35));
  }

  private syncMap(): void {
    this.sensors.setMapOpen(this.map?.open ?? false);
  }

  private stirParams(
    s: { active: boolean; x: number; y: number; vx: number; vy: number },
    dt: number,
  ): StirParams {
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
    this.stirLevel = Math.min(1, this.stirGain * strength * (0.45 + 0.35 * Math.hypot(vx, vy)));
    return { active: this.stirGain > 0, x, y, vx, vy, strength: strength * this.stirGain };
  }
}
