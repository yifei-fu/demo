/**
 * A variant is an art direction for the same piece: same law, same navigation, same gestures.
 * It differs in light, colour, finish and sound. A variant is two WGSL functions plus a handful of
 * numbers; everything else (integration, splatting, log-density, trails, bloom, AgX, HDR output)
 * belongs to the engine and is shared.
 *
 * To add one: create `<id>.ts` (+ `<id>.shade.wgsl`, `<id>.grade.wgsl`) exporting a `Variant`, and
 * add one line to `index.ts`.
 *
 * ## `shadeWgsl`: particle colour, run once per particle per frame inside the compute kernel
 *
 *     fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f
 *
 * - `speed`  world units per second of the particle's velocity, including stir and shake.
 *            On an attractor it is roughly 0.2 - 1.5 (median ~0.7); a stirred or shaken particle
 *            can reach 4 or more. It is what makes filaments change hue along their length.
 * - `phase`  per-particle random in [0, 1), fixed for the particle's life (redrawn on respawn).
 *            Independent of position, so it can carry hue jitter or a second colour family.
 * - `depth`  signed distance from the focal plane in world units: negative = nearer the camera.
 *            About -1.2 .. +1.2 across the attractor at the default distance; larger when diving.
 * - `seed`   the visit's seed as a fraction in [0, 1). Use it to give each visit its own cast.
 * - returns  LINEAR RGB. Its magnitude is the particle's relative brightness (about 0 - 1.5); how
 *            bright a pixel ends up is decided by the density of particles, not by this value.
 *            Colours are averaged per pixel weighted by particle count, so keep hue coherent
 *            between neighbouring speeds, otherwise dense regions average to grey.
 *
 * Only these arguments are in scope. Pure functions of them keep the frame deterministic.
 *
 * ## `gradeWgsl`: the finish, run once per pixel in the composite pass, before tonemapping
 *
 *     fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f
 *
 * - `hdr`   linear scene-referred RGB with exposure, bloom and vignette already applied and the
 *           background NOT yet added. Unbounded: mid-tones sit around 0.05 - 2, a point-like core
 *           can reach 50 or more. AgX follows: 0.18 lands on mid-grey, 1 is bright, ~16 is white.
 * - `uv`    0..1 across the frame, origin top-left, not aspect-corrected.
 * - `time`  seconds of simulation time, wrapping at 1000.
 * - returns LINEAR RGB, same scale. Typical jobs: tint the shadows, split-tone, saturate, desaturate
 *           highlights, add a slow colour drift. Returning `hdr` unchanged is a valid grade.
 *
 * Only these arguments are in scope; helper functions must have variant-specific names.
 */
export interface VariantRender {
  /** Scene-referred gain before the tonemap. ~3.5 suits the reference. */
  exposure: number;
  /** Trail persistence 0..0.95: weight of the previous frame in the running average. */
  trail: number;
  /** Depth-of-field aperture multiplier; 1 = reference, 0 = pin sharp. */
  dof: number;
  /** Bloom halo strength; 0 = none, ~1 is a clear glow around bright cores. */
  bloom: number;
  /** Film grain amplitude in display units; ~0.01 is barely visible. */
  grain: number;
  /** Chromatic aberration at the frame corners as a fraction of the frame; ~0.004 is a whisper. */
  aberration: number;
  /** The void, as sRGB-encoded 0..1 (like a CSS colour). Also tints the page background. */
  background: [number, number, number];
}

export interface Variant {
  id: string;
  /** Short display name, shown in the start screen's row of variants. */
  name: string;
  tagline: string;
  shadeWgsl: string;
  gradeWgsl: string;
  render: VariantRender;
  /** Preset ids: 0 default, 1 ink, 2 prism, 3 abyss. */
  sound: { preset: number; rootHz: number };
  /** CSS colour for HUD and map accents. */
  hud: { accent: string };
}
