/** Page-level theming from the running variant: ground colour, accent, and light/dark text. */
import type { Variant } from './variants/types';

/** sRGB 0..1 to a CSS colour. */
const css = ([r, g, b]: readonly number[]): string =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

/** Apply as early as possible, so even the no-WebGPU poster wears the variant's colours. */
export function applyTheme(v: Variant): void {
  const root = document.documentElement;
  const ground = css(v.render.background);
  root.dataset.theme = v.hud.theme;
  root.style.setProperty('--ink', ground);
  root.style.setProperty('--accent', v.hud.accent);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ground);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', v.hud.theme);
}
