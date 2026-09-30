// ink: a particle does not carry light here, it carries sumi. The magnitude is how much pigment it
// lays down; the three channels are absorption weights (a larger channel swallows more of that
// colour of the paper). Hue stays coherent between neighbouring speeds so every mixture remains
// inside one family of blue-black and brown-black inks. grade() turns the accumulated load into
// ink on washi.
//
//   slow  -> the brush is loaded and slow: warm and generous (blue is absorbed a little more)
//   quick -> the brush is fast: bluer and darker
//   near  -> heavy ink; far -> aerial perspective, the distance washes out as in a scroll
fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 5.2, 0.0, 1.0);
  let q = smoothstep(0.15, 0.85, s);

  // the visit's own soot: some inks lean brown (pine soot), some blue (oil soot)
  let soot = (seed - 0.5) * 0.06;
  let slow = vec3f(0.96 - soot, 1.00, 1.06 + soot);
  let quick = vec3f(1.06 - soot, 1.00, 0.94 + soot);
  let tint = mix(slow, quick, q);

  let near = clamp(-depth, 0.0, 1.2);
  let far = clamp(depth, 0.0, 2.0);
  let load = (0.84 + 0.30 * q + 0.08 * (phase - 0.5)) * exp(-0.55 * far) * (1.0 + 0.30 * near);
  return tint * load;
}
