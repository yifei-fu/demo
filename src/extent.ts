/**
 * Where the attractor is and how big: the particle kernel sums a sparse sample of settled
 * particles into a tiny buffer, and this reads it back asynchronously (never stalling a frame).
 */

const WORDS = 8;
const BYTES = WORDS * 4;
const POS_FIXED = 16384;
const SQ_FIXED = 4096;
const MIN_SAMPLES = 96;

export interface Extent {
  /** centroid of the settled particles */
  center: [number, number, number];
  /** root-mean-square distance from the centroid */
  rms: number;
}

export class ExtentProbe {
  readonly buffer: GPUBuffer;
  private readonly readBuf: GPUBuffer;
  private pending: Promise<void> | null = null;
  private wanted = false;
  private latest: Extent | null = null;
  private readonly out: Extent = { center: [0, 0, 0], rms: 0 };

  constructor(device: GPUDevice) {
    this.buffer = device.createBuffer({
      label: 'extent',
      size: BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.readBuf = device.createBuffer({
      label: 'extent read',
      size: BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  /** In flight until the last requested readback has landed (tests await it for determinism). */
  get busy(): Promise<void> | null {
    return this.pending;
  }

  /** Newest measurement, or null before the first one arrives. */
  get value(): Extent | null {
    return this.latest;
  }

  /** Start of a frame's encoder: zero the sums. */
  clear(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.buffer);
  }

  /** After the particle pass: ask for this frame's sums, unless a readback is still in flight. */
  request(encoder: GPUCommandEncoder): void {
    this.wanted = this.pending === null;
    if (this.wanted) encoder.copyBufferToBuffer(this.buffer, 0, this.readBuf, 0, BYTES);
  }

  /** After the encoder has been submitted. */
  collect(): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.pending = this.readBuf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const w = new Int32Array(this.readBuf.getMappedRange().slice(0));
        this.readBuf.unmap();
        const n = w[0];
        if (n >= MIN_SAMPLES) {
          const c = this.out.center;
          c[0] = w[1] / n / POS_FIXED;
          c[1] = w[2] / n / POS_FIXED;
          c[2] = w[3] / n / POS_FIXED;
          const mean2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
          this.out.rms = Math.sqrt(Math.max(0, (w[4] >>> 0) / n / SQ_FIXED - mean2));
          this.latest = this.out;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending = null;
      });
  }
}
