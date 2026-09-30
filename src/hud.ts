/** DOM overlays: start gate, law readout, mute button, debug overlay, fallback and lost screens. */
import { LAW_LEN } from './law';

const MINUS = '−';
const KIND_NAMES = ['thomas', 'aizawa', 'lorenz', 'rössler', 'halvorsen'];

const f2 = (v: number): string => v.toFixed(2).replace('-', MINUS);
const sub = (v: number): string => (v < 0 ? `+ ${(-v).toFixed(2)}` : `${MINUS} ${v.toFixed(2)}`);

/** One line of the dominant law with its live coefficients, read straight from the params block. */
export function lawEquation(p: Float32Array): { eq: string; meta: string } {
  const slot = (i: number) => {
    const o = 4 + 32 * i;
    return { kind: Math.round(p[o]), w: p[o + 1], p: p.subarray(o + 8, o + 16) };
  };
  const a = slot(0);
  const b = slot(1);
  const dom = b.kind >= 0 && b.w > a.w ? b : a;
  const q = dom.p;
  let eq = '';
  switch (dom.kind) {
    case 0:
      eq = `ẋ = sin y ${sub(q[0])} x`.replace(/(\d\.\d\d) x/, '$1 x');
      eq = `ẋ = sin y ${MINUS} ${q[0].toFixed(2)} x`;
      break;
    case 1:
      eq = `ẋ = (z ${sub(q[1])}) x ${sub(q[3])} y`;
      break;
    case 2:
      eq = `ẋ = ${q[0].toFixed(2)} (y ${MINUS} x)`;
      break;
    case 3:
      eq = `ż = ${q[1].toFixed(2)} + z (x ${sub(q[2])})`;
      break;
    case 4:
      eq = `ẋ = ${MINUS}${q[0].toFixed(2)} x ${MINUS} 4y ${MINUS} 4z ${MINUS} y²`;
      break;
    default:
      eq = 'ẋ = 0';
  }
  const r = p[0];
  const theta = ((p[1] * 180) / Math.PI + 360) % 360;
  const blend =
    b.kind >= 0 && b.w > 0.02 && a.w > 0.02
      ? `${KIND_NAMES[a.kind]} ${Math.round(a.w * 100)} · ${KIND_NAMES[b.kind]} ${Math.round(b.w * 100)}`
      : (KIND_NAMES[dom.kind] ?? '');
  return { eq, meta: `${blend} · r ${f2(r)} · θ ${Math.round(theta)}°` };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface HudCallbacks {
  /** Runs synchronously inside the Begin tap: the only place permissions may be requested. */
  onBegin: () => void;
  onMute: (muted: boolean) => void;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly gate: HTMLElement;
  private readonly eqEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly debugEl: HTMLElement | null;
  private lastText = '';
  private lastMeta = '';

  constructor(root: HTMLElement, cb: HudCallbacks, opts: { debug: boolean; gate: boolean }) {
    this.root = root;

    this.gate = el('div', 'gate');
    const head = el('header', 'gate-head');
    const sub = el('p', 'sub');
    sub.append(
      el('span', 'one', 'one law'),
      el('span', 'sep', ' \u00b7 '),
      el('span', 'every', 'every world between stillness and chaos'),
    );
    head.append(el('h1', '', 'AXIOM'), sub);
    const foot = el('footer', 'gate-foot');
    const begin = el('button', 'begin', 'Begin');
    begin.type = 'button';
    begin.addEventListener('click', () => {
      if (this.gate.classList.contains('leaving')) return;
      cb.onBegin();
    });
    const how = el('p', 'how');
    ['tilt to change the law', 'turn to walk around it', 'hold to dive', 'shake'].forEach(
      (t, i) => {
        if (i > 0) how.append(el('span', 'sep', ' \u00b7 '));
        how.append(el('span', 'item', t));
      },
    );
    foot.append(how, begin);
    this.gate.append(head, foot);

    const readout = el('div', 'readout');
    this.eqEl = el('div', 'eq');
    this.metaEl = el('div', 'meta');
    readout.append(this.eqEl, this.metaEl);

    const mute = el('button', 'mute');
    mute.type = 'button';
    mute.ariaLabel = 'Sound';
    mute.setAttribute('aria-pressed', 'false');
    mute.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/>' +
      '<g class="waves"><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.8a7.4 7.4 0 0 1 0 10.4"/></g>' +
      '<path class="slash" d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
    mute.addEventListener('click', () => {
      const muted = mute.getAttribute('aria-pressed') !== 'true';
      mute.setAttribute('aria-pressed', String(muted));
      cb.onMute(muted);
    });

    this.debugEl = opts.debug ? el('div', 'debug') : null;
    root.append(...(opts.gate ? [this.gate] : []), readout, mute);
    if (this.debugEl) root.append(this.debugEl);
    if (!opts.gate) document.body.classList.add('begun');
  }

  /** Fade the gate out and reveal the readout and mute button. */
  dismissGate(): void {
    document.body.classList.add('begun');
    this.gate.classList.add('leaving');
    setTimeout(() => this.gate.remove(), 1600);
  }

  setLaw(params: Float32Array): void {
    if (params.length < LAW_LEN) return;
    const { eq, meta } = lawEquation(params);
    if (eq !== this.lastText) this.eqEl.textContent = this.lastText = eq;
    if (meta !== this.lastMeta) this.metaEl.textContent = this.lastMeta = meta;
  }

  setDebug(text: string): void {
    if (this.debugEl) this.debugEl.textContent = text;
  }

  showLost(reason: string): void {
    if (reason === 'destroyed') return;
    const box = el('div', 'fallback');
    box.append(el('div', 'glow'), el('div', 'point'));
    const top = el('div', 'top');
    top.append(el('h1', '', 'AXIOM'));
    const bottom = el('div', 'bottom');
    const btn = el('button', '', 'Reload');
    btn.type = 'button';
    btn.addEventListener('click', () => location.reload());
    bottom.append(el('p', '', 'The GPU connection was lost. Reload to continue.'), btn);
    box.append(top, bottom);
    this.root.append(box);
  }
}

/** No WebGPU: a CSS-only poster. A slowly breathing glow around a single point. */
export function showFallback(root: HTMLElement): void {
  document.getElementById('stage')?.remove();
  const box = el('div', 'fallback');
  const top = el('div', 'top');
  top.append(el('h1', '', 'AXIOM'));
  const bottom = el('div', 'bottom');
  bottom.append(el('p', '', 'AXIOM needs WebGPU — Safari on iOS 26+, or Chrome.'));
  box.append(el('div', 'glow'), el('div', 'point'), top, bottom);
  root.append(box);
  document.body.classList.add('no-webgpu');
}
