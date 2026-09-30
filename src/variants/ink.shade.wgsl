// ink: a particle does not carry light here, it carries sumi. The magnitude is how much pigment it
// lays down; the three channels are absorption weights (a larger channel swallows more of that
// colour of the paper). Hue stays coherent between neighbouring speeds so every mixture remains
// inside one family of blue-black and brown-black inks. grade() turns the accumulated load into
// ink on washi.
//
//   slow  -> the brush is loaded and slow: warm and generous (blue is absorbed a little more)
//   quick -> the brush is fast: bluer and darker
//   focus -> deep ink in the focal slab; before and behind it the wash thins (wet-in-wet)
fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 5.2, 0.0, 1.0);
  let q = smoothstep(0.15, 0.85, s);

  // the visit's own soot: some inks lean brown (pine soot), some blue (oil soot)
  let soot = (seed - 0.5) * 0.06;
  let slow = vec3f(0.96 - soot, 1.00, 1.06 + soot);
  let quick = vec3f(1.06 - soot, 1.00, 0.94 + soot);
  let tint = mix(slow, quick, q);

  // the brush is loaded where the eye rests: ink in the focal slab is deep, and what lies before or
  // behind it thins to a wash (wet-in-wet). Nearer ink is allowed a little more body than far ink.
  let d = depth + 0.2;
  let slab = exp(-0.5 * d * d / select(0.32, 0.30, d > 0.0));
  let body = (0.84 + 0.30 * q + 0.08 * (phase - 0.5)) * (0.34 + 0.66 * slab);
  let load = body * (1.0 + 0.25 * clamp(-depth, 0.0, 1.2));
  return tint * load;
}
