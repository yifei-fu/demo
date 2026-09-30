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

// The field and the three Jacobian-vector products (central differences of the field along each
// tangent vector). One call site of f_world_of: GPU compilers inline it wherever it is called,
// and it is the hot spot. Evaluation k is at x + sign * h * q with q the tangent vector `w`.
fn deriv(L: Law, s: St) -> St {
  var o = St(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  let inv = 0.5 / P.h;
  for (var k = 0u; k < 7u; k++) {
    let w = (k + 1u) >> 1u;
    let sign = select(-1.0, 1.0, (k & 1u) == 1u);
    var q = vec3f(0.0);
    if (w == 1u) { q = s.a; } else if (w == 2u) { q = s.b; } else if (w == 3u) { q = s.c; }
    let f = f_world_of(L, s.x + (sign * P.h) * q);
    if (w == 0u) { o.x = f; }
    else if (w == 1u) { o.a += (sign * inv) * f; }
    else if (w == 2u) { o.b += (sign * inv) * f; }
    else { o.c += (sign * inv) * f; }
  }
  return o;
}

fn axpy(s: St, k: St, h: f32) -> St {
  return St(s.x + h * k.x, s.a + h * k.a, s.b + h * k.b, s.c + h * k.c);
}

fn rk4(L: Law, s: St, h: f32) -> St {
  var y = s;
  var sum = St(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  for (var i = 0u; i < 4u; i++) {
    let k = deriv(L, y);
    sum = axpy(sum, k, select(2.0, 1.0, i == 0u || i == 3u));
    y = axpy(s, k, select(0.5 * h, h, i == 2u));
  }
  return axpy(s, sum, h / 6.0);
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
  // r dimension; g is 1 on a torus and b on a strange attractor or labyrinth (indicators, so the
  // lens can interpolate them); a is progress
  let done = select(min(1.0, t / P.t_total), 1.0, c.info.x > 0.5);
  textureStore(field_out, gid.xy, vec4f(d, select(0.0, 1.0, reg == 2.0), select(0.0, 1.0, reg >= 3.0), done));
}

// ---------------------------------------------------------------------------------- lens
// A small dark glass object. The regimes are drawn as light: a soft glow where a cycle lives, a
// moire of fine rings on a torus, a twinkling grain where the motion is chaotic, and hairline
// contours where the whole-number dimension changes. Hue is only an accent. In the light theme
// the same picture is ink on paper.

// The canvas reaches EXTENT disk radii from the centre, leaving room for the rim furniture.
const EXTENT: f32 = 1.1;
const TAU: f32 = 6.2831853;

struct LensParams {
  accent: vec4f,             // rgb accent, a = open (0 the lens, 1 the full-screen map)
  view: vec4f,               // grid side, canvas pixels across, device pixel ratio, disk radius in CSS px
  mode: vec4f,               // x = 1 for the light theme, y = time in seconds
  anchors: array<vec4f, 2>,  // angles of the law's anchors on the rim; 9 = none
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
  o.p = (q * 2.0 - 1.0) * EXTENT;  // disk coordinates, v up
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

// How much the whole-number world changes within a few cells of here: 0 deep in a plateau,
// rising towards a contour. A spiral of bilinear taps, turned per pixel so what is left of the
// sampling error is fine grain rather than terraces.
fn nearness(uv: vec2f, world: f32, turn: f32) -> f32 {
  let reach = 6.0 / V.view.x;
  var acc = 0.0;
  for (var i = 0; i < 14; i++) {
    let a = f32(i) * 2.39996 + turn * TAU;
    let rad = reach * sqrt((f32(i) + 0.5) / 14.0);
    let d = textureSampleLevel(field, samp, uv + vec2f(cos(a), sin(a)) * rad, 0.0).x;
    acc += abs(floor(d + 0.5) - world);
  }
  return smoothstep(0.0, 1.0, clamp(acc / 14.0 * 2.4, 0.0, 1.0));
}

fn white(p: vec2u, salt: u32) -> f32 {
  return f32(hash(p.x + 4099u * p.y + salt * 15731u)) / 4294967295.0;
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// The rim furniture of the open map: a hairline, a tick every 5 degrees (longer every 30) and a
// small diamond at each anchor of the law. Coverage 0..1.
fn bezel(p: vec2f, r: f32, px: f32) -> f32 {
  var c = 0.5 * (1.0 - smoothstep(0.5 * px, 1.5 * px, abs(r - 1.032)));
  let t = atan2(p.y, p.x) / TAU * 72.0;
  let idx = round(t);
  let across = abs(t - idx) * TAU * r / 72.0;
  let major = idx - 6.0 * floor(idx / 6.0) < 0.5;
  let reach = select(1.056, 1.082, major);
  let tick = (1.0 - smoothstep(0.4 * px, 1.3 * px, across)) * step(1.032, r) * (1.0 - smoothstep(reach - px, reach, r));
  c = max(c, tick * select(0.4, 0.75, major));
  for (var i = 0; i < 8; i++) {
    let a = V.anchors[i >> 2u][i & 3];
    if (a > 8.0) { continue; }
    let dir = vec2f(cos(a), sin(a));
    let q = p - dir * 1.066;
    let dd = abs(dot(q, dir)) + abs(dot(q, vec2f(-dir.y, dir.x)));
    c = max(c, 1.0 - smoothstep(0.02 - px, 0.02 + px, dd));
  }
  return c;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let open = V.accent.a;
  let acc = V.accent.rgb;
  let dpr = V.view.z;
  let light = V.mode.x > 0.5;
  let time = V.mode.y;
  let p = in.p;
  let r = length(p);
  let px = max(fwidth(r), 1e-4);          // one canvas pixel, in disk units
  let disk = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);

  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  let f = smooth_field(uv);
  let d = f.x;
  let tor = clamp(f.y, 0.0, 1.0);
  let cha = clamp(f.z, 0.0, 1.0);
  let ready = mix(0.4, 1.0, smoothstep(0.02, 0.4, f.w));
  let world = floor(d + 0.5);
  let near = nearness(uv, world, white(vec2u(in.pos.xy), 0u));
  let live = smoothstep(0.3, 0.85, d);
  let cyc = live * (1.0 - smoothstep(1.25, 1.75, d));

  let ice = mix(vec3f(0.52, 0.72, 1.0), acc, 0.3);
  let gold = vec3f(1.0, 0.82, 0.52);
  let pearl = vec3f(0.97, 0.96, 0.93);

  // hairline contours where the nearest whole-number world changes, and finer ones each tenth of
  // a dimension inside the chaotic band
  let gd = length(vec2f(dpdx(d), dpdy(d)));
  let hw = mix(0.34, 0.42, open) * dpr;
  var major = 0.0;
  for (var k = 1; k <= 3; k++) {
    let dist = abs(d - (f32(k) - 0.5)) / max(gd, 1e-4);
    major = max(major, select(0.8, 1.0, k == 1) * (1.0 - smoothstep(hw - 0.6, hw + 0.6, dist)));
  }
  let tenth = abs(fract(d * 10.0 + 0.5) - 0.5) / max(gd * 10.0, 1e-4);
  let minor = (1.0 - smoothstep(0.7 * hw - 0.5, 0.7 * hw + 0.5, tenth))
    * cha * smoothstep(2.03, 2.2, d) * smoothstep(0.0006, 0.004, gd);

  // a torus: fine rings seen through a second, off-centre set of rings
  let ringsPerRadius = clamp(V.view.w / 2.6, 8.0, 60.0);
  let kr = TAU * ringsPerRadius;
  let shift = vec2f(0.9, 0.4) * (9.4 / kr);
  let moire = 0.5 + 0.5 * cos(kr * length(p)) * cos(kr * length(p - shift));
  let ringFade = smoothstep(2.2, 3.6, (TAU / kr) / px);

  // chaos: a shimmer of tiny points that swell and fade out of step with one another, denser
  // as the dimension nears 3, with a faint thin-film tint
  let cellPx = max(1.9 * dpr, 2.6);
  let g = in.pos.xy / cellPx;
  let cell = vec2u(floor(g));
  let n1 = white(cell, 0u);
  let n2 = white(cell, 977u);
  let n3 = white(cell, 31u);
  let at = vec2f(white(cell, 101u), white(cell, 202u)) * 0.5 + 0.25;
  let dot2 = 1.0 - smoothstep(0.25 * dpr, 0.7 * dpr, length(fract(g) - at) * cellPx);
  let density = cha * (0.08 + 0.42 * clamp(d - 2.0, 0.0, 1.0));
  let member = smoothstep(1.0 - density, 1.0 - density + 0.03, n1);
  let breath = pow(0.5 + 0.5 * sin(time * (1.4 + 2.2 * n2) + n3 * TAU), 2.0);
  let spark = member * (0.12 + 0.88 * breath) * dot2;
  let swell = 0.5 + 0.5 * sin(p.x * 7.0 + time * 0.8 + 3.0 * sin(p.y * 5.0 - time * 0.5));
  let film = 0.5 + 0.5 * cos(TAU * (vec3f(0.0, 0.33, 0.67) + d * 1.4 + n2 * 0.25));
  let chaosTint = mix(mix(gold, pearl, clamp(d - 2.0, 0.0, 1.0)), film, 0.18);

  // light
  var e = vec3f(0.0);
  e += ice * cyc * (0.035 + 0.2 * near);
  e += gold * tor * (0.05 + 0.13 * near + 0.16 * moire * ringFade);
  e += chaosTint * cha * (0.10 + 0.10 * clamp(d - 2.0, 0.0, 1.0) + 0.07 * swell * (0.3 + near) + 1.3 * spark);
  e += pearl * (0.62 * major + 0.26 * minor);
  e *= ready;

  // the glass: a faint fresnel at the rim, a reflection arc in the upper left, a hint of depth
  let ang = atan2(p.y, p.x);
  let arc = smoothstep(0.045, 0.0, abs(r - 0.88)) * smoothstep(0.0, 0.35, sin(ang - 1.9)) * smoothstep(1.0, 0.3, abs(ang - 2.3));
  let fresnel = smoothstep(0.9, 1.0, r);
  let ring = exp(-pow((r - (1.0 - 1.4 * px)) / (1.3 * px), 2.0));

  var col: vec3f;
  if (light) {
    let paper = vec3f(0.955, 0.935, 0.885) * (1.0 + (white(vec2u(in.pos.xy), 5u) - 0.5) * 0.025);
    let ink = mix(vec3f(0.07, 0.09, 0.16), acc * 0.4, 0.3);
    let amount = clamp(lum(e) * 1.5 + 0.6 * major, 0.0, 1.0);
    let hue = mix(vec3f(1.0), e / max(lum(e), 1e-3), 0.25);
    col = mix(paper, ink * hue, pow(amount, 0.85));
    col *= 1.0 - 0.10 * fresnel - 0.05 * smoothstep(0.5, 1.0, r);
    col = mix(col, ink, ring * mix(0.35, 0.5, open));
  } else {
    let depth = vec3f(0.006, 0.008, 0.017) + vec3f(0.010, 0.014, 0.030) * (1.0 - r * r) + acc * 0.006;
    col = depth + e;
    col += vec3f(0.55, 0.62, 0.85) * (0.05 * arc + 0.03 * fresnel);
    col = mix(col, acc, ring * mix(0.20, 0.32, open));
  }
  col *= mix(0.85, 1.0, open);
  col += (white(vec2u(in.pos.xy), 9u) - 0.5) / 255.0;

  // rim furniture, outside the disk, open only
  let bz = bezel(p, r, px) * open * (1.0 - disk);
  let bzCol = select(mix(pearl, acc, 0.35), mix(vec3f(0.07, 0.09, 0.16), acc * 0.4, 0.3), light);
  let alpha = max(disk, bz);
  return vec4f(col * disk + bzCol * bz, alpha);
}
