// prism: thin-film interference, the colour of a soap bubble. A particle is a speck of film whose
// thickness follows its speed (log), depth and phase; the colour is the Newton series the physics
// gives for an optical path of 2 n d, n = 1.33. Neighbouring thicknesses give neighbouring hues, and
// the series is complementary by construction (its mean over a period is white), so dense regions
// where many thicknesses overlap average to pearl rather than to grey.

// Spectral reflectance of a two-beam film, integrated against the CIE 1931 curves in the Fourier
// domain (Belcour and Barla, 2017: the curves as Gaussian-windowed cosines). x is the optical path
// in micrometres. Each lobe is amplitude * cos(phase * x) * exp(-decay * x^2).
const PRISM_AMP: vec3f = vec3f(0.84659, 1.0002, 1.0011);
const PRISM_PHASE: vec3f = vec3f(10.562, 11.2802, 13.8758);
const PRISM_DECAY: vec3f = vec3f(0.17085, 0.36733, 0.26104);
const PRISM_XYZ_TO_RGB: mat3x3f = mat3x3f(
  vec3f(3.2406, -0.9689, 0.0557),
  vec3f(-1.5372, 1.8758, -0.2040),
  vec3f(-0.4986, 0.0415, 1.0570),
);
// What a flat spectrum integrates to (x = 0): dividing by it makes the film's mean colour white.
const PRISM_WHITE: vec3f = vec3f(1.2054, 0.9484, 0.9099);
const PRISM_IOR: f32 = 1.33;

fn prism_fringe(x: f32) -> vec3f {
  var xyz = PRISM_AMP * cos(PRISM_PHASE * x) * exp(-PRISM_DECAY * x * x);
  xyz.x += 0.15387 * cos(14.0737 * x) * exp(-0.17877 * x * x);
  return PRISM_XYZ_TO_RGB * xyz;
}

// Linear colour of a film `d` nanometres thick, seen face-on. Mean 1 per channel over a period.
fn prism_film(thickness: f32) -> vec3f {
  // Skip the acid greens: past 460 nm the lookup jumps 60 nm ahead, so green is a quick transition
  // between aqua and rose instead of a broad field.
  let d = thickness + 60.0 * smoothstep(462.0, 492.0, thickness);
  let r = vec3f(1.0) - prism_fringe(2.0 * PRISM_IOR * d * 0.001) / PRISM_WHITE;
  return max(r, vec3f(0.0));
}

fn prism_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// The engine gives light still falling toward the attractor one calm reference speed (0.45), so a
// speed that sits exactly there marks a newcomer. It is dim, and it is where the eye finds the rays.
const PRISM_FALLING: f32 = 0.45;

fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 5.2, 0.0, 1.0);
  let z = clamp(depth, -1.0, 1.0);
  // Settled light, about 190 - 700 nm: a colour cycle every ~200. Slow light is a thin ice-white
  // film (the glint of the resting point); speed walks a filament through gold, coral, rose, violet
  // and aqua; near light is thin and vivid, far light thick and pale, which is atmospheric
  // perspective for free, and turning the phone slides every hue along the depth.
  let settled_d = 275.0 + 300.0 * s + 50.0 * z + 40.0 * min(z, 0.0) + 24.0 * (phase - 0.5) + 60.0 * (seed - 0.5);
  // Falling light is split as by a prism: each newcomer keeps one hue of its own across a full cycle,
  // so the streams fan out as a spectrum and the faint haze between them averages to pearl.
  let falling_d = 250.0 + 360.0 * phase + 60.0 * (seed - 0.5);
  let fresh = 1.0 - smoothstep(0.0, 0.02, abs(speed - PRISM_FALLING));
  var c = prism_film(clamp(mix(settled_d, falling_d, fresh), 190.0, 900.0));
  // pastel: a veil of white, then even out the luminance so no hue is a dark gap in a filament
  c = mix(vec3f(1.0), c, 0.6);
  c = c / mix(1.0, max(prism_luma(c), 0.3), 0.65);
  // keep the palette to pearl, not acid: greens lean to mint and aqua, yellows to peach and cream
  c += max(c.g - 0.5 * (c.r + c.b), 0.0) * vec3f(-0.25, -0.04, 0.38);
  c += max(min(c.r, c.g) - c.b, 0.0) * vec3f(0.38, -0.12, 0.12);
  // glitter: a few grains catch the light
  let glint = 1.0 + 0.7 * smoothstep(0.985, 1.0, phase);
  // defocused near light spreads thin, so it is lifted to keep its bokeh disc visible
  let lift = 1.0 + 0.7 * clamp(-depth, 0.0, 1.0);
  let haze = 1.0 - 0.25 * clamp(depth, 0.0, 1.2);
  return c * lift * haze * glint;
}
