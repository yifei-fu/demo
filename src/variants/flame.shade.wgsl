fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let l = log2(max(speed, 1e-4) / 0.01);   // 0 at 0.01, 1 per octave
  var c = vec3f(0.0, 0.0, 1.0);             // <0.02 blue
  if (l > 1.0) { c = vec3f(0.0, 1.0, 1.0); }   // 0.02-0.04 cyan
  if (l > 2.0) { c = vec3f(0.0, 1.0, 0.0); }   // 0.04-0.08 green
  if (l > 3.0) { c = vec3f(1.0, 1.0, 0.0); }   // 0.08-0.16 yellow
  if (l > 4.0) { c = vec3f(1.0, 0.4, 0.0); }   // 0.16-0.32 orange
  if (l > 5.0) { c = vec3f(1.0, 0.0, 0.0); }   // 0.32-0.64 red
  if (l > 6.0) { c = vec3f(1.0, 0.0, 1.0); }   // 0.64-1.28 magenta
  if (l > 7.0) { c = vec3f(1.0, 1.0, 1.0); }   // >1.28 white
  return c * 0.5;
}
