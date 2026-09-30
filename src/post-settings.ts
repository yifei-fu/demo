/** Per-frame finish settings: what a variant asks for, plus what the engine layers on top. */
import type { Variant } from './variants/types';

const VIGNETTE = 0.42;

export interface PostSettings {
  /** Scene-referred gain ahead of the tonemap. */
  exposure: number;
  /** Trail persistence: weight of the previous frame in the running average. */
  trail: number;
  bloom: number;
  grain: number;
  vignette: number;
  /** Chromatic aberration at the frame corners, as a fraction of the frame. */
  ca: number;
  /** Slow multiplicative pulse on the exposure. */
  breath: number;
  /** Local contrast: 0 off, ~1 a strong unsharp mask of the light. */
  clarity: number;
  /** Linear multiplier on the bloom term only. */
  bloomTint: readonly [number, number, number];
  /** 0..1 how far the camera has dived; widens the denoise. */
  dive: number;
  /** Density lift for a magnified view (diving, or a camera pulled back). */
  zoom: number;
  /** Eased Kaplan-Yorke dimension and still-point flag (axiom_dky / axiom_still). */
  dky: number;
  still: number;
}

export function settingsFor(v: Variant): PostSettings {
  const r = v.render;
  return {
    exposure: r.exposure,
    trail: r.trail,
    bloom: r.bloom,
    grain: r.grain,
    vignette: VIGNETTE,
    ca: r.aberration,
    breath: 1,
    clarity: r.clarity ?? 0,
    bloomTint: r.bloomTint ?? [1, 1, 1],
    dive: 0,
    zoom: 1,
    dky: 0,
    still: 1,
  };
}

/** Variants write their background as sRGB; the shaders work in linear light. */
export const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
