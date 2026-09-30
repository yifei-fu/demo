//! The law: seeded anchor placement, blending weights, the `LawParams` block
//! (DESIGN.md §3.3) and the world field it defines (§3.2).

use crate::anchors::{self, dot, System, KIND_COUNT, M3, V3};
use crate::rng::Rng;
use crate::tables::{self, ANCHORS, KAPPA0, KAPPA_R};
use std::f64::consts::TAU;

pub const PARAMS_LEN: usize = 68;
const HEADER_LEN: usize = 4;
const SLOT_LEN: usize = 32;
pub const ANCHOR_COUNT: usize = ANCHORS.len();
/// Confinement stiffness K and default radius R_c (§3.2).
pub const K_CONFINE: f64 = 8.0;
pub const CONFINE_RADIUS: f64 = 1.2;
/// Fraction of the arc between two neighbouring anchors over which they mix.
pub const BLEND_WIDTH: f64 = 0.4;

/// One active anchor in world space: `x_sys = c + L · R · x`.
#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub kind: usize,
    pub weight: f64,
    pub tau: f64,
    pub l: f64,
    pub c: V3,
    pub omega: f64,
    pub p: [f64; 8],
    /// Columns of R.
    pub cols: [V3; 3],
}

/// The world field: at most two blended anchors plus damping and confinement.
#[derive(Clone, Copy, Debug)]
pub struct Law {
    pub r: f64,
    pub theta: f64,
    pub kappa: f64,
    pub confine: f64,
    pub slots: [Option<Slot>; 2],
}

impl Law {
    /// Parse a 68-float block. Anything malformed becomes an empty slot.
    pub fn from_block(b: &[f32]) -> Law {
        let f = |i: usize| b.get(i).copied().unwrap_or(0.0) as f64;
        let slot = |o: usize| -> Option<Slot> {
            let kind = f(o);
            if !(0.0..KIND_COUNT as f64).contains(&kind) {
                return None;
            }
            let mut p = [0.0; 8];
            for (i, v) in p.iter_mut().enumerate() {
                *v = f(o + 8 + i);
            }
            let col = |k: usize| [f(o + 16 + 4 * k), f(o + 17 + 4 * k), f(o + 18 + 4 * k)];
            Some(Slot {
                kind: kind as usize,
                weight: f(o + 1),
                tau: f(o + 2),
                l: f(o + 3).max(1e-6),
                c: [f(o + 4), f(o + 5), f(o + 6)],
                omega: f(o + 7),
                p,
                cols: [col(0), col(1), col(2)],
            })
        };
        Law {
            r: f(0),
            theta: f(1),
            kappa: f(2),
            confine: f(3),
            slots: [slot(HEADER_LEN), slot(HEADER_LEN + SLOT_LEN)],
        }
    }

    /// Weight-blended characteristic angular frequency (world time).
    pub fn omega(&self) -> f64 {
        let mut num = 0.0;
        let mut den = 0.0;
        for s in self.slots.iter().flatten() {
            num += s.weight * s.omega;
            den += s.weight;
        }
        if den > 1e-9 {
            num / den
        } else {
            1.5
        }
    }
}

impl System for Law {
    fn field(&self, x: V3) -> V3 {
        let mut f = [-self.kappa * x[0], -self.kappa * x[1], -self.kappa * x[2]];
        for s in self.slots.iter().flatten() {
            let mut xs = s.c;
            for (col, xi) in s.cols.iter().zip(x) {
                for k in 0..3 {
                    xs[k] += s.l * xi * col[k];
                }
            }
            let fk = anchors::field(s.kind, &s.p, xs);
            let g = s.weight * s.tau / s.l;
            for (i, col) in s.cols.iter().enumerate() {
                f[i] += g * dot(*col, fk);
            }
        }
        let rho = anchors::norm(x);
        if rho > self.confine && rho > 0.0 {
            let k = K_CONFINE * (rho - self.confine).powi(2) / rho;
            for i in 0..3 {
                f[i] -= k * x[i];
            }
        }
        f
    }

    /// `J = Σ w τ Rᵀ J_kind R − κ I − J_confine`
    fn jac(&self, x: V3) -> M3 {
        let mut j = [[0.0; 3]; 3];
        for (i, row) in j.iter_mut().enumerate() {
            row[i] = -self.kappa;
        }
        for s in self.slots.iter().flatten() {
            let mut xs = s.c;
            for (col, xi) in s.cols.iter().zip(x) {
                for k in 0..3 {
                    xs[k] += s.l * xi * col[k];
                }
            }
            let jk = anchors::jac(s.kind, &s.p, xs);
            let g = s.weight * s.tau;
            // (Rᵀ Jk R)_{ab} = col_a · (Jk col_b)
            for (b, col_b) in s.cols.iter().enumerate() {
                let jc = anchors::mat_vec(&jk, *col_b);
                for (row, col_a) in j.iter_mut().zip(&s.cols) {
                    row[b] += g * dot(*col_a, jc);
                }
            }
        }
        let rho = anchors::norm(x);
        if rho > self.confine && rho > 0.0 {
            let e = rho - self.confine;
            let radial = 2.0 * K_CONFINE * e;
            let tangential = K_CONFINE * e * e / rho;
            for a in 0..3 {
                for b in 0..3 {
                    let nn = x[a] * x[b] / (rho * rho);
                    let delta = if a == b { 1.0 } else { 0.0 };
                    j[a][b] -= radial * nn + tangential * (delta - nn);
                }
            }
        }
        j
    }
}

/// Seeded arrangement of the anchors around the rim.
pub struct Placement {
    pub theta0: f64,
    /// Rim order: `order[i]` is the kind sitting at angle `theta0 + τ i / N`.
    pub order: [usize; ANCHOR_COUNT],
    /// Rotation (as columns) per kind id.
    pub rot: [[V3; 3]; KIND_COUNT],
}

impl Placement {
    pub fn new(seed: u32) -> Placement {
        let mut rng = Rng::new(seed, 1);
        let theta0 = rng.range(0.0, TAU);
        let mut order = ANCHORS;
        for i in (1..ANCHOR_COUNT).rev() {
            order.swap(i, rng.below(i + 1));
        }
        let mut rot = [[[0.0; 3]; 3]; KIND_COUNT];
        for m in rot.iter_mut() {
            *m = damped_random_rotation(&mut rng);
        }
        Placement { theta0, order, rot }
    }

    /// Rim angle of a kind (radians, in [0, 2π)); `None` for a kind that has
    /// no anchor.
    pub fn angle_of(&self, kind: usize) -> Option<f64> {
        let i = self.order.iter().position(|&k| k == kind)?;
        Some((self.theta0 + TAU * i as f64 / ANCHOR_COUNT as f64).rem_euclid(TAU))
    }

    /// The two active `(kind, weight)` pairs at angle `theta`.
    pub fn weights(&self, theta: f64) -> [(usize, f64); 2] {
        let seg = TAU / ANCHOR_COUNT as f64;
        let a = (theta - self.theta0).rem_euclid(TAU) / seg;
        let i = (a.floor() as usize).min(ANCHOR_COUNT - 1);
        // Anchors dominate the outer part of their arcs; the two only mix in the
        // middle `BLEND_WIDTH` of the arc between them.
        let s = smootherstep(((a - i as f64) - 0.5) / BLEND_WIDTH + 0.5);
        [
            (self.order[i], 1.0 - s),
            (self.order[(i + 1) % ANCHOR_COUNT], s),
        ]
    }
}

pub fn smootherstep(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Random unit quaternion, slerped halfway to identity (keeps things "upright"),
/// returned as the columns of the rotation matrix.
fn damped_random_rotation(rng: &mut Rng) -> [V3; 3] {
    let mut q = [rng.gauss(), rng.gauss(), rng.gauss(), rng.gauss()];
    let n = q.iter().map(|v| v * v).sum::<f64>().sqrt().max(1e-9);
    for v in q.iter_mut() {
        *v /= n;
    }
    if q[0] < 0.0 {
        for v in q.iter_mut() {
            *v = -*v;
        }
    }
    // angle/2 = acos(w); halve it.
    let half = q[0].clamp(-1.0, 1.0).acos();
    let s = (q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    let (w, v) = if s < 1e-9 {
        (1.0, [0.0; 3])
    } else {
        let k = (0.5 * half).sin() / s;
        ((0.5 * half).cos(), [q[1] * k, q[2] * k, q[3] * k])
    };
    quat_columns(w, v)
}

fn quat_columns(w: f64, [x, y, z]: V3) -> [V3; 3] {
    [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y + w * z),
            2.0 * (x * z - w * y),
        ],
        [
            2.0 * (x * y - w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z + w * x),
        ],
        [
            2.0 * (x * z + w * y),
            2.0 * (y * z - w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ]
}

/// Centre damping κ(r) = κ0 (1 − r/r_κ)² for r < r_κ, else 0. It is what
/// makes r = 0 a stable fixed point for *every* blend of anchors: rotating and
/// mixing non-normal Jacobians can destabilise them, but a κ larger than every
/// anchor's largest symmetric-part eigenvalue cannot be beaten.
pub fn kappa(r: f64) -> f64 {
    KAPPA0 * (1.0 - r / KAPPA_R).max(0.0).powi(2)
}

/// Fill one 32-float slot.
fn write_slot(out: &mut [f32], kind: usize, weight: f64, r: f64, rot: &[V3; 3]) {
    let s = tables::sample(kind, r);
    out[0] = kind as f32;
    out[1] = weight as f32;
    out[2] = s.tau;
    out[3] = s.l;
    out[4..7].copy_from_slice(&s.c);
    out[7] = s.omega;
    out[8..16].copy_from_slice(&s.p);
    for (k, col) in rot.iter().enumerate() {
        for (i, v) in col.iter().enumerate() {
            out[16 + 4 * k + i] = *v as f32;
        }
    }
}

/// Write the 68-float `LawParams` block for the parameter-disk point (u, v).
pub fn write_params(u: f32, v: f32, seed: u32, out: &mut [f32]) {
    assert!(out.len() >= PARAMS_LEN);
    out[..PARAMS_LEN].fill(0.0);
    let (mut u, mut v) = (u as f64, v as f64);
    if !u.is_finite() || !v.is_finite() {
        (u, v) = (0.0, 0.0);
    }
    let mut r = u.hypot(v);
    if r > 1.0 {
        (u, v, r) = (u / r, v / r, 1.0);
    }
    let theta = v.atan2(u);
    let pl = Placement::new(seed);
    out[0] = r as f32;
    out[1] = theta as f32;
    out[2] = kappa(r) as f32;
    out[3] = CONFINE_RADIUS as f32;
    for (i, (kind, w)) in pl.weights(theta).into_iter().enumerate() {
        let o = HEADER_LEN + i * SLOT_LEN;
        write_slot(&mut out[o..o + SLOT_LEN], kind, w, r, &pl.rot[kind]);
    }
}

/// A single anchor, unrotated, at weight 1, with the standard κ(r): the
/// pure route, for inspecting an anchor without any blending.
pub fn pure_law(kind: usize, r: f64) -> Law {
    pure_law_with(kind, r, &tables::sample(kind, r), kappa(r))
}

/// Same from an explicit route sample and damping (the calibration tool
/// checks rows it has not saved yet).
pub fn pure_law_with(kind: usize, r: f64, s: &tables::Sample, kappa: f64) -> Law {
    let mut p = [0.0; 8];
    for (d, v) in p.iter_mut().zip(s.p) {
        *d = v as f64;
    }
    Law {
        r,
        theta: 0.0,
        kappa,
        confine: CONFINE_RADIUS,
        slots: [
            Some(Slot {
                kind,
                weight: 1.0,
                tau: s.tau as f64,
                l: s.l as f64,
                c: s.c.map(|v| v as f64),
                omega: s.omega as f64,
                p,
                cols: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            }),
            None,
        ],
    }
}
