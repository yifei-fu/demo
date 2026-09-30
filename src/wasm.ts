/** The Rust core (law, Lyapunov spectrum) as one main-thread wasm instance. See DESIGN §4, §8. */
import wasmUrl from './assets/axiom.wasm?url';
import { LAW_LEN } from './law';

export interface SpectrumReading {
  l1: number;
  l2: number;
  l3: number;
  /** Kaplan-Yorke dimension. */
  dky: number;
  /** 0 fixed point, 1 cycle, 2 torus, 3 strange, 4 labyrinth. */
  regime: number;
  /** Position of the probe trajectory the spectrum is measured along. */
  tracer: [number, number, number];
}

export interface Core {
  /** Raw module bytes, posted to the AudioWorklet which instantiates its own copy. */
  readonly bytes: ArrayBuffer;
  readonly anchorCount: number;
  /** The 68-float LawParams block for the bead at (u, v). Copied out of wasm memory. */
  lawParams(u: number, v: number, seed: number, out?: Float32Array): Float32Array;
  /** Advance the spectrum probe by `worldTime` world-time units along the given law. */
  spectrumStep(params: Float32Array, worldTime: number): void;
  /** The same object every call, refilled: copy what you need to keep. */
  spectrumRead(): SpectrumReading;
}

interface Exports {
  memory: WebAssembly.Memory;
  alloc(bytes: number): number;
  law_params_len(): number;
  law_anchor_count(): number;
  law_params(u: number, v: number, seed: number, out: number): void;
  spectrum_new(seed: number): number;
  spectrum_step(s: number, params: number, worldTime: number): void;
  spectrum_read(s: number, out: number): void;
}

const READ_LEN = 8;

export async function loadCore(seed: number): Promise<Core> {
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports as unknown as Exports;

  const len = x.law_params_len();
  if (len !== LAW_LEN)
    throw new Error(`axiom.wasm law block is ${len} floats, engine expects ${LAW_LEN}`);

  // Scratch blocks live for the page's lifetime. Views are rebuilt on every use because a
  // growing memory detaches the previous ArrayBuffer.
  const lawPtr = x.alloc(LAW_LEN * 4);
  const paramPtr = x.alloc(LAW_LEN * 4);
  const readPtr = x.alloc(READ_LEN * 4);
  const spectrum = x.spectrum_new(seed >>> 0);
  // Views are cached per memory buffer: nothing is allocated per call unless the memory grew.
  let buffer: ArrayBuffer | null = null;
  let lawView = new Float32Array(0);
  let paramView = new Float32Array(0);
  let readView = new Float32Array(0);
  const views = (): void => {
    if (buffer === x.memory.buffer) return;
    buffer = x.memory.buffer;
    lawView = new Float32Array(buffer, lawPtr, LAW_LEN);
    paramView = new Float32Array(buffer, paramPtr, LAW_LEN);
    readView = new Float32Array(buffer, readPtr, READ_LEN);
  };
  const reading: SpectrumReading = { l1: 0, l2: 0, l3: 0, dky: 0, regime: 0, tracer: [0, 0, 0] };

  return {
    bytes,
    anchorCount: x.law_anchor_count(),
    lawParams(u, v, s, out = new Float32Array(LAW_LEN)) {
      x.law_params(u, v, s >>> 0, lawPtr);
      views();
      out.set(lawView);
      return out;
    },
    spectrumStep(params, worldTime) {
      views();
      paramView.set(params);
      x.spectrum_step(spectrum, paramPtr, worldTime);
    },
    spectrumRead() {
      x.spectrum_read(spectrum, readPtr);
      views();
      const r = readView;
      reading.l1 = r[0];
      reading.l2 = r[1];
      reading.l3 = r[2];
      reading.dky = r[3];
      reading.regime = r[4];
      reading.tracer[0] = r[5];
      reading.tracer[1] = r[6];
      reading.tracer[2] = r[7];
      return reading;
    },
  };
}
