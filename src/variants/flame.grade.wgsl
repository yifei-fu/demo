// flame: a warm filmic finish. Energy whitens toward gold as a hot body does, dim light cools to
// ember red, a red-orange halation bleeds out of the bright regions, the blacks stay deep and warm,
// and a fine warm grain sits on top.
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

  // dim warm light cools to ember red rather than to brown; violet is left alone
  let warm = smoothstep(0.35, 0.75, c.r / max(c.r + c.g + c.b, 1e-4));
  let cooling = (1.0 - smoothstep(0.03, 1.4, y)) * warm;
  c *= mix(vec3f(1.0), vec3f(1.20, 0.66, 0.58), cooling);

  // heat: a lot of light pushes any hue toward white-gold, so the single point is a star
  let heat = smoothstep(1.0, 14.0, y);
  c = mix(c, vec3f(1.0, 0.80, 0.52) * y, heat * 0.9);

  // halation: red-orange bleed as a function of luminance, since a grade cannot blur
  let bleed = 0.16 * y / (1.0 + 0.12 * y) * smoothstep(0.25, 2.0, y);
  c += vec3f(1.0, 0.30, 0.07) * bleed;

  // saturate the mid-tones ahead of AgX, which desaturates by design
  let sat = mix(1.35, 1.0, smoothstep(0.5, 6.0, y));
  c = max(mix(vec3f(flame_luma(c)), c, sat), vec3f(0.0));

  // fine warm grain, strongest in the mid-tones
  let g = flame_hash(uv * vec2f(1024.0, 1024.0), floor(time * 8.0)) - 0.5;
  c *= 1.0 + 0.05 * g * vec3f(1.0, 0.8, 0.6) * smoothstep(0.02, 0.5, y);

  return c;
}
