/** Resolve, trails, dual-Kawase bloom and the final composite. */
import { createShader, createUniform, type Gpu } from './gpu';
import { srgbToLinear, type PostSettings } from './post-settings';
import postWgsl from './shaders/post.wgsl?raw';
import type { Variant } from './variants/types';

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const BLOOM_LEVELS = 5;
const UNIFORM_FLOATS = 28;
/** The unsharp mask's blur: three halvings, about a sixteenth of the screen wide in radius. */
const CLARITY_LEVELS = 3;
const ACCUM_BYTES_PER_PIXEL = 16;
const ADD: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

interface Level {
  tex: GPUTexture;
  view: GPUTextureView;
}

/** One full-screen pass with its descriptor built once (the frame loop must not allocate). */
interface FullPass {
  pipe: GPURenderPipeline;
  bind: GPUBindGroup;
  desc: GPURenderPassDescriptor;
  color: GPURenderPassColorAttachment;
}

/** Everything one frame runs, for one of the two ping-pong history textures. */
interface Chain {
  resolve: FullPass;
  clarity: FullPass[];
  bloom: FullPass[];
  composite: FullPass;
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
  private clarity: Level[] = [];
  private chains: Chain[] = [];
  /** Set once by the engine when GPU timing is on (?perf). */
  timestamps: GPURenderPassTimestampWrites | undefined;
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
          targets: [{ format, blend: additive ? { color: ADD, alpha: ADD } : undefined }],
        },
        primitive: { topology: 'triangle-list' },
      });
    this.resolvePipe = make('resolve', 'fs_resolve', HDR_FORMAT);
    this.downFirstPipe = make('bloom down first', 'fs_down_first', HDR_FORMAT);
    this.downPipe = make('bloom down', 'fs_down', HDR_FORMAT);
    this.upPipe = make('bloom up', 'fs_up', HDR_FORMAT, undefined, true);
    this.compositePipe = make('composite', 'fs_composite', gpu.format, {
      HDR_OUT: gpu.extended ? 1 : 0,
      DIRECT: variant.render.finish === 'direct' ? 1 : 0,
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
    this.accumBuf = this.device.createBuffer({
      label: 'accum',
      size: width * height * ACCUM_BYTES_PER_PIXEL,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.hdr = [this.level(width, height, 'hdr a'), this.level(width, height, 'hdr b')];
    this.bloom = [];
    this.clarity = [];
    let w = width;
    let h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.bloom.push(this.level(w, h, `bloom ${i}`));
      if (i < CLARITY_LEVELS) this.clarity.push(this.level(w, h, `clarity ${i}`));
    }
    this.chains = [this.chain(0), this.chain(1)];
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
    // zoom: diving spreads the same light over more pixels; lift the density so it stays lit
    d.set([(s.zoom * this.width * this.height) / Math.max(1, particleCount), s.breath, 0, 0], 12);
    d.set(this.background, 16);
    d.set([s.clarity, s.dive, s.dky, s.still], 20);
    d.set(s.bloomTint, 24);
    this.device.queue.writeBuffer(this.params, 0, d);

    const chain = this.chains[this.flip];
    run(encoder, chain.resolve);
    if (s.clarity !== 0)
      for (let i = 0; i < chain.clarity.length; i++) run(encoder, chain.clarity[i]);
    for (let i = 0; i < chain.bloom.length; i++) run(encoder, chain.bloom[i]);
    // the swapchain view is new every frame; the timing query rides on the last pass
    chain.composite.color.view = target;
    chain.composite.desc.timestampWrites = this.timestamps;
    run(encoder, chain.composite);
    this.flip ^= 1;
  }

  /** The passes for one frame, given which of the two history textures this frame writes. */
  private chain(cur: number): Chain {
    const { hdr, bloom, clarity, sampler } = this;
    const params = { binding: 0, resource: { buffer: this.params } };
    const bindings = (pipe: GPURenderPipeline, ...entries: GPUBindGroupEntry[]): GPUBindGroup =>
      this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
    const src = (view: GPUTextureView): GPUBindGroupEntry[] => [
      { binding: 1, resource: view },
      { binding: 2, resource: sampler },
    ];
    const full = (
      pipe: GPURenderPipeline,
      bind: GPUBindGroup,
      view: GPUTextureView,
      loadOp: GPULoadOp = 'clear',
    ): FullPass => {
      const color: GPURenderPassColorAttachment = {
        view,
        loadOp,
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      };
      return { pipe, bind, color, desc: { colorAttachments: [color] } };
    };

    const resolve = full(
      this.resolvePipe,
      bindings(
        this.resolvePipe,
        params,
        { binding: 1, resource: { buffer: this.accum } },
        { binding: 2, resource: hdr[cur ^ 1].view },
      ),
      hdr[cur].view,
    );
    // hdr -> 1/2 -> 1/4 -> 1/8 with the plain 4-tap downsample (no threshold)
    const blur: FullPass[] = clarity.map((level, i) =>
      full(
        this.downPipe,
        bindings(this.downPipe, ...src(i === 0 ? hdr[cur].view : clarity[i - 1].view)),
        level.view,
      ),
    );
    const bloomPasses: FullPass[] = [
      full(
        this.downFirstPipe,
        bindings(this.downFirstPipe, params, ...src(hdr[cur].view)),
        bloom[0].view,
      ),
    ];
    for (let i = 1; i < BLOOM_LEVELS; i++)
      bloomPasses.push(
        full(this.downPipe, bindings(this.downPipe, ...src(bloom[i - 1].view)), bloom[i].view),
      );
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--)
      bloomPasses.push(
        full(this.upPipe, bindings(this.upPipe, ...src(bloom[i + 1].view)), bloom[i].view, 'load'),
      );
    const composite = full(
      this.compositePipe,
      bindings(
        this.compositePipe,
        params,
        { binding: 1, resource: hdr[cur].view },
        { binding: 2, resource: bloom[0].view },
        { binding: 3, resource: sampler },
        { binding: 4, resource: clarity[CLARITY_LEVELS - 1].view },
      ),
      hdr[cur].view,
    );
    return { resolve, clarity: blur, bloom: bloomPasses, composite };
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
    for (const l of [...this.hdr, ...this.bloom, ...this.clarity]) l.tex.destroy();
  }
}

function run(encoder: GPUCommandEncoder, p: FullPass): void {
  const pass = encoder.beginRenderPass(p.desc);
  pass.setPipeline(p.pipe);
  pass.setBindGroup(0, p.bind);
  pass.draw(3);
  pass.end();
}
