// The lens. `lyap` estimates the Lyapunov spectrum of the world field at every point of the
// parameter disk (Benettin, mirroring crates/axiom-core/src/spectrum.rs) and writes the
// Kaplan-Yorke dimension and regime code to a texture; `vs` / `fs` draw that texture as the lens.
// Prepended at build time: law.wgsl (Law, f_world_of). Rust owns every law number.

struct MapParams {
  n: u32,         // grid side
  steps: u32,     // RK4 steps this dispatch
  reset: u32,     // 1 on the first dispatch: initialise the cells
  seed: u32,
  dt: f32,        // world time per RK4 step
  h: f32,         // finite-difference step of the Jacobian-vector products
  t_trans: f32,   // world time discarded before the averages count
  t_total: f32,   // world time at which the estimate is final
  rim: f32,       // cells this far beyond the unit circle are computed too (clean bilinear rim)
}

// One cell per grid point: x and t; three tangent vectors with the running log growth of each;
// the growth at the end of the transient; bookkeeping.
struct Cell {
  xt: vec4f,      // x, t
  q0: vec4f,      // tangent 0, sum ln|q0|
  q1: vec4f,
  q2: vec4f,
  snap: vec4f,    // growth sums at the end of the transient, and the time that was (-1 = not yet)
  info: vec4f,    // settled (0/1), restarts
}

@group(0) @binding(0) var<uniform> P: MapParams;
@group(0) @binding(1) var<storage, read> laws: array<Law>;
@group(0) @binding(2) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(3) var field_out: texture_storage_2d<rgba16float, write>;

// Same tolerance and rules as spectrum.rs.
const EPS: f32 = 0.01;
const SETTLED_SPEED: f32 = 1e-5;
const START: vec3f = vec3f(0.31, -0.22, 0.27);

struct St { x: vec3f, a: vec3f, b: vec3f, c: vec3f }

// The field and the three Jacobian-vector products (central differences), through a single call
// site of f_world_of: GPU compilers inline it everywhere it is called, and this is the hot spot.
fn deriv(L: Law, s: St) -> St {
  var dir = array<vec3f, 7>(vec3f(0.0), s.a, -s.a, s.b, -s.b, s.c, -s.c);
  var f: array<vec3f, 7>;
  for (var k = 0u; k < 7u; k++) {
    f[k] = f_world_of(L, s.x + P.h * dir[k]);
  }
  let inv = 0.5 / P.h;
  return St(f[0], (f[1] - f[2]) * inv, (f[3] - f[4]) * inv, (f[5] - f[6]) * inv);
}

fn axpy(s: St, k: St, h: f32) -> St {
  return St(s.x + h * k.x, s.a + h * k.a, s.b + h * k.b, s.c + h * k.c);
}

fn rk4(L: Law, s: St, h: f32) -> St {
  var k: array<St, 4>;
  var y = s;
  for (var i = 0u; i < 4u; i++) {
    k[i] = deriv(L, y);
    y = axpy(s, k[i], select(0.5 * h, h, i == 2u));
  }
  let w = h / 6.0;
  return St(
    s.x + w * (k[0].x + 2.0 * (k[1].x + k[2].x) + k[3].x),
    s.a + w * (k[0].a + 2.0 * (k[1].a + k[2].a) + k[3].a),
    s.b + w * (k[0].b + 2.0 * (k[1].b + k[2].b) + k[3].b),
    s.c + w * (k[0].c + 2.0 * (k[1].c + k[2].c) + k[3].c),
  );
}

fn hash(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

// Never exactly the origin (an equilibrium of every law); a hair of jitter breaks symmetries.
fn fresh_cell(idx: u32, restarts: f32) -> Cell {
  let hh = hash(idx * 2654435761u + P.seed + u32(restarts) * 977u);
  let j = vec3f(f32(hh & 1023u), f32((hh >> 10u) & 1023u), f32((hh >> 20u) & 1023u)) / 511.5 - 1.0;
  var c: Cell;
  c.xt = vec4f(START + 0.004 * j, 0.0);
  c.q0 = vec4f(1.0, 0.0, 0.0, 0.0);
  c.q1 = vec4f(0.0, 1.0, 0.0, 0.0);
  c.q2 = vec4f(0.0, 0.0, 1.0, 0.0);
  c.snap = vec4f(0.0, 0.0, 0.0, -1.0);
  c.info = vec4f(0.0, restarts, 0.0, 0.0);
  return c;
}

fn sort3(v: vec3f) -> vec3f {
  let hi = max(v.x, max(v.y, v.z));
  let lo = min(v.x, min(v.y, v.z));
  return vec3f(hi, v.x + v.y + v.z - hi - lo, lo);
}

// Kaplan-Yorke dimension; the two leading exponents within EPS of zero count as zero, so a
// cycle reads exactly 1 and a torus exactly 2.
fn kaplan_yorke(l: vec3f) -> f32 {
  let s = vec3f(select(l.x, 0.0, abs(l.x) <= EPS), select(l.y, 0.0, abs(l.y) <= EPS), l.z);
  if (s.x < 0.0) { return 0.0; }
  var sum = s.x;
  if (sum + s.y < 0.0) { return 1.0 + sum / abs(s.y); }
  sum += s.y;
  if (sum + s.z < 0.0) { return 2.0 + sum / abs(s.z); }
  return 3.0;
}

// 0 fixed point, 1 cycle, 2 torus, 3 strange, 4 labyrinth.
fn regime_of(l: vec3f, d: f32) -> f32 {
  if (l.x < -EPS) { return 0.0; }
  if (l.x <= EPS) { return select(2.0, 1.0, l.y < -EPS); }
  return select(3.0, 4.0, d >= 2.7);
}

@compute @workgroup_size(8, 8)
fn lyap(@builtin(global_invocation_id) gid: vec3u) {
  let n = P.n;
  if (gid.x >= n || gid.y >= n) { return; }
  let idx = gid.y * n + gid.x;
  let p = vec2f(f32(gid.x) + 0.5, -(f32(gid.y) + 0.5)) * (2.0 / f32(n)) + vec2f(-1.0, 1.0);
  let lim = 1.0 + P.rim;
  if (dot(p, p) > lim * lim) { return; }

  var c = cells[idx];
  if (P.reset != 0u) { c = fresh_cell(idx, 0.0); }
  if (c.info.x > 0.5) { return; }  // settled onto a fixed point: the texel is final

  let L = laws[idx];
  var s = St(c.xt.xyz, c.q0.xyz, c.q1.xyz, c.q2.xyz);
  var t = c.xt.w;
  var g = vec3f(c.q0.w, c.q1.w, c.q2.w);
  for (var i = 0u; i < P.steps; i++) {
    s = rk4(L, s, P.dt);
    t += P.dt;
    if ((i & 1u) == 0u) { continue; }
    // every second step, modified Gram-Schmidt on the tangent frame; the norms are the growth
    let n0 = max(length(s.a), 1e-30);
    let a = s.a / n0;
    let b1 = s.b - dot(s.b, a) * a;
    let n1 = max(length(b1), 1e-30);
    let b = b1 / n1;
    let c1 = s.c - dot(s.c, a) * a;
    let c2 = c1 - dot(c1, b) * b;
    let n2 = max(length(c2), 1e-30);
    s = St(s.x, a, b, c2 / n2);
    g += log(vec3f(n0, n1, n2));
    if (t - 2.0 * P.dt < P.t_trans && t >= P.t_trans) { c.snap = vec4f(g, t); }
  }

  if (!(dot(s.x, s.x) < 1.0e4) || any(g != g)) {
    // escaped or NaN: start this cell again from a fresh hash
    c = fresh_cell(idx, c.info.y + 1.0);
    s = St(c.xt.xyz, c.q0.xyz, c.q1.xyz, c.q2.xyz);
    t = 0.0;
    g = vec3f(0.0);
  } else if (t > 6.0 && length(f_world_of(L, s.x)) < SETTLED_SPEED) {
    c.info.x = 1.0;
  }

  // Until the transient is over the estimate is the running mean of everything; it hands over
  // to the mean since the transient smoothly, so the picture sharpens instead of jumping.
  let span = t - c.snap.w;
  let seen = select(0.0, smoothstep(2.0, 12.0, span), c.snap.w >= 0.0);
  var l = mix(g / max(t, 1e-3), (g - c.snap.xyz) / max(span, 1e-3), seen);
  l = sort3(l);
  var d = kaplan_yorke(l);
  var reg = regime_of(l, d);
  if (c.info.x > 0.5) { d = 0.0; reg = 0.0; }

  c.xt = vec4f(s.x, t);
  c.q0 = vec4f(s.a, g.x);
  c.q1 = vec4f(s.b, g.y);
  c.q2 = vec4f(s.c, g.z);
  cells[idx] = c;
  // r dimension, g regime, b the whole-number world it rounds to (for contours), a progress
  textureStore(field_out, gid.xy, vec4f(d, reg, clamp(floor(d + 0.5), 0.0, 3.0), min(1.0, t / P.t_total)));
}

// ---------------------------------------------------------------------------------- lens

struct LensParams {
  accent: vec4f,  // rgb tint, a = open (0 closed, 1 open)
  view: vec4f,    // grid side, canvas pixels across the disk, device pixel ratio
}

@group(0) @binding(0) var<uniform> V: LensParams;
@group(0) @binding(1) var field: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VOut { @builtin(position) pos: vec4f, @location(0) p: vec2f }

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));  // a fullscreen triangle
  var o: VOut;
  o.pos = vec4f(q * 2.0 - 1.0, 0.0, 1.0);
  o.p = q * 2.0 - 1.0;  // disk coordinates, v up
  return o;
}

// Cubic B-spline reconstruction of the field from four bilinear taps. Smoother than bilinear:
// the contours come out as curves instead of chamfered staircases, and single-cell noise softens.
fn smooth_field(uv: vec2f) -> vec4f {
  let size = V.view.x;
  let pos = uv * size - 0.5;
  let ip = floor(pos);
  let f = pos - ip;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  let w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  let w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (ip - 0.5 + w1 / g0) / size;
  let h1 = (ip + 1.5 + w3 / g1) / size;
  let t00 = textureSampleLevel(field, samp, vec2f(h0.x, h0.y), 0.0);
  let t10 = textureSampleLevel(field, samp, vec2f(h1.x, h0.y), 0.0);
  let t01 = textureSampleLevel(field, samp, vec2f(h0.x, h1.y), 0.0);
  let t11 = textureSampleLevel(field, samp, vec2f(h1.x, h1.y), 0.0);
  return g0.y * (g0.x * t00 + g1.x * t10) + g1.y * (g0.x * t01 + g1.x * t11);
}

// D 0 ink with a hint of depth, 1 cool, 2 warm, 2 to 3 a thin-film shimmer, 3 pale light. The
// hues are the origin variant's own: indigo and azure, champagne, coral and rose, aqua.
fn palette(d: f32, accent: vec3f) -> vec3f {
  let ink = vec3f(0.010, 0.013, 0.030) + accent * 0.012;
  let cool = mix(vec3f(0.10, 0.32, 0.92), accent, 0.2);
  let warm = vec3f(0.98, 0.78, 0.46);
  let coral = vec3f(1.0, 0.44, 0.44);
  let rose = vec3f(0.92, 0.30, 0.70);
  let aqua = vec3f(0.42, 0.90, 0.92);
  let pale = mix(vec3f(0.96, 0.97, 1.0), accent, 0.10);
  let s = clamp(d, 0.0, 3.0);
  var c = mix(ink, cool, smoothstep(0.0, 1.0, s));
  c = mix(c, warm, smoothstep(1.0, 2.0, s));
  c = mix(c, coral, smoothstep(2.0, 2.22, s));
  c = mix(c, rose, smoothstep(2.22, 2.5, s));
  c = mix(c, aqua, smoothstep(2.5, 2.76, s));
  c = mix(c, pale, smoothstep(2.76, 3.0, s));
  return c;
}

// How much the whole-number world changes within a few cells of here: 0 deep in a plateau,
// rising towards a contour. A spiral of bilinear taps, turned per pixel so what is left of the
// sampling error is fine grain rather than terraces.
fn nearness(uv: vec2f, b0: f32, turn: f32) -> f32 {
  let reach = 6.5 / V.view.x;
  var acc = 0.0;
  for (var i = 0; i < 20; i++) {
    let a = f32(i) * 2.39996 + turn * 6.2832;
    let rad = reach * sqrt((f32(i) + 0.5) / 20.0);
    acc += abs(textureSampleLevel(field, samp, uv + vec2f(cos(a), sin(a)) * rad, 0.0).z - b0);
  }
  return smoothstep(0.0, 1.0, clamp(acc / 20.0 * 2.6, 0.0, 1.0));
}

fn white(p: vec2u) -> f32 {
  return f32(hash(p.x + 4099u * p.y)) / 4294967295.0;
}

fn dither(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))) - 0.5;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let open = V.accent.a;
  let acc = V.accent.rgb;
  let dpr = V.view.z;
  let r = length(in.p);
  let px = max(fwidth(r), 1e-4);          // one canvas pixel, in disk units
  let disk = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);

  let uv = vec2f(in.p.x * 0.5 + 0.5, 0.5 - in.p.y * 0.5);
  let f = smooth_field(uv);
  let near = nearness(uv, f.z, white(vec2u(in.pos.xy)));
  let ready = smoothstep(0.02, 0.4, f.w);
  var col = palette(f.x, acc);

  // light gathers at the contours and the plateaus lie deeper, like an engraved chart
  col *= 0.8 + 0.5 * near;

  // a faint bevel where the dimension changes fast: light from the upper left
  let slope = vec2f(dpdx(f.x), dpdy(f.x)) * (V.view.y * 0.5) / V.view.x;
  col *= 1.0 + clamp(0.7 * (slope.x + slope.y), -0.5, 0.5) * 0.5;

  // crisp contours where the whole-number world changes: D = 1, 2 and 3 are the worlds entered
  let gb = length(vec2f(dpdx(f.z), dpdy(f.z)));
  let hw = mix(0.42, 0.55, open) * dpr;
  var line = 0.0;
  for (var k = 1; k <= 3; k++) {
    let d = abs(f.z - (f32(k) - 0.5)) / max(gb, 1e-4);   // distance to the level, in pixels
    line = max(line, select(0.8, 1.0, k == 1) * (1.0 - smoothstep(hw - 0.6, hw + 0.6, d)));
  }
  let ink = mix(vec3f(0.90, 0.94, 1.0), acc, 0.3);
  col = mix(col, ink, line * 0.7 * ready);

  // the lens itself: a dimmer rim, a hint of glass, and the r = 1 ring
  col *= 1.0 - 0.34 * smoothstep(0.6, 1.0, r);
  col += vec3f(0.55, 0.62, 0.85) * 0.045 * smoothstep(0.8, 0.0, length(in.p - vec2f(-0.34, 0.42)));
  let ring = exp(-pow((r - (1.0 - 1.5 * px)) / (1.4 * px), 2.0));
  col = mix(col, acc, ring * mix(0.16, 0.24, open));
  col *= mix(0.55, 1.0, ready) * mix(0.9, 1.0, open);
  col += dither(in.pos.xy) / 255.0;
  return vec4f(col * disk, disk);
}
