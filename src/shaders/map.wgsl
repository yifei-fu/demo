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

fn jvp(L: Law, x: vec3f, q: vec3f) -> vec3f {
  return (f_world_of(L, x + P.h * q) - f_world_of(L, x - P.h * q)) * (0.5 / P.h);
}

fn deriv(L: Law, s: St) -> St {
  return St(f_world_of(L, s.x), jvp(L, s.x, s.a), jvp(L, s.x, s.b), jvp(L, s.x, s.c));
}

fn axpy(s: St, k: St, h: f32) -> St {
  return St(s.x + h * k.x, s.a + h * k.a, s.b + h * k.b, s.c + h * k.c);
}

fn rk4(L: Law, s: St, h: f32) -> St {
  let k1 = deriv(L, s);
  let k2 = deriv(L, axpy(s, k1, 0.5 * h));
  let k3 = deriv(L, axpy(s, k2, 0.5 * h));
  let k4 = deriv(L, axpy(s, k3, h));
  let w = h / 6.0;
  return St(
    s.x + w * (k1.x + 2.0 * (k2.x + k3.x) + k4.x),
    s.a + w * (k1.a + 2.0 * (k2.a + k3.a) + k4.a),
    s.b + w * (k1.b + 2.0 * (k2.b + k3.b) + k4.b),
    s.c + w * (k1.c + 2.0 * (k2.c + k3.c) + k4.c),
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
  for (var i = 0u; i < P.steps; i += 2u) {
    s = rk4(L, s, P.dt);
    s = rk4(L, s, P.dt);
    let t0 = t;
    t += 2.0 * P.dt;
    // modified Gram-Schmidt on the tangent frame; the norms are the growth factors
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
    if (t0 < P.t_trans && t >= P.t_trans) { c.snap = vec4f(g, t); }
  }

  var out = vec4f(0.0);
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
  textureStore(field_out, gid.xy, vec4f(d, reg, l.x, min(1.0, t / P.t_total)));
}

// ---------------------------------------------------------------------------------- lens

struct LensParams {
  accent: vec4f,  // rgb tint, a = open (0 closed, 1 open)
  view: vec4f,    // 1 / pixels across, grid side, unused, unused
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
  o.p = vec2f(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0) * 1.0;  // disk coordinates, v up
  return o;
}

fn palette(d: f32) -> vec3f {
  let s = clamp(d, 0.0, 3.0);
  let c0 = vec3f(0.012, 0.016, 0.034);
  let c1 = vec3f(0.10, 0.27, 0.86);
  let c2 = vec3f(1.0, 0.66, 0.24);
  let c3 = vec3f(1.0, 1.0, 1.0);
  let sp = 0.5 + 0.5 * cos(6.2831 * (vec3f(0.0, 0.33, 0.67) + (s - 2.0) * 1.6));
  var col = mix(c0, c1, smoothstep(0.0, 1.0, s));
  col = mix(col, c2, smoothstep(1.0, 2.0, s));
  col = mix(col, mix(c2, sp, 0.8), smoothstep(2.0, 2.35, s));
  col = mix(col, c3, smoothstep(2.6, 3.0, s));
  return col;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let r = length(in.p);
  let px = fwidth(r);
  let disk = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
  let uv = vec2f(in.p.x * 0.5 + 0.5, 0.5 - in.p.y * 0.5);
  let f = textureSampleLevel(field, samp, uv, 0.0);
  let col = palette(f.x);
  return vec4f(col * disk, disk);
}
