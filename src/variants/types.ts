/**
 * A variant is an art direction for the same piece: same law, same navigation, same gestures.
 * It differs in light, colour, finish and sound. A variant is exactly three files and touches
 * nothing else (the registry discovers it by file name):
 *
 *     src/variants/<id>.ts            exports `variant: Variant` (numbers + the two imports below)
 *     src/variants/<id>.shade.wgsl    the particle colour function
 *     src/variants/<id>.grade.wgsl    the finish function
 *
 * Everything else (integration, splatting, density curve, trails, bloom, tonemap, HDR output)
 * belongs to the engine and is shared. See `origin.ts` for a complete example.
 *
 * ## `shadeWgsl`: particle colour, run once per particle per frame inside the compute kernel
 *
 *     fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f
 *
 * - `speed`  world units per second of the particle's velocity, including stir and shake.
 *            On an attractor it is roughly 0.1 - 1.5 (fast laws median ~0.7, slow ones ~0.15); a
 *            stirred or shaken particle can reach 4 or more. It makes filaments change hue along
 *            their length. A log scale suits it: origin uses log2(speed / 0.08) / 5.2.
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
 * Newly born particles are dimmed and given a calm reference speed by the engine while they fall
 * toward the attractor, so `shade` only ever describes settled light.
 * Only these arguments are in scope. Pure functions of them keep the frame deterministic.
 *
 * ## `gradeWgsl`: the finish, run once per pixel in the composite pass
 *
 *     fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f
 *
 * - `hdr`   linear scene-referred light, with exposure, bloom, chromatic aberration and vignette
 *           already applied and no background. Zero where nothing is drawn. Unbounded: filaments
 *           sit around 0.05 - 3, a point-like core can reach 50 or more.
 * - `uv`    0..1 across the frame, origin top-left, not aspect-corrected.
 * - `time`  seconds of simulation time, wrapping at 1000.
 * - returns depends on `render.finish`:
 *   - `'agx'` (default): scene-referred linear RGB on the same scale as `hdr`. The engine then adds
 *     the background, applies AgX (0.18 lands on mid-grey, 1 is bright, ~16 is white), adds grain
 *     and dither, and encodes for the display. Typical jobs: tint the shadows, split-tone,
 *     saturate, desaturate highlights. Returning `hdr` unchanged is a valid grade.
 *   - `'direct'`: the FINAL DISPLAY-LINEAR colour, background included. The engine adds no
 *     background and applies no tonemap: it only adds grain and dither, then encodes to sRGB.
 *     Use it for looks a tonemap would ruin, e.g. absorptive ink on paper:
 *
 *         fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
 *           return vec3f(0.93, 0.91, 0.86) * exp(-vec3f(1.4, 1.5, 1.3) * hdr);
 *         }
 *
 *     Values in 0..1 are ordinary SDR. On an HDR display a value above 1 (up to ~1.7) is shown
 *     brighter than paper white, so a direct look opts into HDR highlights by exceeding 1 and is
 *     otherwise unaffected by the headroom. The output is clamped to [0, headroom].
 *
 * Only these arguments are in scope; helper functions must have variant-specific names.
 *
 * ## Light variants
 *
 * A variant on a light ground sets `render.finish: 'direct'`, `render.background` to the paper
 * colour (sRGB 0..1, it themes the page behind the canvas, the gate and the fallback screen) and
 * `hud.theme: 'light'`, which switches the HUD, gate, variant row, mute icon, readout and the
 * parameter map to dark-on-light. `hud.accent` should then be a colour that reads on paper.
 */
export type VariantFinish = 'agx' | 'direct';
export type HudTheme = 'dark' | 'light';

export interface VariantRender {
  /** Scene-referred gain before the finish. origin uses 5. */
  exposure: number;
  /** Trail persistence 0..0.95: weight of the previous frame in the running average. */
  trail: number;
  /** Depth-of-field aperture multiplier; 1 = reference, 0 = pin sharp. */
  dof: number;
  /**
   * Bloom amount. Only light brighter than the engine's threshold feeds it (a point-like core, a
   * dense bright sheet), so useful values are large: origin uses 12; 0 disables bloom.
   */
  bloom: number;
  /** Film grain amplitude in display units; ~0.01 is barely visible. */
  grain: number;
  /** Chromatic aberration at the frame corners as a fraction of the frame; ~0.004 is a whisper. */
  aberration: number;
  /** `'agx'` (default look: background + AgX) or `'direct'` (grade() is the final colour). */
  finish: VariantFinish;
  /** The void or paper, as sRGB-encoded 0..1 (like a CSS colour). Themes the page and the gate. */
  background: [number, number, number];
}

export interface Variant {
  id: string;
  /** Position in the start screen's row of variants and the default choice: origin is 0. */
  order: number;
  /** Short display name, shown in the start screen's row of variants. */
  name: string;
  tagline: string;
  shadeWgsl: string;
  gradeWgsl: string;
  render: VariantRender;
  /** Preset ids: 0 default, 1 ink, 2 prism, 3 abyss. */
  sound: { preset: number; rootHz: number };
  /** `accent`: CSS colour for HUD and map accents. `theme`: colours of text and lines. */
  hud: { accent: string; theme: HudTheme };
}
