/** Resolve, trails, dual-Kawase bloom and the final composite. */
import { createShader, createUniform, type Gpu } from './gpu';
import postWgsl from './shaders/post.wgsl?raw';
import type { Variant } from './variants/types';

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_LEVELS = 5;
const UNIFORM_FLOATS = 20;
const VIGNETTE = 0.42;
const ACCUM_BYTES_PER_PIXEL = 16;
export interface PostSettings {
  /** Scene-referred gain ahead of the tonemap. */
  exposure: number;
  /** Trail persistence: weight of the previous frame in the running average. */
  trail: number;
  bloom: number;
  grain: number;
  vignette: number;
  /** Chromatic aberration at the frame corners, as a fraction of the frame. */
  ca: number;
  /** Slow multiplicative pulse on the exposure. */
  breath: number;
}

/** Per-frame finish settings for a variant. The engine adds breath and dimming on top. */
export function settingsFor(v: Variant): PostSettings {
  const r = v.render;
  return {
    exposure: r.exposure,
    trail: r.trail,
    bloom: r.bloom,
    grain: r.grain,
    vignette: VIGNETTE,
    ca: r.aberration,
    breath: 1,
  };
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

interface Level {
  tex: GPUTexture;
  view: GPUTextureView;
}

export class Post {
  private readonly device: GPUDevice;
  private readonly gpu: Gpu;
  private readonly params: GPUBuffer;
  private readonly data = new Float32Array(UNIFORM_FLOATS);
  private readonly sampler: GPUSampler;
  private readonly resolvePipe: GPURenderPipeline;
  private readonly downFirstPipe: GPURenderPipeline;
  private readonly downPipe: GPURenderPipeline;
  private readonly upPipe: GPURenderPipeline;
  private readonly compositePipe: GPURenderPipeline;
  private readonly background: number[];

  private accumBuf: GPUBuffer | null = null;
  private hdr: Level[] = [];
  private bloom: Level[] = [];
  private resolveBG: GPUBindGroup[] = [];
  private downFirstBG: GPUBindGroup[] = [];
  private downBG: GPUBindGroup[] = [];
  private upBG: GPUBindGroup[] = [];
  private compositeBG: GPUBindGroup[] = [];
  private flip = 0;
  private width = 0;
  private height = 0;

  constructor(gpu: Gpu, variant: Variant) {
    this.gpu = gpu;
    this.background = variant.render.background.map(srgbToLinear);
    const device = (this.device = gpu.device);
    this.params = createUniform(device, UNIFORM_FLOATS * 4, 'post params');
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const module = createShader(device, postWgsl + variant.gradeWgsl, `post/${variant.id}`);
    const make = (
      label: string,
      fragment: string,
      format: GPUTextureFormat,
      constants?: Record<string, number>,
      additive = false,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: fragment,
          constants,
          targets: [
            {
              format,
              blend: additive
                ? {
                    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                  }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });
    this.resolvePipe = make('resolve', 'fs_resolve', HDR_FORMAT);
    this.downFirstPipe = make('bloom down first', 'fs_down_first', HDR_FORMAT);
    this.downPipe = make('bloom down', 'fs_down', HDR_FORMAT);
    this.upPipe = make('bloom up', 'fs_up', HDR_FORMAT, undefined, true);
    this.compositePipe = make('composite', 'fs_composite', gpu.format, {
      HDR_OUT: gpu.extended ? 1 : 0,
    });
  }

  get accum(): GPUBuffer {
    if (!this.accumBuf) throw new Error('Post.resize() has not run');
    return this.accumBuf;
  }

  /** (Re)allocate everything that depends on the canvas size. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.destroy();
    const device = this.device;
    this.accumBuf = device.createBuffer({
      label: 'accum',
      size: width * height * ACCUM_BYTES_PER_PIXEL,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.hdr = [this.level(width, height, 'hdr a'), this.level(width, height, 'hdr b')];
    this.bloom = [];
    let w = width;
    let h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.bloom.push(this.level(w, h, `bloom ${i}`));
    }

    const pb = { binding: 0, resource: { buffer: this.params } };
    const view = (l: Level): GPUBindingResource => l.view;
    const smp = this.sampler;
    this.resolveBG = [0, 1].map((i) =>
      device.createBindGroup({
        layout: this.resolvePipe.getBindGroupLayout(0),
        entries: [
          pb,
          { binding: 1, resource: { buffer: this.accum } },
          { binding: 2, resource: view(this.hdr[i ^ 1]) },
        ],
      }),
    );
    this.downFirstBG = [0, 1].map((i) =>
      device.createBindGroup({
        layout: this.downFirstPipe.getBindGroupLayout(0),
        entries: [pb, { binding: 1, resource: view(this.hdr[i]) }, { binding: 2, resource: smp }],
      }),
    );
    this.downBG = [];
    this.upBG = [];
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this.downBG.push(
        device.createBindGroup({
          layout: this.downPipe.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: view(this.bloom[i - 1]) },
            { binding: 2, resource: smp },
          ],
        }),
      );
      this.upBG.push(
        device.createBindGroup({
          layout: this.upPipe.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: view(this.bloom[i]) },
            { binding: 2, resource: smp },
          ],
        }),
      );
    }
    this.compositeBG = [0, 1].map((i) =>
      device.createBindGroup({
        layout: this.compositePipe.getBindGroupLayout(0),
        entries: [
          pb,
          { binding: 1, resource: view(this.hdr[i]) },
          { binding: 2, resource: view(this.bloom[0]) },
          { binding: 3, resource: smp },
        ],
      }),
    );
  }

  /** Clear the splat target; call before the particle pass of a rendered frame. */
  beginFrame(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.accum);
  }

  encode(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    s: PostSettings,
    particleCount: number,
    time: number,
  ): void {
    const d = this.data;
    d.set([this.width, this.height, 1 / this.width, 1 / this.height], 0);
    d.set([s.exposure, s.trail, s.bloom, s.grain], 4);
    d.set([s.vignette, s.ca, this.gpu.hdrHeadroom, time % 1000], 8);
    d.set([(this.width * this.height) / Math.max(1, particleCount), s.breath, 0, 0], 12);
    d.set([...this.background, 0], 16);
    this.device.queue.writeBuffer(this.params, 0, d);

    const cur = this.flip;
    const full = (
      view: GPUTextureView,
      pipe: GPURenderPipeline,
      bg: GPUBindGroup,
      load: GPULoadOp = 'clear',
    ): void => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    };

    full(this.hdr[cur].view, this.resolvePipe, this.resolveBG[cur]);
    full(this.bloom[0].view, this.downFirstPipe, this.downFirstBG[cur]);
    for (let i = 1; i < BLOOM_LEVELS; i++)
      full(this.bloom[i].view, this.downPipe, this.downBG[i - 1]);
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--)
      full(this.bloom[i].view, this.upPipe, this.upBG[i], 'load');
    full(target, this.compositePipe, this.compositeBG[cur]);
    this.flip ^= 1;
  }

  private level(w: number, h: number, label: string): Level {
    const tex = this.device.createTexture({
      label,
      size: { width: w, height: h },
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return { tex, view: tex.createView() };
  }

  private destroy(): void {
    this.accumBuf?.destroy();
    for (const l of [...this.hdr, ...this.bloom]) l.tex.destroy();
  }
}
