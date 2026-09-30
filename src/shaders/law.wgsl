// The world field F(x) of DESIGN §3.2, evaluated from the 68-float LawParams block (§3.3).
// Rust owns every number; this file only evaluates formulas. Only active slots are evaluated.

struct Slot {
  a: vec4f,   // kind, weight, tau, L
  c: vec4f,   // cx, cy, cz, omega
  p0: vec4f,  // p0..p3
  p1: vec4f,  // p4..p7
  r0: vec4f,  // R column 0
  r1: vec4f,  // R column 1
  r2: vec4f,  // R column 2
  pad: vec4f,
}

struct Law {
  header: vec4f,  // r, theta, kappa, confine_radius
  s0: Slot,
  s1: Slot,
}

@group(0) @binding(0) var<uniform> law: Law;

const CONFINE_K: f32 = 8.0;

fn f_kind(kind: i32, x: vec3f, p0: vec4f, p1: vec4f) -> vec3f {
  var f = vec3f(0.0);
  switch kind {
    case 0: { // Thomas: b
      let b = p0.x;
      f = vec3f(sin(x.y) - b * x.x, sin(x.z) - b * x.y, sin(x.x) - b * x.z);
    }
    case 1: { // Aizawa / Langford: alpha beta gamma delta epsilon zeta
      let zb = x.z - p0.y;
      let r2 = x.x * x.x + x.y * x.y;
      f = vec3f(
        zb * x.x - p0.w * x.y,
        p0.w * x.x + zb * x.y,
        p0.z + p0.x * x.z - x.z * x.z * x.z / 3.0 - r2 * (1.0 + p1.x * x.z) + p1.y * x.z * x.x * x.x * x.x,
      );
    }
    case 2: { // Lorenz: sigma rho beta
      f = vec3f(p0.x * (x.y - x.x), x.x * (p0.y - x.z) - x.y, x.x * x.y - p0.z * x.z);
    }
    case 3: { // Rossler: a b c
      f = vec3f(-x.y - x.z, x.x + p0.x * x.y, p0.y + x.z * (x.x - p0.z));
    }
    case 4: { // Halvorsen: a
      let a = p0.x;
      f = vec3f(
        -a * x.x - 4.0 * x.y - 4.0 * x.z - x.y * x.y,
        -a * x.y - 4.0 * x.z - 4.0 * x.x - x.z * x.z,
        -a * x.z - 4.0 * x.x - 4.0 * x.y - x.x * x.x,
      );
    }
    default: {}
  }
  return f;
}

fn slot_field(s: Slot, x: vec3f) -> vec3f {
  let kind = i32(round(s.a.x));
  let w = s.a.y;
  if (kind < 0 || w <= 0.0) { return vec3f(0.0); }
  let R = mat3x3f(s.r0.xyz, s.r1.xyz, s.r2.xyz);
  let xs = s.c.xyz + s.a.w * (R * x);
  let f = f_kind(kind, xs, s.p0, s.p1);
  return w * (s.a.z / s.a.w) * (transpose(R) * f);
}

fn f_world(x: vec3f) -> vec3f {
  var f = slot_field(law.s0, x) + slot_field(law.s1, x);
  f -= law.header.z * x;
  let m = length(x);
  if (m > law.header.w) {
    let e = m - law.header.w;
    f -= CONFINE_K * e * e * (x / m);
  }
  return f;
}
