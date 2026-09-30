// Resolve (fractal-flame log density + trails), dual-Kawase bloom, composite (AgX, grain, vignette).

struct Post {
  size: vec4f,  // width, height, 1/width, 1/height
  a: vec4f,     // exposure, trail, bloom, grain
  b: vec4f,     // vignette, chromatic aberration, hdr headroom, time
  c: vec4f,     // density k, pixels per particle, breath, frame
}

@group(0) @binding(0) var<uniform> P: Post;

struct VOut { @builtin(position) pos: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  // one oversized triangle covering the screen
  let x = f32((vi << 1u) & 2u);
  let y = f32(vi & 2u);
  return VOut(vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0));
}

// ---------------------------------------------------------------- resolve
@group(0) @binding(1) var<storage, read> accum: array<u32>;
@group(0) @binding(2) var prevTex: texture_2d<f32>;

const FIXED: f32 = 256.0;

@fragment
fn fs_resolve(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ip = vec2u(pos.xy);
  let base = (ip.y * u32(P.size.x) + ip.x) * 4u;
  let cnt = f32(accum[base + 3u]);
  var cur = vec3f(0.0);
  if (cnt > 0.0) {
    let avg = vec3f(f32(accum[base]), f32(accum[base + 1u]), f32(accum[base + 2u])) / cnt;
    // density relative to a uniform spread over the screen, so brightness is resolution- and
    // particle-count independent; the log keeps dense cores from clipping and faint wisps alive
    let x = (cnt / FIXED) * P.c.y;
    cur = avg * (log2(1.0 + P.c.x * x) / log2(1.0 + P.c.x));
  }
  let prev = textureLoad(prevTex, vec2i(ip), 0).rgb;
  // exponential moving average: a longer effective exposure and light-painted trails
  return vec4f(mix(cur, prev, P.a.y), 1.0);
}

// ---------------------------------------------------------------- bloom
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(srcTex, samp, uv, 0.0).rgb; }

fn knee(c: vec3f) -> vec3f {
  // soft threshold: only what is genuinely bright feeds the halo
  let t = 0.5;
  let k = 0.3;
  let l = max(c.r, max(c.g, c.b));
  let soft = clamp(l - t + k, 0.0, 2.0 * k);
  let contrib = max(soft * soft / (4.0 * k), l - t) / max(l, 1e-4);
  return c * contrib;
}

@fragment
fn fs_down_first(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(srcTex));
  let uv = pos.xy * 2.0 * texel;  // destination pixel centre in source uv
  let o = texel;
  var sum = knee(tap(uv) * P.a.x) * 4.0;
  sum += knee(tap(uv + vec2f(-o.x, -o.y)) * P.a.x);
  sum += knee(tap(uv + vec2f(o.x, -o.y)) * P.a.x);
  sum += knee(tap(uv + vec2f(-o.x, o.y)) * P.a.x);
  sum += knee(tap(uv + vec2f(o.x, o.y)) * P.a.x);
  return vec4f(sum / 8.0, 1.0);
}

@fragment
fn fs_down(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(srcTex));
  let uv = pos.xy * 2.0 * texel;
  let o = texel;
  var sum = tap(uv) * 4.0;
  sum += tap(uv + vec2f(-o.x, -o.y));
  sum += tap(uv + vec2f(o.x, -o.y));
  sum += tap(uv + vec2f(-o.x, o.y));
  sum += tap(uv + vec2f(o.x, o.y));
  return vec4f(sum / 8.0, 1.0);
}

const UP_WEIGHT: f32 = 0.62;

@fragment
fn fs_up(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(srcTex));
  let dstSize = vec2f(textureDimensions(srcTex)) * 2.0;
  let uv = pos.xy / dstSize;
  let h = texel * 0.5;
  var sum = tap(uv + vec2f(-h.x * 2.0, 0.0));
  sum += tap(uv + vec2f(-h.x, h.y)) * 2.0;
  sum += tap(uv + vec2f(0.0, h.y * 2.0));
  sum += tap(uv + vec2f(h.x, h.y)) * 2.0;
  sum += tap(uv + vec2f(h.x * 2.0, 0.0));
  sum += tap(uv + vec2f(h.x, -h.y)) * 2.0;
  sum += tap(uv + vec2f(0.0, -h.y * 2.0));
  sum += tap(uv + vec2f(-h.x, -h.y)) * 2.0;
  return vec4f(sum / 12.0 * UP_WEIGHT, 1.0);
}

// ---------------------------------------------------------------- composite
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var csamp: sampler;

override LINEAR_OUT: bool = false;
const BG: vec3f = vec3f(0.0015, 0.0018, 0.0030);  // #05060a in linear light

// AgX (Troy Sobotka), minimal implementation with the polynomial sigmoid.
const AGX_IN = mat3x3f(
  0.842479062253094, 0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772, 0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104,
);
const AGX_OUT = mat3x3f(
  1.19687900512017, -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
  -0.0990297440797205, -0.0989611768448433, 1.15107367264116,
);

fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// display-referred (gamma-encoded) result in 0..1
fn agx(c: vec3f) -> vec3f {
  let min_ev = -12.47393;
  let max_ev = 4.026069;
  var v = AGX_IN * max(c, vec3f(1e-10));
  v = clamp(log2(v), vec3f(min_ev), vec3f(max_ev));
  v = (v - min_ev) / (max_ev - min_ev);
  v = agx_contrast(v);
  return max(AGX_OUT * v, vec3f(0.0));
}

fn hash12(p: vec2f, t: f32) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031 + t * 0.0173);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

@fragment
fn fs_composite(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * P.size.zw;
  let d = uv - 0.5;
  let r2 = dot(d, d) * 2.0;  // 0 at the centre, 1 in the corners

  // a whisper of chromatic aberration growing toward the edges
  let ca = d * r2 * P.b.y;
  var c = vec3f(
    textureSampleLevel(hdrTex, csamp, uv + ca, 0.0).r,
    textureSampleLevel(hdrTex, csamp, uv, 0.0).g,
    textureSampleLevel(hdrTex, csamp, uv - ca, 0.0).b,
  );
  let bloom = textureSampleLevel(bloomTex, csamp, uv, 0.0).rgb;
  let vig = 1.0 - P.b.x * smoothstep(0.25, 1.05, r2);
  var lin = (c * P.a.x * P.c.z + bloom * P.a.z) * vig;

  var enc = agx(lin + BG);

  // fine animated grain, weighted away from the deepest blacks; also dithers the dark gradients
  let n = hash12(pos.xy, P.b.w) + hash12(pos.xy + 17.0, P.b.w + 3.7) - 1.0;
  enc = max(enc + n * P.a.w * (0.35 + enc), vec3f(0.0));

  if (LINEAR_OUT) {
    var o = pow(enc, vec3f(2.2));
    let headroom = P.b.z;
    o *= 1.0 + (headroom - 1.0) * smoothstep(0.3, 1.0, max(o.r, max(o.g, o.b)));
    return vec4f(o, 1.0);
  }
  return vec4f(enc, 1.0);
}
