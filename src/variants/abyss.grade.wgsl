// abyss: the finish is water, and it is the final colour (no AgX). A filmic curve would turn every
// glow pearly; here each channel saturates on its own, so cyan stays cyan into the highlights and
// only the hottest cores go pale. Quiet things, none meant to be noticed one by one:
//  - the sea breathes: luminance swells and ebbs on a ten second period, a hair later toward the
//    edges, so it reads as a slow swell of water and not a pulse;
//  - a web of caustic light drifts overhead and threads the haze, felt more than seen;
//  - the water is nearly black; a teal haze gathers only toward the top, where the light comes from.
// Every phase is an integer number of cycles per 1000 s, so nothing jumps when `time` wraps.
const ABYSS_TAU: f32 = 6.2831853;

fn abyss_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// A warped web of soft ridged sines: nets of light on a calm field, in 0..1, mean about 0.2. The
// ridges are rounded (no cusps), so it reads as light bending through water, not as a pattern.
fn abyss_caustic(p: vec2f, ph: f32) -> f32 {
  var q = p * 2.0;
  var acc = 0.0;
  var wsum = 0.0;
  var w = 1.0;
  for (var i = 0; i < 4; i++) {
    let fi = f32(i);
    q += 0.35 * vec2f(sin(q.y * 1.4 + ph * (17.0 + 3.0 * fi) + fi * 1.7), cos(q.x * 1.2 - ph * (13.0 + 4.0 * fi) + fi * 2.9));
    let r = sin(q.x * 1.6 + q.y * 1.1 + ph * (9.0 + 5.0 * fi));
    acc += w * (1.2 - sqrt(r * r + 0.03));
    wsum += w;
    w *= 0.5;
    q = vec2f(q.y, -q.x) * 1.7 + 1.3;
  }
  return pow(clamp(acc / wsum, 0.0, 1.0), 2.0);
}

// Scene light to display-linear, tone-mapped on the brightest channel and not per channel: the ratio
// between channels is kept, so cyan stays cyan into the highlights (a per-channel curve, AgX included,
// bleaches every glow toward white). The curve is logarithmic, so a dense core keeps a gradient over
// many stops; only the last stretch toward full brightness gives up its colour, into a pale aqua.
fn abyss_tone(c: vec3f) -> vec3f {
  let m = max(max(c.r, max(c.g, c.b)), 1e-6);
  let t = pow(log2(1.0 + 24.0 * m) / log2(961.0), 1.38);
  // on an HDR display the last stretch of the core is allowed past paper white; on SDR this is 1
  let pale = vec3f(0.86, 1.0, 1.0) * t * (1.0 + (axiom_headroom() - 1.0) * smoothstep(0.8, 1.0, t));
  return mix(c * (t / m), pale, 0.85 * smoothstep(0.55, 1.0, t));
}

fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  // uv is not aspect-corrected; its screen-space derivatives give the frame's aspect ratio
  let asp = abs(dpdy(uv.y)) / max(abs(dpdx(uv.x)), 1e-6);
  let d = (uv - 0.5) * vec2f(asp, 1.0);
  let ph = ABYSS_TAU * fract(time * 0.001);

  // breath: 10 s, small, and lagging a little with distance from the centre
  let swell = sin(ABYSS_TAU * fract(time * 0.1) - 0.5 * length(d));
  let breath = 1.0 + 0.08 * swell;

  // caustics: a broad web with a finer one riding on it, both drifting slowly
  let pa = uv * vec2f(asp, 1.0);
  let web = 0.7 * abyss_caustic(pa, ph) + 0.3 * abyss_caustic(pa * 2.7 + vec2f(5.3, 1.9), ph);

  var c = hdr * breath * (1.0 + 0.24 * (web - 0.2));
  // the brightest light swells a little more than the water around it: the nucleus breathes
  c *= 1.0 + 0.10 * swell * smoothstep(1.0, 8.0, max(c.r, max(c.g, c.b)));

  // shadows lean cool and chroma is pushed a little; blue light pours into green as it brightens,
  // so a dense core reads as aqua and never as lilac (teal is left alone)
  let y = abyss_luma(c);
  c *= mix(vec3f(1.0), vec3f(0.78, 0.97, 1.10), 0.5 * (1.0 - smoothstep(0.0, 0.5, y)));
  c = max(mix(vec3f(abyss_luma(c)), c, 1.22), vec3f(0.0));
  let m = max(c.r, max(c.g, c.b));
  c = mix(c, vec3f(c.r, max(c.g, 0.85 * c.b), 0.9 * c.b), smoothstep(0.6, 5.0, m));

  // the water: nearly black; the top of the frame holds the last of the light from far above,
  // in faint slanted shafts that the caustic web moves through
  let top = pow(1.0 - uv.y, 2.0);
  let shaft = 0.5 + 0.5 * sin(pa.x * 8.0 + pa.y * 3.0 + 1.6 * sin(pa.y * 2.3 + ph * 11.0) + ph * 7.0);
  let haze = vec3f(0.00045, 0.0024, 0.0034) * top * (0.55 + 1.1 * web + 0.6 * shaft * shaft) * (0.94 + 0.5 * (breath - 1.0));
  let floor_ = vec3f(0.00028, 0.00085, 0.00145) * (1.0 - 0.5 * smoothstep(0.2, 0.8, length(d)));
  let lit = abyss_tone(c);
  return lit + haze + floor_;
}
