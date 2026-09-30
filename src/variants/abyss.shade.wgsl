// abyss: plankton light. Speed walks one narrow hue arc, deep blue -> azure -> cyan -> turquoise ->
// mint, so neighbouring speeds average to a colour that is still on the arc (never grey). Slow
// light sinks into the dark; fast light burns. One particle in thirty-odd is a spark: violet when
// slow, magenta when quick, a jellyfish pulse in a sea of teal. Far light loses red then green
// first, as it does under water, so depth is read as a slide toward blue.
fn abyss_ramp(t: f32) -> vec3f {
  var c = vec3f(0.003, 0.100, 0.36) * 0.40;                                    // drifting: deep blue
  c = mix(c, vec3f(0.006, 0.25, 0.66) * 0.65, smoothstep(0.00, 0.20, t));      // azure
  c = mix(c, vec3f(0.010, 0.48, 0.86) * 0.85, smoothstep(0.16, 0.38, t));      // cyan
  c = mix(c, vec3f(0.036, 0.89, 0.63) * 1.05, smoothstep(0.34, 0.58, t));      // turquoise, #35f2d0
  c = mix(c, vec3f(0.16, 1.00, 0.82) * 1.12, smoothstep(0.56, 0.80, t));       // mint
  c = mix(c, vec3f(0.30, 0.86, 1.00) * 1.15, smoothstep(0.78, 1.00, t));       // stirred: ice
  return c;
}

fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f {
  let s = clamp(log2(max(speed, 0.03) / 0.07) / 5.9, 0.0, 1.0);
  var c = vec3f(0.0);
  if (phase < 0.03) {
    // jellyfish spark: each visit leans a little further toward violet or toward magenta
    let lean = fract(seed * 7.13);
    let hot = clamp(s * 1.3 + 0.5 * (lean - 0.5) + (phase / 0.03 - 0.5) * 0.2, 0.0, 1.0);
    // a spark only really shines while it swims: at rest it is as dim as the plankton around it, so
    // the dense slow cores do not pick up a lilac cast from the 3 % that are sparks
    c = mix(vec3f(0.26, 0.05, 1.00), vec3f(1.00, 0.07, 0.62), smoothstep(0.15, 0.85, hot)) * mix(0.6, 2.4, smoothstep(0.12, 0.5, s));
  } else {
    let jitter = (phase - 0.5) * 0.08 + (seed - 0.5) * 0.05;
    c = abyss_ramp(clamp(s + jitter, 0.0, 1.0));
    // a particle all but at rest is the nucleus of the thing: it burns cyan, not the blue of slow drift
    c = mix(c, vec3f(0.02, 0.58, 0.78), (1.0 - smoothstep(0.03, 0.12, speed)) * 0.9);
  }
  // water eats red, then green: far light slides toward blue and dims, near light is a touch keener
  let far = max(depth, 0.0);
  let keep = exp(-vec3f(0.55, 0.26, 0.09) * far);
  return c * keep * (1.0 + 0.25 * clamp(-depth, 0.0, 1.0));
}
