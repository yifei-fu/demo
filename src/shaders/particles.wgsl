// One fused kernel per frame: integrate (RK2, 2 substeps), stir/shake forces, respawn, then
// project and splat into the fixed-point accumulation buffer with stochastic depth of field.
// (law.wgsl and shade.wgsl are concatenated in front of this file.)

struct Frame {
  right: vec4f,   // xyz, focal_x     (ndc.x = cam.x / cam.z * focal_x)
  up: vec4f,      // xyz, focal_y
  fwd: vec4f,     // xyz, unused
  eye: vec4f,     // xyz, unused
  ray: vec4f,     // xyz stir ray direction, w = stir radius in tan units
  screen: vec4f,  // width, height, dt, time
  lens: vec4f,    // focus distance, aperture (px), near plane, max CoC (px)
  stir: vec4f,    // touch ndc x, y, strength, unused
  stirv: vec4f,   // touch ndc velocity x, y, shake energy, shake id
  tint: vec4f,    // palette shift, unused...
  ids: vec4u,     // frame, count, seed, flags (bit 0: initialise, bit 1: splat)
}

@group(0) @binding(0) var<uniform> law: Law;
@group(0) @binding(1) var<uniform> F: Frame;
@group(0) @binding(2) var<storage, read_write> parts: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> accum: array<atomic<u32>>;

const FIXED: f32 = 256.0;
const TAU: f32 = 6.2831853;
const SPAWN_RADIUS: f32 = 1.2;
const ESCAPE_R2: f32 = 9.0;
const TRICKLE_PER_SECOND: f32 = 0.12;   // 0.2 % per frame at 60 fps
const TRACER_FRACTION: f32 = 0.004;  // a few particles burn much brighter and draw visible streams
const TRACER_WEIGHT: f32 = 22.0;
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

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * 64u;
  if (i >= F.ids.y) { return; }
  let frame = F.ids.x;
  let seed = F.ids.z;
  let dt = F.screen.z;

  var q = parts[i];
  var p = q.xyz;
  var phase = q.w;

  // respawn: initial fill, escaped or NaN, and a steady trickle so streams keep flowing in
  let init = (F.ids.w & 1u) != 0u;
  let h0 = hash3(i, frame, seed);
  if (init || !is_finite3(p) || dot(p, p) > ESCAPE_R2 || u01(h0) < TRICKLE_PER_SECOND * dt) {
    let h1 = hash3(i, frame * 3u + 1u, seed);
    let dir = unit_vec(h1);
    let r = SPAWN_RADIUS * pow(u01(hash3(i, frame * 3u + 2u, seed)), 1.0 / 3.0);
    p = dir * r;
    phase = u01(hash3(i, frame * 3u + 3u, seed));
  }

  // shake: every particle is flung outward along its own hashed direction; the law pulls it back
  var extra = vec3f(0.0);
  let shake = F.stirv.z;
  if (shake > 0.001) {
    let rd = unit_vec(hash3(i, bitcast<u32>(F.stirv.w), seed));
    let outward = p / max(length(p), 0.05);
    extra = (0.55 * rd + 0.75 * outward) * shake * 2.0;
  }

  let p_before = p;

  // RK2 midpoint, two substeps of dt/2
  let h = 0.5 * dt;
  var speed = 0.0;
  for (var s = 0; s < 2; s++) {
    let k1 = f_world_of(law, p) + stir_velocity(p) + extra;
    if (s == 0) { speed = length(k1); }
    let pm = p + 0.5 * h * k1;
    let k2 = f_world_of(law, pm) + stir_velocity(pm) + extra;
    p += h * k2;
  }
  parts[i] = vec4f(p, phase);

  if ((F.ids.w & 2u) == 0u) { return; }

  // draw at a random moment inside the frame: free motion blur that turns fast dust into streaks
  let hj = hash3(i, frame, seed ^ 0x9e3779b9u);
  let q_draw = mix(p_before, p, u01(pcg(hj ^ 0x85ebca6bu)));

  // project
  let d = q_draw - F.eye.xyz;
  let cz = dot(d, F.fwd.xyz);
  if (cz < F.lens.z) { return; }
  let cx = dot(d, F.right.xyz);
  let cy = dot(d, F.up.xyz);
  let ndc = vec2f(cx / cz * F.right.w, cy / cz * F.up.w);
  if (abs(ndc.x) > 2.0 || abs(ndc.y) > 2.0) { return; }
  let res = F.screen.xy;
  var px = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * res;

  // stochastic depth of field: land at a random point inside the circle of confusion
  let coc = min(F.lens.y * abs(cz - F.lens.x) / cz, F.lens.w) + MIN_COC_PER_850PX * max(0.75, res.y / 850.0);
  let ang = TAU * u01(hj);
  px += coc * sqrt(u01(pcg(hj))) * vec2f(cos(ang), sin(ang));
  if (px.x < 0.0 || px.y < 0.0 || px.x >= res.x || px.y >= res.y) { return; }

  let base = (u32(px.y) * u32(res.x) + u32(px.x)) * 4u;
  let wgt = select(1.0, TRACER_WEIGHT, phase < TRACER_FRACTION);
  let col = max(shade(speed, phase, cz - F.lens.x), vec3f(0.0)) * (wgt * FIXED);
  atomicAdd(&accum[base], u32(col.r));
  atomicAdd(&accum[base + 1u], u32(col.g));
  atomicAdd(&accum[base + 2u], u32(col.b));
  atomicAdd(&accum[base + 3u], u32(wgt * FIXED));
}
