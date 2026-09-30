/**
 * Where the attractor is and how big: the particle kernel sums a sparse sample of settled
 * particles into a tiny buffer (their positions, and a histogram of their distance from the last
 * known centre), and this reads it back asynchronously, never stalling a frame. The size is a
 * high percentile of the distance rather than an RMS, so the thin halo of particles still on
 * their way onto a slowly attracting cycle does not inflate it.
 */

const HIST_BINS = 32;
const HIST_RANGE = 2;
const SPEED_BINS = 48;
const SPEED_BASE = -8;
const SPEED_PER_OCTAVE = 3;
const WORDS = 4 + HIST_BINS + SPEED_BINS;
const BYTES = WORDS * 4;
const POS_FIXED = 16384;
const MIN_SAMPLES = 96;
/** Fraction of the sample the reported radius must enclose. */
const PERCENTILE = 0.9;
/** The reference speed is this percentile of the sampled speeds: the slowest 40 % are dimmed. */
const SPEED_PERCENTILE = 0.4;

export interface Extent {
  /** centroid of the settled particles */
  center: [number, number, number];
  /** radius around the centroid that encloses PERCENTILE of them */
  radius: number;
  /** a typical (slowish) speed of the settled particles, in world units per second */
  speed: number;
}

export class ExtentProbe {
  readonly buffer: GPUBuffer;
  /** The centre the histogram is measured from; the kernel reads it, the latest measurement moves it. */
  readonly probe: [number, number, number] = [0, 0, 0];
  private readonly readBuf: GPUBuffer;
  private pending: Promise<void> | null = null;
  private wanted = false;
  private latest: Extent | null = null;
  private readonly out: Extent = { center: [0, 0, 0], radius: 0, speed: 0 };

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
        this.decode(w);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending = null;
      });
  }

  private decode(w: Int32Array): void {
    const n = w[0];
    if (n < MIN_SAMPLES) return;
    const c = this.out.center;
    c[0] = w[1] / n / POS_FIXED;
    c[1] = w[2] / n / POS_FIXED;
    c[2] = w[3] / n / POS_FIXED;

    const target = PERCENTILE * n;
    let seen = 0;
    let bin = 0;
    while (bin < HIST_BINS - 1 && seen + w[4 + bin] < target) seen += w[4 + bin++];
    const inBin = w[4 + bin] || 1;
    this.out.radius = ((bin + (target - seen) / inBin) * HIST_RANGE) / HIST_BINS;

    const seenTarget = SPEED_PERCENTILE * n;
    let sSeen = 0;
    let sBin = 0;
    const sBase = 4 + HIST_BINS;
    while (sBin < SPEED_BINS - 1 && sSeen + w[sBase + sBin] < seenTarget)
      sSeen += w[sBase + sBin++];
    const sIn = w[sBase + sBin] || 1;
    const octave = sBin + (seenTarget - sSeen) / sIn;
    this.out.speed = 2 ** (SPEED_BASE + octave / SPEED_PER_OCTAVE);

    // the next histogram is measured from where the cloud actually is
    this.probe[0] = c[0];
    this.probe[1] = c[1];
    this.probe[2] = c[2];
    this.latest = this.out;
  }
}
