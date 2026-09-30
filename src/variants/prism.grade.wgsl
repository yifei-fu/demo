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

fn prism_film(thickness: f32) -> vec3f {
  let d = thickness + 60.0 * smoothstep(462.0, 492.0, thickness);  // skips the acid greens, as in shade
  let x = 2.66 * d * 0.001;
  var xyz = PRISM_AMP * cos(PRISM_PHASE * x) * exp(-PRISM_DECAY * x * x);
  xyz.x += 0.15387 * cos(14.0737 * x) * exp(-0.17877 * x * x);
  return max(vec3f(1.0) - PRISM_XYZ_TO_RGB * xyz / PRISM_WHITE, vec3f(0.0));
}

// The glint: light entering glass splits by wavelength. A hairline cross, no longer than a thumb-nail,
// leaves the middle of the frame, where the resting point sits, white at the core and then blue,
// green and red one after another as the ray disperses, inside a thin spectral ring. It draws only
// over light that is already bright, so nothing appears where nothing burns. `q` is in pixels from
// the centre and `h` the frame height.
fn prism_glint(q: vec2f, h: f32) -> vec3f {
  let a = abs(q);
  let along = max(a.x, a.y);
  let perp = min(a.x, a.y);
  let len = 0.036 * h;
  let hair = exp(-0.5 * perp * perp / 0.25);
  let lobe = vec3f(0.45, 0.68, 0.92) * len;   // where blue, green and red peak along the ray
  let spread = 0.13 * len;
  let split = exp(-0.5 * pow((vec3f(along) - lobe) / spread, vec3f(2.0)));
  let base = exp(-along / (0.16 * len));
  let ray = hair * (vec3f(base) + 0.8 * split * exp(-along / (0.9 * len)));
  // the ring: each colour turns at a slightly different radius
  let rho = length(q);
  let radii = vec3f(0.0085, 0.0095, 0.0106) * h;
  let ring = 0.45 * exp(-0.5 * pow((vec3f(rho) - radii) / 0.6, vec3f(2.0)));
  return ray + ring;
}

fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  var c = hdr;
  let y0 = prism_lum(c);
  // crisp: a gentle S about mid-grey in linear light
  c = 0.18 * pow(max(c, vec3f(0.0)) / 0.18, vec3f(1.08));
  // cool the shadows
  let shadow = 1.0 - smoothstep(0.01, 0.25, y0);
  c = mix(c, c * vec3f(0.92, 0.96, 1.14), shadow * 0.6);
  // pastel film keeps its chroma through AgX
  let y1 = prism_lum(c);
  c = max(mix(vec3f(y1), c, 1.22), vec3f(0.0));
  // Highlights: an iridescent white. The film thins toward the brightest light; the tint drifts
  // slowly across the frame (25 s is exactly 40 turns of the 1000 s clock).
  let octaves = 5.0 - log2(max(y1, 0.5));
  let d = 270.0 + 62.0 * clamp(octaves, 0.0, 6.0) + 26.0 * uv.x + 16.0 * uv.y + 20.0 * sin(6.2831853 * time / 25.0);
  let veil = mix(vec3f(1.0), prism_film(d), 0.6);
  let hi = smoothstep(0.35, 4.0, y1);
  c = mix(c, veil * (y1 + 0.5 * hi), hi * 0.85);
  // the glint
  let px = max(vec2f(abs(dpdx(uv.x)), abs(dpdy(uv.y))), vec2f(1e-6));
  let lit = smoothstep(0.1, 1.6, y1);
  // 6.67 s is exactly 150 turns of the 1000 s clock: a slow breath, well under 1 Hz
  let breath = 1.0 + 0.06 * sin(6.2831853 * time / 6.666667);
  c += prism_glint((uv - vec2f(0.5)) / px, 1.0 / px.y) * lit * 4.6 * breath * sqrt(y1);
  return max(c, vec3f(0.0));
}
