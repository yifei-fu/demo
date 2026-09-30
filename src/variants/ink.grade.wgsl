// ink: sumi on washi. The engine hands over the accumulated pigment load as `hdr`; this file turns
// it into the FINAL colour: warm paper times the light that survives the ink,
//     paper * exp(-k * load)     with a blue-black floor where the ink is deepest.
// Everything about the paper (wash, fibres, tooth) is a pure function of uv: it never moves.

const INK_PAPER: vec3f = vec3f(0.863, 0.815, 0.738);    // #efe9df in linear light
const INK_BLACK: vec3f = vec3f(0.0034, 0.0044, 0.0088); // dense sumi: cool, never quite neutral
const INK_K: f32 = 3.0;
const INK_GAMMA: f32 = 0.85;   // < 1 opens up the thin washes; dense ink still saturates to black

// ------------------------------------------------------------------ paper
fn ink_hash(p: vec2i) -> f32 {
  var h = bitcast<u32>(p.x) * 374761393u + bitcast<u32>(p.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h & 0xffffffu) * (1.0 / 16777216.0);
}

fn ink_vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(ink_hash(i), ink_hash(i + vec2i(1, 0)), u.x),
    mix(ink_hash(i + vec2i(0, 1)), ink_hash(i + vec2i(1, 1)), u.x),
    u.y,
  );
}

// One thin fibre per cell of a grid, at a random angle and length; a fibre stays inside its own
// cell, so a single lookup per layer is enough. Random angles keep it from ever reading as a weave.
// Returns a signed value: +1 a pale fibre, -1 a dark one, 0 between them.
fn ink_fibre_layer(p: vec2f, cell: f32, salt: i32) -> f32 {
  let q = p / cell;
  let id = vec2i(floor(q)) + vec2i(salt * 101, salt * 57);
  let f = fract(q) - 0.5;
  let c = (vec2f(ink_hash(id), ink_hash(id + vec2i(311, 17))) - 0.5) * 0.28;
  let a = 6.2831853 * ink_hash(id + vec2i(53, 719));
  let half_len = mix(0.10, 0.34, ink_hash(id + vec2i(97, 41)));
  let kind = ink_hash(id + vec2i(7, 1303));
  let d = f - c;
  let dir = vec2f(cos(a), sin(a));
  let along = clamp(dot(d, dir), -half_len, half_len);
  let dist = length(d - dir * along) * cell;
  let line = 1.0 - smoothstep(0.30, 0.95, dist);
  let present = step(0.42, kind);
  return line * present * select(-1.0, 0.7, kind > 0.72);
}

fn ink_fibres(p: vec2f) -> f32 {
  return ink_fibre_layer(p, 23.0, 1) + 0.8 * ink_fibre_layer(p + 40.0, 37.0, 2) + 0.6 * ink_fibre_layer(p + 90.0, 15.0, 3);
}

// ------------------------------------------------------------------ grade
fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f {
  // frame-height units, so the paper keeps its scale whatever the resolution scale is
  let aspect = abs(dpdy(uv.y)) / max(abs(dpdx(uv.x)), 1e-6);
  let p = vec2f(uv.x * aspect, uv.y) * 852.0;

  // paper: an uneven wash, kozo fibres, a faint fall-off toward the corners
  let wash = ink_vnoise(p * 0.0035) * 0.6 + ink_vnoise(p * 0.011 + 7.0) * 0.4 - 0.5;
  let fibres = ink_fibres(p);  // -1 dark .. +1 pale
  let grainy = ink_vnoise(p * 0.42) * 0.6 + ink_vnoise(p * 1.15 + 3.0) * 0.4;
  let d = uv - 0.5;
  let r2 = dot(d, d) * 2.0;
  var paper = INK_PAPER;
  paper *= 1.0 + 0.045 * wash;
  paper *= vec3f(1.0 + 0.010 * wash, 1.0, 1.0 - 0.014 * wash);
  paper *= 1.0 - 0.020 * (grainy - 0.5) + 0.030 * fibres;
  paper *= 1.0 - 0.050 * smoothstep(0.35, 1.05, r2);

  // ink: absorption per channel. The load's own hue survives (warm wash, cool dense ink); a thin
  // wash feels the paper's tooth, so a quick stroke dries into fibres instead of fading smoothly.
  let m = (hdr.r + hdr.g + hdr.b) * (1.0 / 3.0);
  let chroma = hdr / max(m, 1e-5);
  // the toe keeps a lone particle from reading as a digital dot; a wash of several still reads
  var mg = pow(m, INK_GAMMA);
  mg *= 0.35 + 0.65 * smoothstep(0.08, 0.35, mg);
  let dry = 1.0 - smoothstep(0.05, 0.9, mg);
  let tooth = clamp(grainy * 0.8 - fibres * 0.25, 0.0, 1.0);
  let feel = 1.0 + dry * 1.1 * (tooth - 0.5);
  let warm = vec3f(0.93, 1.00, 1.10);
  let cool = vec3f(1.10, 1.00, 0.86);
  let spectrum = mix(warm, cool, smoothstep(0.20, 1.6, mg));
  let load = chroma * mg * spectrum * feel;
  let t = exp(-INK_K * load);

  return INK_BLACK + (paper - INK_BLACK) * t;
}
