// origin: split-tone the finish. Shadows lean cool and deep, highlights lean warm, so thin light
// reads blue rather than brown, and chroma is pushed out ahead of AgX, which desaturates by design.
fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  let y = luma(hdr);
  let shadow = 1.0 - smoothstep(0.02, 0.35, y);
  let light = smoothstep(0.4, 3.0, y);
  var c = hdr;
  c = mix(c, c * vec3f(0.80, 0.95, 1.25), shadow * 0.6);
  c = mix(c, c * vec3f(1.12, 1.00, 0.86), light * 0.5);
  return max(mix(vec3f(luma(c)), c, 1.3), vec3f(0.0));
}
