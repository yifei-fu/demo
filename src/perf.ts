/** GPU frame time via timestamp queries, where the adapter has them (the ?perf overlay). */
import type { Gpu } from './gpu';

const NS_TO_MS = 1e-6;
const SMOOTHING = 0.1;

export class PerfProbe {
  /** Attach to the first compute pass of a frame. */
  readonly begin: GPUComputePassTimestampWrites | undefined;
  /** Attach to the last render pass of a frame. */
  readonly end: GPURenderPassTimestampWrites | undefined;
  /** Smoothed GPU milliseconds per frame, or null when timestamps are unavailable. */
  gpuMs: number | null = null;

  private readonly querySet: GPUQuerySet | undefined;
  private readonly resolveBuf: GPUBuffer | undefined;
  private readonly readBuf: GPUBuffer | undefined;
  private reading = false;
  private issued = false;

  constructor(gpu: Gpu) {
    if (!gpu.timestamps) return;
    const device = gpu.device;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    this.resolveBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.begin = { querySet: this.querySet, beginningOfPassWriteIndex: 0 };
    this.end = { querySet: this.querySet, endOfPassWriteIndex: 1 };
  }

  /** After the frame's last pass, in the same encoder. */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuf || !this.readBuf || this.reading) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, 16);
    this.issued = true;
  }

  /** After the encoder was submitted. */
  collect(): void {
    const buf = this.readBuf;
    if (!buf || !this.issued) return;
    this.issued = false;
    this.reading = true;
    void buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const t = new BigUint64Array(buf.getMappedRange().slice(0));
        buf.unmap();
        const ms = Number(t[1] - t[0]) * NS_TO_MS;
        if (ms > 0 && ms < 1000)
          this.gpuMs = this.gpuMs === null ? ms : this.gpuMs + (ms - this.gpuMs) * SMOOTHING;
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
      });
  }
}
