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

// The glint: a stone catches light in rays. Eight thin rays, four long and four short, radiate from
// the middle of the frame, where the resting point sits, and they draw only over light that is already
// bright, so nothing appears where nothing burns. `q` is in pixels from the centre, `h` the frame height.
fn prism_rays(q: vec2f, h: f32) -> vec2f {
  let a = abs(q);
  let along1 = max(a.x, a.y);
  let perp1 = min(a.x, a.y);
  let r = vec2f(q.x + q.y, q.x - q.y) * 0.70710678;
  let b = abs(r);
  let along2 = max(b.x, b.y);
  let perp2 = min(b.x, b.y);
  let s1 = 0.55 + 0.006 * along1;
  let s2 = 0.55 + 0.006 * along2;
  let ray1 = exp(-0.5 * perp1 * perp1 / (s1 * s1)) / (1.0 + pow(along1 / (0.07 * h), 2.0));
  let ray2 = exp(-0.5 * perp2 * perp2 / (s2 * s2)) / (1.0 + pow(along2 / (0.04 * h), 2.0));
  // energy, and how far along the nearer ray this pixel lies (for the colour of the ray)
  return vec2f(ray1 + 0.55 * ray2, select(along2, along1, ray1 >= ray2));
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
  let rays = prism_rays((uv - vec2f(0.5)) / px, 1.0 / px.y);
  let lit = smoothstep(0.12, 1.6, y1);
  let fire = mix(vec3f(1.0), prism_film(270.0 + 3.2 * rays.y), 0.75);
  // 6.67 s is exactly 150 turns of the 1000 s clock: a slow twinkle, well under 1 Hz
  let twinkle = 1.0 + 0.14 * sin(6.2831853 * time / 6.666667);
  c += fire * rays.x * lit * 4.2 * twinkle * sqrt(y1);
  return max(c, vec3f(0.0));
}
