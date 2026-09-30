// origin: one light. Slow light is ice-white, quickening through azure and violet to rose and gold.
fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let t = clamp(speed / (speed + 1.6) + 0.06 * (phase - 0.5) - 0.08 * clamp(depth, -1.0, 1.0) + (seed - 0.5) * 0.16, 0.0, 1.0);
  var c = vec3f(0.55, 0.78, 1.00);
  c = mix(c, vec3f(0.05, 0.30, 1.00), smoothstep(0.00, 0.28, t));
  c = mix(c, vec3f(0.40, 0.10, 0.95), smoothstep(0.24, 0.52, t));
  c = mix(c, vec3f(1.00, 0.10, 0.46), smoothstep(0.48, 0.76, t));
  c = mix(c, vec3f(1.00, 0.58, 0.10), smoothstep(0.72, 1.00, t));
  // distance fades gently into the dark, nearer light is a touch brighter
  let fade = exp(-0.30 * max(depth, 0.0)) * (1.0 + 0.25 * clamp(-depth, 0.0, 1.0));
  return c * fade;
}
