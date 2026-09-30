// abyss: the finish is water. Four quiet things, none of them meant to be noticed one by one:
//  - the sea breathes: luminance swells and ebbs on a ten second period, a hair later toward the
//    edges, so it reads as a slow swell of water and not a pulse;
//  - a web of caustic light drifts overhead, felt in the haze and in the way faint filaments glint;
//  - the blacks are lifted toward deep teal, brighter high in the frame where the surface is;
//  - shadows lean cool and chroma is pushed out ahead of AgX, which desaturates by design.
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

fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  // uv is not aspect-corrected; its screen-space derivatives give the frame's aspect ratio
  let asp = abs(dpdy(uv.y)) / max(abs(dpdx(uv.x)), 1e-6);
  let d = (uv - 0.5) * vec2f(asp, 1.0);
  let ph = ABYSS_TAU * fract(time * 0.001);

  // breath: 10 s, small, and lagging a little with distance from the centre
  let swell = sin(ABYSS_TAU * (time * 0.1) - 0.5 * length(d));
  let breath = 1.0 + 0.08 * swell;

  // caustics drift slowly up-left across the frame
  // (a broad web and a finer one riding on it)
  let pa = uv * vec2f(asp, 1.0);
  let web = 0.7 * abyss_caustic(pa, ph) + 0.3 * abyss_caustic(pa * 2.7 + vec2f(5.3, 1.9), ph);

  var c = hdr * breath * (1.0 + 0.24 * (web - 0.2));
  // the brightest light swells a little more than the water around it: the nucleus breathes
  c *= 1.0 + 0.10 * swell * smoothstep(1.0, 8.0, max(c.r, max(c.g, c.b)));
  let y = abyss_luma(c);

  // shadows lean toward teal-blue; chroma is pushed out ahead of the tonemap
  let deep = 1.0 - smoothstep(0.0, 0.6, y);
  c *= mix(vec3f(1.0), vec3f(0.76, 0.97, 1.12), 0.55 * deep);
  c = max(mix(vec3f(abyss_luma(c)), c, 1.32), vec3f(0.0));
  // whatever burns hot burns cyan: blue light pours into green as it brightens, so a dense core reads
  // as aqua-white, the colour of a real flash in the water, and never as lilac; teal is left alone
  let m = max(c.r, max(c.g, c.b));
  let hot = smoothstep(0.6, 5.0, m);
  c = mix(c, vec3f(c.r, max(c.g, 0.85 * c.b), 0.9 * c.b), hot);

  // depth haze: lifted teal blacks, keener toward the top of the frame, threaded with the caustic web
  let above = (0.55 + 0.45 * (1.0 - uv.y)) * (1.0 - 0.45 * smoothstep(0.15, 0.75, length(d)));
  let haze = vec3f(0.00026, 0.00135, 0.00180) * above * (0.75 + 1.2 * web) * (0.94 + 0.5 * (breath - 1.0));
  return c + haze;
}
