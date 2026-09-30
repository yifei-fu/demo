// The palette. One function so a variant can replace it (DESIGN §6).
//   speed: world units per second, phase: per-particle value in [0,1),
//   depth: signed distance from the focal plane in world units (+ = farther away).
// Returns linear colour; its magnitude only sets relative brightness, the density does the rest.
fn shade(speed: f32, phase: f32, depth: f32) -> vec3f {
  let s = clamp(speed / 0.8, 0.0, 1.6);
  // slow = deep violet-blue, quickening through cyan and mint to warm gold and rose
  let t = 0.02 + 0.42 * s + 0.05 * (phase - 0.5) + F.tint.x;
  var c = 0.5 + 0.5 * cos(6.28318 * (vec3f(1.0, 1.0, 1.0) * t + vec3f(0.62, 0.78, 0.90)));
  c = pow(c, vec3f(1.6));
  // distance fades gently into the dark, nearer light is a touch brighter
  let fade = exp(-0.30 * max(depth, 0.0)) * (1.0 + 0.25 * clamp(-depth, 0.0, 1.0));
  return c * fade;
}
