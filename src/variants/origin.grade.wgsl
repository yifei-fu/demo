// origin: AgX desaturates by design; push chroma out first so the palette survives it.
fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  let y = dot(hdr, vec3f(0.2126, 0.7152, 0.0722));
  return max(mix(vec3f(y), hdr, 1.75), vec3f(0.0));
}
