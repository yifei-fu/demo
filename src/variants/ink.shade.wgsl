// ink: a particle does not carry light here, it carries sumi. The magnitude is how much pigment it
// lays down; the three channels are absorption weights (a channel that is larger swallows more of
// that colour of the paper), so hue coherence between neighbouring speeds keeps every mixture
// inside one family of blue-black and brown-black inks. grade() turns the accumulated load into
// ink on washi.
//
//   slow    -> the brush is loaded and slow: warm, generous, a little brown (blue is absorbed most)
//   quick   -> the brush is fast and dry: bluer, darker, a lighter footprint
//   near    -> heavy ink; far -> aerial perspective, the distance washes out as in a scroll
//   phase < 0.0015 -> a fleck of vermilion cinnabar. Its absorption is nearly zero in red, so on
//                    paper it leaves #c8372d-ish red; grade() recognises it by its chroma
fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.04) / 0.08) / 5.2, 0.0, 1.0);
  let q = smoothstep(0.15, 0.85, s);

  // the visit's own soot: some inks lean brown (pine soot), some blue (oil soot)
  let soot = (seed - 0.5) * 0.10;
  let slow = vec3f(0.90 - soot, 1.00, 1.12 + soot);
  let quick = vec3f(1.14 - soot, 1.00, 0.88 + soot);
  var tint = mix(slow, quick, q);

  // pigment load: quicker strokes are a touch darker in the core, distance thins the wash
  let near = clamp(-depth, 0.0, 1.2);
  let far = clamp(depth, 0.0, 2.0);
  let load = (0.80 + 0.32 * q + 0.10 * (phase - 0.5)) * exp(-0.55 * far) * (1.0 + 0.30 * near);

  // the cinnabar fleck: much brighter than ink so a single one still reads in a thin place
  let hanko = 1.0 - smoothstep(0.0012, 0.0016, phase);
  let seal = vec3f(0.12, 1.10, 1.22) * 14.0;
  return mix(tint * load, seal, hanko);
}
