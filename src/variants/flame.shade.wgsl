// flame: the heat of chaos. One continuous heat path in the warm family, so that neighbouring speeds
// average to a colour on the same path instead of to grey: oxblood, crimson, vermilion, amber, white-gold.
fn flame_heat(t: f32) -> vec3f {
  var c = vec3f(0.34, 0.008, 0.016);
  c = mix(c, vec3f(0.90, 0.020, 0.030), smoothstep(0.00, 0.22, t));
  c = mix(c, vec3f(1.45, 0.130, 0.025), smoothstep(0.18, 0.44, t));
  c = mix(c, vec3f(1.70, 0.470, 0.040), smoothstep(0.40, 0.66, t));
  c = mix(c, vec3f(1.75, 0.900, 0.180), smoothstep(0.62, 0.86, t));
  c = mix(c, vec3f(1.65, 1.200, 0.600), smoothstep(0.82, 1.00, t));
  return c;
}

// The cool family: indigo embers that brighten to orchid, leaning to magenta so they blend with the
// crimson side of the fire instead of against it.
fn flame_ember(t: f32, tint: f32) -> vec3f {
  var c = vec3f(0.14, 0.020, 0.50);
  c = mix(c, vec3f(0.55, 0.070, 1.00), smoothstep(0.00, 0.45, t));
  c = mix(c, vec3f(1.10, 0.300, 1.10), smoothstep(0.40, 1.00, t));
  return mix(c, c.zyx * vec3f(1.2, 0.6, 0.85), 0.25 * tint);
}

fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.07) / 4.6, 0.0, 1.0);
  let near = clamp(-depth, -1.2, 1.2);
  let cool = phase > 0.85 + 0.04 * (seed - 0.5);
  let jitter = 0.05 * (fract(phase * 7.31) - 0.5);
  let t = clamp(s + jitter + 0.09 * near + 0.05 * (seed - 0.5), 0.0, 1.0);
  var c = flame_heat(t);
  if (cool) { c = flame_ember(clamp(s + 0.09 * near, 0.0, 1.0), seed) * 1.6; }
  // a particle that has come to rest has burned down into the one point: it ignites, and as the
  // point opens into a loop (Hopf) the star cools through orange to the crimson of a slow coal
  let star = 1.0 - smoothstep(0.02, 0.12, speed);
  c = mix(c, vec3f(1.70, 1.25, 0.70), star);
  let fade = exp(-0.35 * max(depth, 0.0)) * (1.0 + 0.30 * clamp(-depth, 0.0, 1.0));
  return c * fade;
}
