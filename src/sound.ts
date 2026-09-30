/** Glue between the running piece and the audio engine. Never throws: sound is a bonus. */
import { SynthParam, startAudio, unlockAudio, type AudioEngine } from './audio';
import type { Engine } from './engine';
import type { Variant } from './variants/types';

/** Parameters are only re-sent when they moved by more than this. */
const EPSILON = 0.004;

export class Sound {
  private ctx: AudioContext | null = null;
  private audio: AudioEngine | null = null;
  private wantMuted: boolean | null = null;
  private warned = false;
  private readonly last = new Map<SynthParam, number>();

  /** Call synchronously inside the Begin tap: iOS only unlocks audio from a user gesture. */
  unlock(): void {
    try {
      this.ctx = unlockAudio();
    } catch (err) {
      this.warn(err);
    }
  }

  /** Start the synth once the core is loaded. Resolves to the persisted mute state, if any. */
  async start(engine: Engine, variant: Variant): Promise<boolean | null> {
    if (!this.ctx) return null;
    try {
      this.audio = await startAudio(this.ctx, engine.core.bytes, engine.seed, variant.sound);
      if (this.wantMuted !== null) this.audio.setMuted(this.wantMuted);
      return this.audio.muted;
    } catch (err) {
      this.warn(err);
      return null;
    }
  }

  setMuted(muted: boolean): void {
    this.wantMuted = muted;
    this.audio?.setMuted(muted);
  }

  /** Once per frame: hand the audio engine the law and the felt state of the piece. */
  frame(engine: Engine): void {
    const audio = this.audio;
    if (!audio) return;
    audio.setLaw(engine.law);
    this.send(SynthParam.Stir, engine.stirring.level);
    this.send(SynthParam.Dive, engine.rig.state.dive);
    this.send(SynthParam.Lambda1, engine.spectrum.l1);
    this.send(SynthParam.Dky, engine.spectrum.dky);
    if (engine.sensors.input.shake) audio.set(SynthParam.Shake, 1);
  }

  private send(id: SynthParam, value: number): void {
    const prev = this.last.get(id);
    if (prev !== undefined && Math.abs(prev - value) < EPSILON) return;
    this.last.set(id, value);
    this.audio?.set(id, value);
  }

  private warn(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('[axiom] sound unavailable:', err);
  }
}
