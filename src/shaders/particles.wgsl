// One fused kernel per frame: integrate (RK2, 2 substeps), stir/shake forces, respawn, then
// project and splat into the fixed-point accumulation buffer with stochastic depth of field.
// (law.wgsl and the variant's shade function are concatenated in front of this file.)

struct Frame {
  right: vec4f,   // xyz, focal_x     (ndc.x = cam.x / cam.z * focal_x)
  up: vec4f,      // xyz, focal_y
  fwd: vec4f,     // xyz, unused
  eye: vec4f,     // xyz, unused
  ray: vec4f,     // xyz stir ray direction, w = stir radius in tan units
  screen: vec4f,  // width, height, dt, time
  lens: vec4f,    // focus distance, aperture (px), near plane, max CoC (px)
  stir: vec4f,    // touch ndc x, y, strength, dive amount
  stirv: vec4f,   // touch ndc velocity x, y, shake energy, shake id
  misc: vec4f,    // seed as a fraction in [0,1), RK2 substeps, extent-sampling stride, clone-respawn share
  probe: vec4f,   // xyz: centre the extent histogram is measured from, w: the attractor's radius
  tone: vec4f,    // reference speed, dwell equalisation 0..1, its floor, depth cue strength
  ids: vec4u,     // frame, count, seed, flags (bit 0: initialise, bit 1: splat)
}

@group(0) @binding(0) var<uniform> law: Law;
@group(0) @binding(1) var<uniform> F: Frame;
@group(0) @binding(2) var<storage, read_write> parts: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> accum: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> extent: array<atomic<u32>>;

const FIXED: f32 = 256.0;
const TAU: f32 = 6.2831853;
const SPAWN_RADIUS: f32 = 1.2;
const CLONE_JITTER: f32 = 0.004;     // world units: well under the lattice period (0.09)
const ESCAPE_R2: f32 = 2.56;             // respawn beyond |x| = 1.6
const TRICKLE_PER_SECOND: f32 = 0.12;   // 0.2 % per frame at 60 fps
// Newcomers are still falling toward the attractor. They are dim and wear one calm hue until they
// have settled onto it, and a few of them (tracers) trail hair-thin comet tails, so the respawn
// trickle reads as fine streams flowing inward rather than as dust.
const DUST_WEIGHT: f32 = 0.08;
const SETTLED_START: f32 = 1.5;      // age (s) at which a newcomer starts to become full light
const SETTLED_END: f32 = 6.0;
const REFERENCE_SPEED: f32 = 0.45;   // the hue newcomers wear, whatever their speed
const TRACER_FRACTION: f32 = 0.002;
const TRACER_WEIGHT: f32 = 7.0;
const TAIL_STEPS: i32 = 14;
const TAIL_DT: f32 = 0.04;           // world time between tail samples (a 0.55 s tail)
// The attractor's extent is measured on a sparse sample of settled particles: the sum of their
// positions (fixed point) and a histogram of their distance from the last known centre.
const POS_FIXED: f32 = 16384.0;
const HIST_BINS: u32 = 32u;
const HIST_RANGE: f32 = 2.0;
// ... and a histogram of their speed, in thirds of an octave from 2^-8 upward.
const SPEED_BINS: u32 = 48u;
const SPEED_BASE: f32 = -8.0;
const SPEED_PER_OCTAVE: f32 = 3.0;
const DWELL_POWER: f32 = 1.6;        // slow particles count for less than in proportion to their speed
const DEPTH_CUE: f32 = 2.0;          // e-folds of dimming across the attractor at full strength
const STREAK_LEN: f32 = 0.14;        // world units; streak length for volume-filling attractors
const DIVE_SOFTEN: f32 = 2.2;        // extra softening of every point at full dive
const BOKEH_SAMPLE_PX: f32 = 4.5;    // a particle blurred wider than this deposits several samples
const BOKEH_MAX_SAMPLES: u32 = 8u;
const MIN_COC_PER_850PX: f32 = 1.0;   // splat softness, scaled with the height of the frame

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash3(a: u32, b: u32, c: u32) -> u32 { return pcg(a ^ pcg(b ^ pcg(c))); }
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }

fn unit_vec(h: u32) -> vec3f {
  let z = 2.0 * u01(h) - 1.0;
  let a = TAU * u01(pcg(h));
  let s = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(s * cos(a), s * sin(a), z);
}

// Three independent standard normals (Box-Muller on hashed uniforms).
fn gauss3(h: u32) -> vec3f {
  let h1 = pcg(h);
  let h2 = pcg(h1);
  let a = sqrt(-2.0 * log(max(u01(h), 1e-6)));
  let b = sqrt(-2.0 * log(max(u01(h1), 1e-6)));
  return vec3f(a * cos(TAU * u01(h2)), a * sin(TAU * u01(h2)), b * cos(TAU * u01(pcg(h2))));
}

fn is_finite3(p: vec3f) -> bool {
  let m = vec3u(0x7f800000u);
  let b = bitcast<vec3u>(p) & m;
  return all(b != m);
}

// Vortex around the touch ray plus a push along the finger's motion.
fn stir_velocity(p: vec3f) -> vec3f {
  let strength = F.stir.z;
  if (strength <= 0.0) { return vec3f(0.0); }
  let d = p - F.eye.xyz;
  let t = dot(d, F.ray.xyz);
  if (t < 0.05) { return vec3f(0.0); }
  let o = d - t * F.ray.xyz;
  let sig = max(0.05, F.ray.w * t);
  let g = exp(-dot(o, o) / (2.0 * sig * sig));
  let swirl = cross(F.ray.xyz, o) / sig;
  let drag = (F.right.xyz * (F.stirv.x / F.right.w) + F.up.xyz * (F.stirv.y / F.up.w)) * t;
  return strength * g * (2.2 * swirl + 0.7 * clamp(drag, vec3f(-3.0), vec3f(3.0)));
}

// Round `x` to an integer without bias, so a faint weight spread over many samples survives.
fn stochastic(x: vec3f, h: u32) -> vec3<u32> {
  return vec3<u32>(x + vec3f(u01(h), u01(pcg(h)), u01(pcg(pcg(h)))));
}

// Project a world point and add it to the accumulation buffer at random spots inside its circle of
// confusion (stochastic depth of field). `col` is linear colour, `wgt` its particle weight. A
// particle blurred over many pixels deposits several samples, each with a share of the weight, so
// soft bokeh volumes fill in smoothly instead of speckling.
fn splat(pos: vec3f, col: vec3f, wgt0: f32, hj: u32) {
  let d = pos - F.eye.xyz;
  let cz = dot(d, F.fwd.xyz);
  if (cz < F.lens.z) { return; }
  // Depth cue: inside a volume-filling attractor (a labyrinth) every layer overlaps into fog, so
  // the far side is dimmed and the near filaments stand out. Zero strength leaves light untouched.
  let radius = max(F.probe.w, 0.2);
  let far = clamp((cz - F.lens.x + radius) / (2.0 * radius), 0.0, 1.0);
  // (the gain keeps the picture as bright overall as it was without the cue)
  let wgt = wgt0 * exp(DEPTH_CUE * F.tone.w * (0.35 - far));
  let cx = dot(d, F.right.xyz);
  let cy = dot(d, F.up.xyz);
  let ndc = vec2f(cx / cz * F.right.w, cy / cz * F.up.w);
  if (abs(ndc.x) > 2.0 || abs(ndc.y) > 2.0) { return; }
  let res = F.screen.xy;
  let centre = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * res;
  // in a dive even the in-focus particles are sparse, so every point is softened a little more
  let soft = MIN_COC_PER_850PX * max(0.75, res.y / 850.0) * (1.0 + DIVE_SOFTEN * F.stir.w);
  let coc = min(F.lens.y * abs(cz - F.lens.x) / cz, F.lens.w) + soft;
  let m = clamp(u32(ceil(coc / BOKEH_SAMPLE_PX)), 1u, BOKEH_MAX_SAMPLES);
  let each = max(col, vec3f(0.0)) * (wgt * FIXED / f32(m));
  let each_w = wgt * FIXED / f32(m);
  var h = hj;
  for (var k = 0u; k < m; k++) {
    let ang = TAU * u01(h);
    let px = centre + coc * sqrt(u01(pcg(h))) * vec2f(cos(ang), sin(ang));
    let hr = pcg(h ^ 0x68e31da4u);
    if (px.x >= 0.0 && px.y >= 0.0 && px.x < res.x && px.y < res.y) {
      let base = (u32(px.y) * u32(res.x) + u32(px.x)) * 4u;
      let c = stochastic(each, hr);
      atomicAdd(&accum[base], c.x);
      atomicAdd(&accum[base + 1u], c.y);
      atomicAdd(&accum[base + 2u], c.z);
      atomicAdd(&accum[base + 3u], stochastic(vec3f(each_w), hr ^ 0x1b873593u).x);
    }
    h = pcg(hr);
  }
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 64u;
  if (i >= F.ids.y) { return; }
  let frame = F.ids.x;
  let seed = F.ids.z;
  let dt = F.screen.z;

  let q = parts[i];
  var p = q.xyz;
  var born = q.w;  // simulation time at which this particle last (re)spawned

  // respawn: initial fill, escaped or NaN, and a steady trickle so streams keep flowing in
  let init = (F.ids.w & 1u) != 0u;
  let h0 = hash3(i, frame, seed);
  if (init || !is_finite3(p) || dot(p, p) > ESCAPE_R2 || u01(h0) < TRICKLE_PER_SECOND * dt) {
    let h1 = hash3(i, frame * 3u + 1u, seed);
    let dir = unit_vec(h1);
    let r = SPAWN_RADIUS * pow(u01(hash3(i, frame * 3u + 2u, seed)), 1.0 / 3.0);
    p = dir * r;
    // the initial cloud gets staggered ages, so the first frames are not all newborn
    born = F.screen.w - select(0.0, 8.0 * u01(hash3(i, 0x2545f491u, seed)), init);

    // In a volume-filling attractor (misc.w > 0) most respawns copy a settled particle instead.
    // Thomas' flow is a near-conservative lattice; folded through it, the hard edge of a freshly
    // seeded ball becomes a faint periodic weave (about 2 % of the density), and injecting a new
    // ball every second keeps it alive. Copying the cloud itself injects no new edge, so the
    // population stays the attractor's own measure and the weave decays instead.
    if (!init && u01(hash3(i, frame * 3u + 5u, seed)) < F.misc.w) {
      let src = parts[hash3(i, frame * 3u + 6u, seed) % F.ids.y];
      if (is_finite3(src.xyz) && dot(src.xyz, src.xyz) < 1.96 && F.screen.w - src.w > SETTLED_END) {
        p = src.xyz + CLONE_JITTER * gauss3(hash3(i, frame * 3u + 7u, seed));
        born = F.screen.w - 1.2 * SETTLED_END;
      }
    }
  }
  let age = F.screen.w - born;
  // stable per particle for its whole life, redrawn at every respawn
  let phase = u01(hash3(i, bitcast<u32>(born), seed));

  // shake: every particle is flung outward along its own hashed direction; the law pulls it back
  var extra = vec3f(0.0);
  let shake = F.stirv.z;
  if (shake > 0.001) {
    let rd = unit_vec(hash3(i, bitcast<u32>(F.stirv.w), seed));
    let outward = p / max(length(p), 0.05);
    extra = (0.55 * rd + 0.75 * outward) * shake * 2.0;
  }

  let p_before = p;

  // RK2 midpoint; the host picks enough substeps to keep each at or under 0.03 world time
  let steps = i32(F.misc.y);
  let h = dt / f32(steps);
  var speed = 0.0;
  for (var s = 0; s < steps; s++) {
    let k1 = f_world_of(law, p) + stir_velocity(p) + extra;
    if (s == 0) { speed = length(k1); }
    let pm = p + 0.5 * h * k1;
    let k2 = f_world_of(law, pm) + stir_velocity(pm) + extra;
    p += h * k2;
  }
  parts[i] = vec4f(p, born);

  // extent: see HIST_BINS
  let stride = u32(F.misc.z);
  if (!init && age > SETTLED_END && i % stride == 0u) {
    let f = vec3i(round(p * POS_FIXED));
    atomicAdd(&extent[0], 1u);
    atomicAdd(&extent[1], bitcast<u32>(f.x));
    atomicAdd(&extent[2], bitcast<u32>(f.y));
    atomicAdd(&extent[3], bitcast<u32>(f.z));
    let bin = min(u32(length(p - F.probe.xyz) * (f32(HIST_BINS) / HIST_RANGE)), HIST_BINS - 1u);
    atomicAdd(&extent[4u + bin], 1u);
    let sbin = u32(clamp((log2(max(speed, 1e-4)) - SPEED_BASE) * SPEED_PER_OCTAVE, 0.0, f32(SPEED_BINS - 1u)));
    atomicAdd(&extent[4u + HIST_BINS + sbin], 1u);
  }

  if ((F.ids.w & 2u) == 0u) { return; }

  // Draw at a random point of the path just travelled: free motion blur. In a volume-filling
  // attractor the flow is slow and the light a fog of dots, so each particle is drawn as a short
  // streak of fixed length instead, and the fog resolves into flow lines.
  let hj = hash3(i, frame, seed ^ 0x9e3779b9u);
  let step_v = p - p_before;
  let step_len = length(step_v);
  let streak = mix(step_len, max(step_len, STREAK_LEN), F.tone.w);
  let q_draw = p - step_v / max(step_len, 1e-6) * (streak * u01(pcg(hj ^ 0x85ebca6bu)));
  let cz = dot(q_draw - F.eye.xyz, F.fwd.xyz);
  let depth = cz - F.lens.x;

  let settled = smoothstep(SETTLED_START, SETTLED_END, age);
  // In a volume-filling attractor the flow field is a periodic lattice (Thomas: sin x, sin y, sin z),
  // so colouring by speed would print that lattice onto the fog as regular bands. There the hue
  // comes from the typical speed instead, and the depth cue and streaks carry the structure.
  let shown_speed = mix(speed, F.tone.x, F.tone.w);
  let calm = mix(REFERENCE_SPEED, shown_speed, settled);
  let col = shade(calm, phase, depth, F.misc.x);
  let tracer = u01(hash3(i, 0x5bd1e995u, seed)) < TRACER_FRACTION && settled < 1.0;
  // Dwell equalisation: an extended attractor piles particles up where the flow is slow (near its
  // saddles and foci), which would burn a star-like hotspot into the picture. Weighting a
  // particle by its speed relative to the typical one turns dwell time into arc length. A true
  // fixed point is one cloud of equally slow particles, so it is left alone (tone.y = 0).
  let slow = clamp(speed / max(F.tone.x, 1e-3), 0.0, 1.0);
  let dwell = mix(1.0, max(pow(slow, DWELL_POWER), F.tone.z), F.tone.y);
  let wgt = mix(select(DUST_WEIGHT, TRACER_WEIGHT, tracer), dwell, settled);
  splat(q_draw, col, wgt, hj);

  if (tracer) {
    // a comet tail: the recent path, walked backward along the flow, fading with age
    // (each sample lands at a random spot on its segment, so successive frames fill the line in)
    var pb = q_draw;
    for (var k = 1; k <= TAIL_STEPS; k++) {
      let next = pb - f_world_of(law, pb) * TAIL_DT;
      let hk = pcg(hj + u32(k) * 0x9e3779b9u);
      let fade = 1.0 - (f32(k) - u01(hk)) / f32(TAIL_STEPS + 1);
      splat(mix(pb, next, u01(pcg(hk))), col, wgt * fade * fade, hk);
      pb = next;
    }
  }
}
