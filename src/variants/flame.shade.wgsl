// flame: the heat of chaos. One continuous heat path in the warm family, so that neighbouring speeds
// average to a colour on the same path instead of to grey: oxblood, crimson, vermilion, amber, white-gold.
fn flame_heat(t: f32) -> vec3f {
  var c = vec3f(0.34, 0.010, 0.010);
  c = mix(c, vec3f(0.92, 0.028, 0.020), smoothstep(0.00, 0.22, t));
  c = mix(c, vec3f(1.45, 0.130, 0.022), smoothstep(0.18, 0.44, t));
  c = mix(c, vec3f(1.70, 0.470, 0.040), smoothstep(0.40, 0.66, t));
  c = mix(c, vec3f(1.75, 0.900, 0.180), smoothstep(0.62, 0.86, t));
  c = mix(c, vec3f(1.65, 1.200, 0.500), smoothstep(0.82, 1.00, t));
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
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 4.9, 0.0, 1.0);
  // speed contrast: the middle of the range is stretched, so within one attractor the slow parts smoulder
  // in crimson and the fast ones burn gold, instead of everything being one orange
  // In volume-filling chaos (D above about 2.4) the cloud is pushed harder toward embers and ash:
  // hotter, sparser threads over darker voids, so it reads as fire rather than fog.
  let vol = smoothstep(2.3, 2.75, axiom_dky());
  let sv = mix(mix(s, smoothstep(0.10, 0.90, s), 0.65), smoothstep(0.28, 0.58, s), vol);
  let near = clamp(-depth, -1.2, 1.2);
  let glow = clamp(-depth, 0.0, 3.0);     // in front of the focal plane: a bokeh disc
  let far = clamp(depth, 0.0, 2.0);
  let focus = 1.0 - smoothstep(0.05, 0.7, abs(depth));  // on the focal plane a thread is crisp and hot

  // about 15% of particles are cool embers: more of them far away, fewer near, so the far side of the
  // cloud cools toward violet while the near side stays fire
  let cool = phase > 0.84 + 0.04 * (seed - 0.5) + 0.06 * clamp(near, -1.0, 1.0);
  // and about 5% are sparks: hotter and brighter, so that out of focus they become glowing discs
  let spark = select(0.0, 1.0, phase > 0.30 && phase < 0.35);

  let jitter = 0.16 * (fract(phase * 7.31) - 0.5);
  let t = clamp(sv * (1.0 - 0.25 * vol) + jitter + 0.16 * near - 0.04 * far + 0.10 * focus + 0.25 * spark + 0.05 * (seed - 0.5), 0.0, 1.0);
  var c = flame_heat(t);
  // slow embers stay dim so that a dense red coal is not tinted pink by them
  if (cool) { c = flame_ember(clamp(s + 0.14 * near, 0.0, 1.0), seed) * mix(0.6, 2.3, smoothstep(0.1, 0.6, s)); }

  // distant light is ash: it cools toward a violet grey, which opens dark voids behind the fire
  c = mix(c, vec3f(0.42, 0.10, 0.24), (0.3 + 0.4 * vol) * smoothstep(0.4, 1.4, far));

  // speed sets the burn: slow pile-ups smoulder, fast threads run hot
  let burn = mix(0.55 - 0.25 * vol, 1.9 + 0.7 * vol, sv);
  // a particle that has come to rest has burned down into the one point: it ignites, and as the
  // point opens into a loop (Hopf) the star cools through orange to the crimson of a slow coal
  let star = 1.0 - smoothstep(0.02, 0.12, speed);
  c = mix(c, vec3f(1.7, 0.90, 0.33), star);

  // near light glows, far light fades
  // every ember glints a little differently, so out-of-focus discs are not one flat speckle
  let glint = mix(0.6, 0.3, vol) + mix(0.8, 1.6, vol) * fract(phase * 13.7);
  let depth_gain = exp(-0.25 * far) * (1.0 + 0.5 * glow) * (1.0 + (1.6 + 1.4 * vol) * spark) * glint;
  return c * mix(burn, 1.0, star) * depth_gain;
}
