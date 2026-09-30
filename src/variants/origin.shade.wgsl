// origin: one light, split as through a prism and kept restrained. Slow light is sapphire, quickening
// through sky and ice-lilac to pearl, gold and rose. Speed is read on a log scale so a filament
// drifts through the range as it accelerates and slows along its length.
fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 5.2, 0.0, 1.0);
  let t = clamp(s + 0.04 * (phase - 0.5) - 0.05 * clamp(depth, -1.0, 1.0) + (seed - 0.5) * 0.10, 0.0, 1.0);
  var c = vec3f(0.18, 0.30, 1.00);
  c = mix(c, vec3f(0.35, 0.75, 1.00), smoothstep(0.00, 0.32, t));
  c = mix(c, vec3f(0.80, 0.85, 1.00), smoothstep(0.30, 0.52, t));
  c = mix(c, vec3f(1.00, 0.84, 0.86), smoothstep(0.50, 0.72, t));
  c = mix(c, vec3f(1.00, 0.72, 0.48), smoothstep(0.70, 0.90, t));
  c = mix(c, vec3f(1.00, 0.52, 0.62), smoothstep(0.88, 1.00, t));
  // distance fades gently into the dark, nearer light is a touch brighter
  let fade = exp(-0.30 * max(depth, 0.0)) * (1.0 + 0.25 * clamp(-depth, 0.0, 1.0));
  return c * fade;
}
