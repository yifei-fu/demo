// abyss: plankton light. Speed walks one narrow hue arc, deep blue -> azure -> cyan -> turquoise ->
// mint, so neighbouring speeds average to a colour that is still on the arc (never grey). Slow
// light sinks into the dark; fast light burns. One particle in thirty-odd is a spark: violet when
// slow, magenta when quick, a jellyfish pulse in a sea of teal. Far light loses red then green
// first, as it does under water, so depth is read as a slide toward blue.
fn abyss_ramp(t: f32) -> vec3f {
  var c = vec3f(0.004, 0.028, 0.30) * 0.42;
  c = mix(c, vec3f(0.006, 0.10, 0.62) * 0.62, smoothstep(0.00, 0.30, t));
  c = mix(c, vec3f(0.010, 0.44, 0.90) * 0.85, smoothstep(0.26, 0.55, t));
  c = mix(c, vec3f(0.036, 0.89, 0.63) * 1.05, smoothstep(0.50, 0.80, t));
  c = mix(c, vec3f(0.30, 1.00, 0.86) * 1.10, smoothstep(0.78, 1.00, t));
  return c;
}

fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.03) / 0.07) / 4.4, 0.0, 1.0);
  var c = vec3f(0.0);
  if (phase < 0.03) {
    // jellyfish spark: each visit leans a little further toward violet or toward magenta
    let lean = fract(seed * 7.13);
    let hot = clamp(s * 0.9 + 0.5 * (lean - 0.5) + (phase / 0.03 - 0.5) * 0.2, 0.0, 1.0);
    c = mix(vec3f(0.34, 0.06, 1.00), vec3f(1.00, 0.07, 0.62), smoothstep(0.15, 0.85, hot)) * 2.6;
  } else {
    let jitter = (phase - 0.5) * 0.10 + (seed - 0.5) * 0.06;
    c = abyss_ramp(clamp(s + jitter, 0.0, 1.0));
  }
  // water eats red, then green: far light slides toward blue and dims, near light is a touch keener
  let far = max(depth, 0.0);
  let keep = exp(-vec3f(0.55, 0.26, 0.09) * far);
  return c * keep * (1.0 + 0.25 * clamp(-depth, 0.0, 1.0));
}
