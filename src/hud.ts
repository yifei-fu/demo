/** DOM overlays: start gate, law readout, mute button, debug overlay, fallback and lost screens. */
import { Readout } from './readout';
import type { SpectrumReading } from './wasm';

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

interface HudCallbacks {
  /** Runs synchronously inside the Begin tap: the only place permissions may be requested. */
  onBegin: () => void;
  onMute: (muted: boolean) => void;
}

interface HudOptions {
  debug: boolean;
  perf: boolean;
  gate: boolean;
  /** Shipped variants for the start screen's quiet row, and the one that is running. */
  variants: readonly { id: string; name: string }[];
  current: string;
  seed: number;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly gate: HTMLElement;
  private readonly readout = new Readout();
  private readonly mute: HTMLButtonElement;
  private readonly debugEl: HTMLElement | null;
  private readonly perfEl: HTMLElement | null;

  constructor(root: HTMLElement, cb: HudCallbacks, opts: HudOptions) {
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
    foot.append(how, begin, this.variantRow(opts));
    this.gate.append(head, foot);

    this.mute = el('button', 'mute');
    this.mute.type = 'button';
    this.mute.ariaLabel = 'Sound';
    this.mute.setAttribute('aria-pressed', 'false');
    this.mute.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/>' +
      '<g class="waves"><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.8a7.4 7.4 0 0 1 0 10.4"/></g>' +
      '<path class="slash" d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
    this.mute.addEventListener('click', () => {
      const muted = this.mute.getAttribute('aria-pressed') !== 'true';
      this.setMuted(muted);
      cb.onMute(muted);
    });

    this.debugEl = opts.debug ? el('div', 'debug') : null;
    this.perfEl = opts.perf ? el('div', 'perf') : null;
    root.append(...(opts.gate ? [this.gate] : []), this.readout.el, this.mute);
    if (this.debugEl) root.append(this.debugEl);
    if (this.perfEl) root.append(this.perfEl);
    if (!opts.gate) document.body.classList.add('begun');
  }

  /** Reflect a mute state that did not come from a tap (the persisted preference). */
  setMuted(muted: boolean): void {
    this.mute.setAttribute('aria-pressed', String(muted));
  }

  /** A quiet row of variant names; the running one is lit, the others reload with ?v=. */
  private variantRow(opts: HudOptions): HTMLElement {
    const row = el('nav', 'variants');
    row.ariaLabel = 'Variant';
    for (const v of opts.variants) {
      const b = el('button', v.id === opts.current ? 'variant on' : 'variant', v.name);
      b.type = 'button';
      if (v.id === opts.current) b.setAttribute('aria-current', 'true');
      else
        b.addEventListener('click', () => {
          const url = new URL(location.href);
          url.searchParams.set('v', v.id);
          url.searchParams.set('seed', String(opts.seed));
          location.href = url.href;
        });
      row.append(b);
    }
    return row;
  }

  /** Fade the gate out and reveal the readout and mute button. */
  dismissGate(): void {
    document.body.classList.add('begun');
    this.gate.classList.add('leaving');
    setTimeout(() => this.gate.remove(), 1600);
  }

  /** `time`: simulation seconds, so the readout behaves the same when tests step frames quickly. */
  setReadout(params: Float32Array, spectrum: SpectrumReading, time: number): void {
    this.readout.update(params, spectrum, time);
  }

  setPerf(text: string): void {
    if (this.perfEl) this.perfEl.textContent = text;
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
export function showFallback(
  root: HTMLElement,
  message = 'AXIOM needs WebGPU \u2014 Safari on iOS 26+, or Chrome.',
): void {
  document.getElementById('stage')?.remove();
  const box = el('div', 'fallback');
  const top = el('div', 'top');
  top.append(el('h1', '', 'AXIOM'));
  const bottom = el('div', 'bottom');
  bottom.append(el('p', '', message));
  box.append(el('div', 'glow'), el('div', 'point'), top, bottom);
  root.append(box);
  document.body.classList.add('no-webgpu');
}
