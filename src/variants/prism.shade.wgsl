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
  // Skip the acid bands: the lookup jumps 30 nm ahead across the lime near 300 nm and 60 nm across
  // the green near 470 nm, so both are quick transitions (cream to gold, aqua to rose) instead of
  // broad fields of khaki or green.
  let lime = thickness + 30.0 * smoothstep(283.0, 308.0, thickness);
  let d = lime + 60.0 * smoothstep(462.0, 492.0, lime);
  let r = vec3f(1.0) - prism_fringe(2.0 * PRISM_IOR * d * 0.001) / PRISM_WHITE;
  return max(r, vec3f(0.0));
}

fn prism_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// The engine shades light still falling toward the attractor at one calm reference speed
// (REFERENCE_SPEED, documented as stable), so a speed that sits exactly there marks a newcomer.
// It is dim, and it is where the eye finds the rays.
const PRISM_FALLING: f32 = 0.45;

fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 5.2, 0.0, 1.0);
  let z = clamp(depth, -1.0, 1.0);
  // Settled light, about 190 - 600 nm: ice-white through cream, gold, coral, rose, lilac and sky, a
  // full cycle or more, so speed shimmers along a filament. Slow light is a thin ice film (the
  // resting point). Near light is thin, far light thick and pale, which is atmospheric perspective
  // for free; the attractor spans about one cycle in depth, so every line of sight through a dense
  // volume adds up to pearl, and turning the phone slides hue along the depth.
  // In volume-filling chaos every hue along a line of sight would add up to dim grey, so there the
  // depth term relaxes, the palette slides warm (fast light would otherwise sit in blue and teal) and
  // the light brightens a little: a rose-cream pearl, not a grey or teal fog.
  let volume = smoothstep(2.3, 2.7, axiom_dky());
  let focused_d = 250.0 - 85.0 * volume + 260.0 * s + (105.0 - 50.0 * volume) * z + 30.0 * min(z, 0.0) + 36.0 * (seed - 0.5);
  // Far from the focal plane (the dive) light drifts to a warm pearl, cream to rose, and stops
  // changing hue with speed, so bokeh discs are soft and pearly rather than striped or violet.
  let defocus = smoothstep(0.7, 1.8, abs(depth));
  let pearl_d = 308.0 + 50.0 * s;
  let settled_d = mix(focused_d, pearl_d, 0.7 * defocus) + 12.0 * (phase - 0.5);
  // Falling light is split as by a prism: each newcomer keeps one hue of its own across a full cycle,
  // so the streams fan out as a spectrum and the faint haze between them averages to pearl. Out of
  // focus, where hairlines are only soft bokeh, they settle to the same pearl instead of confetti.
  let falling_d = mix(250.0 + 360.0 * phase + 36.0 * (seed - 0.5), pearl_d + 40.0 * (phase - 0.5), 0.8 * defocus);
  let fresh = 1.0 - smoothstep(0.0, 0.02, abs(speed - PRISM_FALLING));
  var c = prism_film(clamp(mix(settled_d, falling_d, fresh), 190.0, 900.0));
  // Pastel: a veil of white, more of it the further out of focus, then equalise the luminance so no
  // hue is a dark gap in a filament.
  let veil = 0.66 - 0.2 * defocus;
  c = mix(vec3f(1.0), c, veil);
  c = c / mix(1.0, max(prism_luma(c), 0.45), 0.45);
  // keep the palette to pearl, not acid: greens lean to mint and aqua, yellows to peach and cream
  c += max(c.g - 0.5 * (c.r + c.b), 0.0) * vec3f(-0.2, -0.04, 0.22);
  c += max(min(c.r, c.g) - c.b, 0.0) * vec3f(0.38, -0.12, 0.12);
  // A veiled film's mean leans magenta (1.16, 0.88, 1.18 over the whole range). Rebalance toward a
  // warm pearl, but leave the slowest light alone: the resting point stays ice.
  c *= mix(vec3f(1.0), vec3f(0.93, 1.09, 0.88), smoothstep(0.0, 0.3, s) * (1.0 - 0.8 * defocus));
  // the haze of newcomers spans the whole spectrum, whose mean leans blue: warm it back to cream
  c *= mix(vec3f(1.0), vec3f(1.0, 1.08, 0.88), fresh);
  // at the resting point the streams are the whole show: let the falling hairlines burn brighter
  c *= 1.0 + 0.9 * axiom_still() * fresh;
  // glitter: a few grains catch the light
  let glint = 1.0 + 0.45 * smoothstep(0.985, 1.0, phase);
  // defocused near light spreads thin, so it is lifted to keep its bokeh disc visible
  let lift = 1.0 + 0.7 * clamp(-depth, 0.0, 1.0);
  let haze = 1.0 - 0.25 * clamp(depth, 0.0, 1.2);
  return c * lift * haze * glint * (1.0 + 0.3 * volume);
}
