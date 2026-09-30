// abyss: tissue that makes its own light. Speed walks one narrow hue arc, ultramarine -> azure ->
// cyan -> sea-green -> mint, so neighbouring speeds average to a colour still on the arc (never grey).
// Slow light sinks into the dark, fast light burns. Depth is the volume: near tissue is bright, green
// and defined, far tissue is dim and blue, as water eats red then green with distance. Rare sparks
// (3 %) swim violet to magenta and only burn while they move; another 2 % are pale marine snow.
fn abyss_ramp(t: f32) -> vec3f {
  var c = vec3f(0.002, 0.030, 0.30) * 0.38;                                     // drifting: ultramarine
  c = mix(c, vec3f(0.004, 0.30, 0.70) * 0.70, smoothstep(0.00, 0.14, t));       // cobalt
  c = mix(c, vec3f(0.008, 0.62, 0.84) * 0.90, smoothstep(0.10, 0.30, t));       // cyan
  c = mix(c, vec3f(0.030, 0.95, 0.56) * 1.08, smoothstep(0.26, 0.50, t));       // sea-green
  c = mix(c, vec3f(0.16, 1.00, 0.74) * 1.14, smoothstep(0.46, 0.72, t));        // mint
  c = mix(c, vec3f(0.30, 0.86, 1.00) * 1.18, smoothstep(0.70, 1.00, t));        // stirred: ice
  return c;
}

fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.03) / 0.06) / 5.9, 0.0, 1.0);
  // 0 for tissue at the far side of the attractor, 1 for the near side
  let near = smoothstep(1.0, -1.0, depth);
  // far light loses red then green (blue survives); near light is keen and green-cyan
  let tint = mix(vec3f(0.76, 0.88, 1.00), vec3f(1.00, 1.05, 0.94), near);
  let level = mix(0.24, 1.40, near) * (1.0 + 0.25 * clamp(-depth - 1.0, 0.0, 1.0));

  var c = vec3f(0.0);
  if (phase < 0.03) {
    // jellyfish spark: each visit leans a little further toward violet or toward magenta. A spark
    // only really shines while it swims; at rest it is as dim as the plankton around it, so the
    // dense slow cores do not pick up a lilac cast. Sparks keep more of their light when far.
    let lean = fract(seed * 7.13);
    let hot = clamp(s * 1.3 + 0.5 * (lean - 0.5) + (phase / 0.03 - 0.5) * 0.2, 0.0, 1.0);
    c = mix(vec3f(0.30, 0.04, 1.00), vec3f(1.00, 0.05, 0.60), smoothstep(0.15, 0.85, hot));
    c *= mix(0.5, 4.6, smoothstep(0.10, 0.45, s)) * mix(0.6, 1.0, near);
    return c;
  }
  if (phase < 0.05) {
    // marine snow: pale flecks that only shine because the living things around them do
    return vec3f(0.72, 0.92, 0.86) * 0.95 * level * mix(0.55, 1.0, near);
  }
  let jitter = (phase - 0.5) * 0.08 + (seed - 0.5) * 0.05;
  c = abyss_ramp(clamp(s + jitter, 0.0, 1.0));
  // a particle all but at rest is the nucleus of the thing: it burns cyan, not the blue of slow drift
  c = mix(c, vec3f(0.02, 0.62, 0.74), (1.0 - smoothstep(0.03, 0.12, speed)) * 0.9);
  return c * tint * level;
}
