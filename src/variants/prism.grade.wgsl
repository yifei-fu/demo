// prism: the finish of glass. Contrast is crisp, shadows are cool, and the highlights lift toward an
// iridescent white: bright light passes through the same thin-film series as the particles, thin at the
// core (ice white) and thickening outward through gold, rose and violet, like the fire in a cut stone.
// Thin-film maths as in prism.shade.wgsl (Belcour and Barla, 2017), here for the bright end only.
const PRISM_AMP: vec3f = vec3f(0.84659, 1.0002, 1.0011);
const PRISM_PHASE: vec3f = vec3f(10.562, 11.2802, 13.8758);
const PRISM_DECAY: vec3f = vec3f(0.17085, 0.36733, 0.26104);
const PRISM_XYZ_TO_RGB: mat3x3f = mat3x3f(
  vec3f(3.2406, -0.9689, 0.0557),
  vec3f(-1.5372, 1.8758, -0.2040),
  vec3f(-0.4986, 0.0415, 1.0570),
);
const PRISM_WHITE: vec3f = vec3f(1.2054, 0.9484, 0.9099);

fn prism_lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn prism_film(d: f32) -> vec3f {
  let x = 2.66 * d * 0.001;
  var xyz = PRISM_AMP * cos(PRISM_PHASE * x) * exp(-PRISM_DECAY * x * x);
  xyz.x += 0.15387 * cos(14.0737 * x) * exp(-0.17877 * x * x);
  return max(vec3f(1.0) - PRISM_XYZ_TO_RGB * xyz / PRISM_WHITE, vec3f(0.0));
}

fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  var c = hdr;
  let y0 = prism_lum(c);
  // crisp: a gentle S about mid-grey in linear light
  c = 0.18 * pow(max(c, vec3f(0.0)) / 0.18, vec3f(1.08));
  // cool the shadows
  let shadow = 1.0 - smoothstep(0.02, 0.4, y0);
  c = mix(c, c * vec3f(0.86, 0.92, 1.24), shadow * 0.65);
  // pastel film keeps its chroma through AgX
  let y1 = prism_lum(c);
  c = max(mix(vec3f(y1), c, 1.22), vec3f(0.0));
  // Highlights: an iridescent white. The film thins toward the brightest light; the tint drifts
  // slowly across the frame (50 s is exactly 20 turns of the 1000 s clock).
  let octaves = 5.0 - log2(max(y1, 0.5));
  let d = 270.0 + 85.0 * clamp(octaves, 0.0, 6.0) + 26.0 * uv.x + 16.0 * uv.y + 8.0 * sin(6.2831853 * time / 50.0);
  let veil = mix(vec3f(1.0), prism_film(d), 0.85);
  let hi = smoothstep(0.35, 4.0, y1);
  c = mix(c, veil * (y1 + 0.5 * hi), hi * 0.85);
  return max(c, vec3f(0.0));
}
