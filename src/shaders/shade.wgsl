// The palette. One function so a variant can replace it (DESIGN §6).
//   speed: world units per second, phase: per-particle value in [0,1),
//   depth: signed distance from the focal plane in world units (+ = farther away).
// Returns linear colour; its magnitude only sets relative brightness, the density does the rest.
fn shade(speed: f32, phase: f32, depth: f32) -> vec3f {
  // slow = ice-white (the dense cores), quickening through azure, violet and rose to amber
  let t = clamp(speed / (speed + 1.6) + 0.06 * (phase - 0.5) - 0.08 * clamp(depth, -1.0, 1.0) + F.tint.x, 0.0, 1.0);
  var c = vec3f(0.55, 0.78, 1.00);
  c = mix(c, vec3f(0.05, 0.30, 1.00), smoothstep(0.00, 0.28, t));
  c = mix(c, vec3f(0.40, 0.10, 0.95), smoothstep(0.24, 0.52, t));
  c = mix(c, vec3f(1.00, 0.10, 0.46), smoothstep(0.48, 0.76, t));
  c = mix(c, vec3f(1.00, 0.58, 0.10), smoothstep(0.72, 1.00, t));
  // distance fades gently into the dark, nearer light is a touch brighter
  let fade = exp(-0.30 * max(depth, 0.0)) * (1.0 + 0.25 * clamp(-depth, 0.0, 1.0));
  return c * fade;
}
