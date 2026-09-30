// flame: a warm filmic finish, graded to the display directly rather than through AgX. AgX pales every
// hot colour toward tan and salmon; fire needs the opposite. A per-channel curve lets the brightest
// channel saturate first, so light walks the heat path on its own: ember red, orange, gold, white.
// On top: dim light cools to ember red, a red-orange halation bleeds out of bright regions, the
// blacks stay deep and warm, and a fine warm grain sits over everything.
const FLAME_BLACK: vec3f = vec3f(0.002125, 0.001214, 0.001517);  // #070405 in linear light
const FLAME_GAIN: f32 = 2.0;                                      // with the contrast below, matches AgX on grey

fn flame_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn flame_hash(p: vec2f, t: f32) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031 + t * 0.0137);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  var c = max(hdr, vec3f(0.0));
  let y = flame_luma(c);

  // Warm pixels lose their blue: the violet embers mixed into a dense warm pixel would otherwise turn
  // it to salmon and tan. A lone ember still dominates its own pixel and keeps its colour.
  let warm = 1.0 - smoothstep(0.5, 1.0, c.b / max(c.r, 1e-4));
  c *= mix(vec3f(1.0), vec3f(1.0, 0.94, 0.30), warm);
  // dim warm light also cools to ember red rather than to brown
  let cooling = (1.0 - smoothstep(0.03, 0.45, y)) * warm;
  c *= mix(vec3f(1.0), vec3f(1.15, 0.66, 0.52), cooling);
  // haze recedes, so that dark voids open between the bright threads
  c *= mix(0.72, 1.0, smoothstep(0.02, 0.4, y));

  // heat: a lot of light leans toward gold whatever its hue, so the single point is a star
  let heat = smoothstep(0.5, 9.0, y);
  let ember = mix(vec3f(1.0, 0.54, 0.16), vec3f(1.0, 0.70, 0.32), smoothstep(3.0, 40.0, y));
  c = mix(c, ember * y, heat * 0.7);

  // halation: red-orange bleed as a function of luminance, since a grade cannot blur
  let bleed = 0.16 * y / (1.0 + 0.12 * y) * smoothstep(0.25, 2.0, y);
  c += vec3f(1.0, 0.30, 0.07) * bleed;

  // the frame burns down toward ember red at the edges
  let d = uv - 0.5;
  let edge = smoothstep(0.30, 1.10, dot(d, d) * 2.0);
  c *= vec3f(1.0 - 0.06 * edge, 1.0 - 0.20 * edge, 1.0 - 0.34 * edge);

  // fine warm grain, strongest in the mid-tones
  let g = flame_hash(uv * vec2f(1024.0, 1024.0), floor(time * 8.0)) - 0.5;
  c *= 1.0 + 0.04 * g * vec3f(1.0, 0.8, 0.6) * smoothstep(0.02, 0.5, y);

  // filmic curve, per channel
  let k = FLAME_GAIN * c;
  var o = pow(k / (1.0 + k), vec3f(1.25));
  // the true core runs past white: a HDR display shows it brighter, an SDR one clamps
  o += vec3f(1.0, 0.86, 0.62) * 0.5 * smoothstep(8.0, 50.0, y);
  return o + FLAME_BLACK;
}
