/**
 * AudioWorklet side of AXIOM's sound: hosts the Rust synth (DESIGN §4). No imports, so the
 * production build emits it as one self-contained module. Messages are typed for audio.ts.
 */
export type WorkletIn =
  | { type: 'init'; bytes: ArrayBuffer; seed: number }
  | { type: 'law'; params: Float32Array }
  | { type: 'set'; id: number; value: number };
export type WorkletOut = { type: 'ready' } | { type: 'error'; message: string };

// The worklet global scope is not in the DOM lib; declare the little we use (module-local).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const LAW_LEN = 68;
/** `synth_render` accepts at most this many frames per call. */
const CHUNK = 256;

interface SynthExports {
  memory: WebAssembly.Memory;
  alloc(bytes: number): number;
  synth_new(sampleRate: number, seed: number): number;
  synth_set_law(s: number, params: number): void;
  synth_set(s: number, id: number, value: number): void;
  synth_render(s: number, frames: number): number;
}

function synthExports(instance: WebAssembly.Instance): SynthExports {
  const x = instance.exports;
  for (const name of ['alloc', 'synth_new', 'synth_set_law', 'synth_set', 'synth_render']) {
    if (typeof x[name] !== 'function') throw new Error(`axiom.wasm has no export "${name}"`);
  }
  if (!(x.memory instanceof WebAssembly.Memory)) throw new Error('axiom.wasm exports no memory');
  return x as unknown as SynthExports;
}

class AxiomSynth extends AudioWorkletProcessor {
  private wasm: SynthExports | null = null;
  private synth = 0;
  private lawPtr = 0;
  // Views are cached per ArrayBuffer so process() never allocates; growth swaps the buffer.
  private lawBuf: ArrayBufferLike | null = null;
  private lawView = new Float32Array(0);
  private outBuf: ArrayBufferLike | null = null;
  private outPtr = 0;
  private outView = new Float32Array(0);
  private faulted = false;
  private reportedBad = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletIn>) => {
      try {
        this.receive(e.data);
      } catch (err) {
        this.fault(err);
      }
    };
  }

  private receive(msg: WorkletIn): void {
    if (msg.type === 'init') {
      if (this.wasm) return;
      const wasm = synthExports(new WebAssembly.Instance(new WebAssembly.Module(msg.bytes), {}));
      this.synth = wasm.synth_new(sampleRate, msg.seed >>> 0);
      this.lawPtr = wasm.alloc(LAW_LEN * 4);
      this.wasm = wasm;
      this.port.postMessage({ type: 'ready' } satisfies WorkletOut);
    } else if (!this.wasm) {
      return; // nothing to steer yet
    } else if (msg.type === 'law') {
      if (msg.params.length < LAW_LEN) return;
      const buf = this.wasm.memory.buffer;
      if (buf !== this.lawBuf) {
        this.lawBuf = buf;
        this.lawView = new Float32Array(buf, this.lawPtr, LAW_LEN);
      }
      this.lawView.set(msg.params.subarray(0, LAW_LEN));
      this.wasm.synth_set_law(this.synth, this.lawPtr);
    } else if (msg.type === 'set') {
      this.wasm.synth_set(this.synth, msg.id >>> 0, msg.value);
    }
  }

  private report(message: string): void {
    this.port.postMessage({ type: 'error', message } satisfies WorkletOut);
  }

  /** A trap or bad module silences the synth for good; the page keeps running. */
  private fault(err: unknown): void {
    if (this.faulted) return;
    this.faulted = true;
    this.report(err instanceof Error ? err.message : String(err));
  }

  /** Interleaved stereo frames the synth just rendered at `ptr`. */
  private frames(wasm: SynthExports, ptr: number): Float32Array {
    const buf = wasm.memory.buffer;
    if (buf !== this.outBuf || ptr !== this.outPtr) {
      this.outBuf = buf;
      this.outPtr = ptr;
      this.outView = new Float32Array(buf, ptr, 2 * CHUNK);
    }
    return this.outView;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const left = outputs[0]?.[0];
    const wasm = this.wasm;
    if (!left || !wasm || this.faulted) return true; // the host hands us zeroed buffers
    const right = outputs[0]?.[1];
    let bad = 0;
    try {
      for (let done = 0; done < left.length; done += CHUNK) {
        const n = Math.min(CHUNK, left.length - done);
        const src = this.frames(wasm, wasm.synth_render(this.synth, n));
        for (let i = 0; i < n; i++) {
          const l = src[2 * i];
          const r = src[2 * i + 1];
          if (l >= -1 && l <= 1 && r >= -1 && r <= 1) {
            left[done + i] = l;
            if (right) right[done + i] = r;
          } else bad++; // NaN or out of range: leave silence rather than hurt the speakers
        }
      }
    } catch (err) {
      left.fill(0);
      right?.fill(0);
      this.fault(err);
    }
    if (bad > 0 && !this.reportedBad) {
      this.reportedBad = true;
      this.report(`synth produced ${bad} invalid samples in one block`);
    }
    return true;
  }
}

registerProcessor('axiom-synth', AxiomSynth);
