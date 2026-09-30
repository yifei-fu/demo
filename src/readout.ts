/** The quiet line of maths at the bottom of the screen: the live law, its regime, D and lambda 1. */
import { readLaw, type LawSlot, type LawView } from './law';
import type { SpectrumReading } from './wasm';

const MINUS = '−';
const ANCHORS = ['Thomas', 'Aizawa', 'Lorenz', 'Rössler', 'Halvorsen'];
const REGIMES = ['fixed point', 'cycle', 'torus', 'strange', 'labyrinth'];
/** A regime must hold this many seconds (of simulation time) before the label changes. */
const REGIME_HOLD = 0.5;

const num = (v: number): string => Math.abs(v).toFixed(2);
const term = (v: number): string => (v < 0 ? `+ ${num(v)}` : `${MINUS} ${num(v)}`);

/** One line of the dominant anchor's equations with the live coefficients. */
function lawEquation(s: LawSlot): string {
  const p = s.p;
  switch (s.kind) {
    case 0:
      return `ẋ = sin y ${MINUS} ${num(p[0])} x`;
    case 1:
      return `ẋ = (z ${term(p[1])}) x ${term(p[3])} y`;
    case 2:
      return `ẋ = ${num(p[0])} (y ${MINUS} x)`;
    case 3:
      return `ż = ${num(p[1])} + z (x ${term(p[2])})`;
    case 4:
      return `ẋ = ${MINUS}${num(p[0])} x ${MINUS} 4y ${MINUS} 4z ${MINUS} y²`;
    default:
      return 'ẋ = 0';
  }
}

/** "0.62 Thomas + 0.38 Aizawa" while blending, the bare anchor name otherwise. */
function anchorMix(law: LawView): string {
  const [a, b] = law.slots;
  if (b.kind >= 0 && b.weight > 0.01 && a.weight > 0.01)
    return `${num(a.weight)} ${ANCHORS[a.kind]} + ${num(b.weight)} ${ANCHORS[b.kind]}`;
  return ANCHORS[(a.weight >= b.weight ? a : b).kind] ?? '';
}

export class Readout {
  readonly el: HTMLElement;
  private readonly eq = document.createElement('div');
  private readonly mix = document.createElement('div');
  private readonly state = document.createElement('div');
  private shown = -1;
  private candidate = -1;
  private since = 0;
  private lastUpdate = 0;
  private text = ['', '', ''];

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'readout';
    this.eq.className = 'eq';
    this.mix.className = 'mix';
    this.state.className = 'state';
    this.el.append(this.eq, this.mix, this.state);
  }

  update(params: Float32Array, s: SpectrumReading, now: number): void {
    const law = readLaw(params);
    const [a, b] = law.slots;
    const dominant = b.kind >= 0 && b.weight > a.weight ? b : a;

    // A long gap since the last update (a test stepping many frames at once) is as good as a hold.
    const gap = now - this.lastUpdate > REGIME_HOLD;
    this.lastUpdate = now;
    if (s.regime !== this.candidate) {
      this.candidate = s.regime;
      this.since = now;
    }
    if (this.shown < 0 || gap || (this.candidate !== this.shown && now - this.since > REGIME_HOLD))
      this.shown = this.candidate;

    const l1 = `${s.l1 < 0 ? MINUS : '+'}${Math.abs(s.l1).toFixed(2)}`;
    const next = [
      lawEquation(dominant),
      anchorMix(law),
      `${REGIMES[this.shown] ?? ''} · D ${s.dky.toFixed(2)} · λ₁ ${l1}`,
    ];
    if (next[0] !== this.text[0]) this.eq.textContent = next[0];
    if (next[1] !== this.text[1]) this.mix.textContent = next[1];
    if (next[2] !== this.text[2]) this.state.textContent = next[2];
    this.text = next;
  }
}
