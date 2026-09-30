/** Main-thread half of AXIOM's sound: unlock, start, output level and control of the worklet synth. */
import workletUrl from './audio-worklet.ts?worker&url';
import type { WorkletIn, WorkletOut } from './audio-worklet';

export const enum SynthParam {
  Master = 0,
  Stir = 1,
  Dive = 2,
  Shake = 3,
  Preset = 4,
  RootHz = 5,
  Lambda1 = 6,
  Dky = 7,
}

export interface AudioEngine {
  /** Call every frame; throttled internally to ≤ 30 Hz. */
  setLaw(params: Float32Array): void;
  /** Continuous controls are coalesced to ≤ 60 Hz (the latest value always gets through). */
  set(id: SynthParam, value: number): void;
  /** Fades, never clicks; persisted in localStorage. */
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

const LAW_LEN = 68;
const LAW_MS = 33;
const CONTROL_MS = 16;
/** setTargetAtTime time constant: 95 % of a fade in ~150 ms. */
const FADE_TC = 0.05;
/** Let a fade-out finish (e^-8) before the context is suspended. */
const SUSPEND_AFTER_MS = 400;
const READY_TIMEOUT_MS = 10_000;
const MUTE_KEY = 'axiom.muted';
const CONTINUOUS = [SynthParam.Stir, SynthParam.Dive, SynthParam.Lambda1, SynthParam.Dky];

/** Safari's AudioSession API is not in the DOM typings yet. */
interface AudioSessionNavigator extends Navigator {
  audioSession?: { type: string };
}

const noop = (): void => undefined;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false; // storage blocked (private window, embedded frame)
  }
}

function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // a preference that cannot be saved is not worth an error
  }
}

/** Create and resume the context. Call synchronously inside the Begin tap: iOS requires it. */
export function unlockAudio(): AudioContext {
  try {
    // 'playback' keeps sound on with the iOS silent switch engaged
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session) session.type = 'playback';
  } catch {
    // unsupported value: the default session still plays
  }
  const ctx = new AudioContext({ latencyHint: 'playback' });
  ctx.resume().catch(noop);
  return ctx;
}

/** Resolves once the worklet has instantiated the wasm synth. */
function handshake(node: AudioWorkletNode, bytes: ArrayBuffer, seed: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const problem = (message: string): void => {
      if (settled) {
        console.warn(`[axiom] audio: ${message}`); // after start: log, keep the page running
      } else {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`AXIOM audio: ${message}`));
      }
    };
    const timer = setTimeout(() => problem('the synth did not start in time'), READY_TIMEOUT_MS);
    node.onprocessorerror = () => problem('the audio worklet crashed');
    node.port.onmessage = (e: MessageEvent<WorkletOut>) => {
      if (e.data.type === 'error') problem(e.data.message);
      else if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const init: WorkletIn = { type: 'init', bytes, seed };
    node.port.postMessage(init, [bytes]);
  });
}

class SynthRig implements AudioEngine {
  private isMuted = readMuted();
  private lawAt = -Infinity;
  /** Continuous controls: last value delivered, when, and the newest one still waiting. */
  private readonly sent = new Float64Array(8).fill(NaN);
  private readonly sentAt = new Float64Array(8).fill(-Infinity);
  private readonly waiting = new Float64Array(8).fill(NaN);
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly master: GainNode,
  ) {
    ctx.addEventListener('statechange', () => {
      if (this.running) this.flush();
      else if (this.audible) this.wake(); // e.g. an iOS interruption just ended
    });
    document.addEventListener('visibilitychange', () => this.settle());
    // iOS may leave the context 'interrupted' (call, Siri) until the next gesture
    for (const type of ['pointerdown', 'touchend', 'keydown']) {
      window.addEventListener(type, () => this.audible && this.wake(), { capture: true });
    }
  }

  get muted(): boolean {
    return this.isMuted;
  }

  private get running(): boolean {
    return this.ctx.state === 'running';
  }

  private get audible(): boolean {
    return !this.isMuted && !document.hidden;
  }

  send(msg: WorkletIn, transfer: Transferable[] = []): void {
    this.node.port.postMessage(msg, transfer);
  }

  setLaw(params: Float32Array): void {
    const now = performance.now();
    if (now - this.lawAt < LAW_MS || params.length < LAW_LEN || !this.running) return;
    this.lawAt = now;
    const copy = params.slice(0, LAW_LEN); // never hand the engine's own buffer away
    this.send({ type: 'law', params: copy }, [copy.buffer]);
  }

  set(id: SynthParam, value: number): void {
    if (!CONTINUOUS.includes(id)) {
      this.send({ type: 'set', id, value });
      return;
    }
    this.waiting[id] = value;
    this.flush();
  }

  setMuted(muted: boolean): void {
    if (muted === this.isMuted) return;
    this.isMuted = muted;
    writeMuted(muted);
    this.settle();
  }

  /** Deliver the newest waiting continuous values, at most one per id per CONTROL_MS. */
  private flush(): void {
    if (!this.running) return; // 'statechange' flushes once sound is flowing again
    const now = performance.now();
    let soonest = Infinity;
    for (const id of CONTINUOUS) {
      const value = this.waiting[id];
      if (Number.isNaN(value)) continue;
      const due = this.sentAt[id] + CONTROL_MS - now;
      if (value === this.sent[id]) this.waiting[id] = NaN;
      else if (due > 0) soonest = Math.min(soonest, due);
      else {
        this.send({ type: 'set', id, value });
        this.sent[id] = value;
        this.sentAt[id] = now;
        this.waiting[id] = NaN;
      }
    }
    if (soonest < Infinity && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, soonest);
    }
  }

  private wake(): void {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(noop);
  }

  /**
   * Bring output level and context state in line with mute and visibility. Fade first, suspend
   * afterwards, so neither a mute nor a tab switch ever cuts the signal mid-cycle.
   */
  settle(): void {
    clearTimeout(this.suspendTimer);
    const gain = this.master.gain;
    const t = this.ctx.currentTime;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(gain.value, t);
    if (this.audible) {
      this.wake();
      gain.setTargetAtTime(1, t, FADE_TC);
    } else {
      gain.setTargetAtTime(0, t, FADE_TC);
      this.suspendTimer = setTimeout(() => {
        if (!this.audible) this.ctx.suspend().catch(noop);
      }, SUSPEND_AFTER_MS);
    }
  }
}

export async function startAudio(
  ctx: AudioContext,
  wasmBytes: ArrayBuffer,
  seed: number,
  sound: { preset: number; rootHz: number },
): Promise<AudioEngine> {
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    throw new Error(`AXIOM audio: the worklet failed to load (${describe(err)})`, { cause: err });
  }
  const node = new AudioWorkletNode(ctx, 'axiom-synth', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  try {
    await handshake(node, wasmBytes.slice(0), seed);
  } catch (err) {
    node.disconnect();
    throw err;
  }
  const master = ctx.createGain();
  master.gain.value = 0; // settle() fades in
  node.connect(master).connect(ctx.destination);

  const rig = new SynthRig(ctx, node, master);
  rig.send({ type: 'set', id: SynthParam.Preset, value: sound.preset });
  rig.send({ type: 'set', id: SynthParam.RootHz, value: sound.rootHz });
  rig.settle();
  return rig;
}
