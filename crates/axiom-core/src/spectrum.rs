//! Lyapunov spectrum (Benettin, 3 tangent vectors, modified Gram–Schmidt),
//! Kaplan–Yorke dimension and the regime code — DESIGN.md §3.4.

use crate::anchors::{dot, mat_vec, norm, System, M3, V3};
use crate::law::Law;
use crate::rng::Rng;

/// Regime-boundary tolerance (world units of exponent).
pub const EPS: f64 = 0.01;
/// Exponential forgetting time constant in world-time units.
pub const FORGET: f64 = 10.0;
/// Tangent vectors are re-orthonormalised at least this often (time units).
const RENORM_DT: f64 = 0.05;
/// Internal RK4 step for the world field.
pub const WORLD_DT: f64 = 0.01;

pub const FIXED: u8 = 0;
pub const CYCLE: u8 = 1;
pub const TORUS: u8 = 2;
pub const STRANGE: u8 = 3;
pub const LABYRINTH: u8 = 4;

type State = [V3; 4]; // x, then three tangent vectors

fn deriv<S: System>(s: &S, st: &State) -> State {
    let f = s.field(st[0]);
    let j: M3 = s.jac(st[0]);
    [
        f,
        mat_vec(&j, st[1]),
        mat_vec(&j, st[2]),
        mat_vec(&j, st[3]),
    ]
}

fn advanced(a: &State, k: &State, h: f64) -> State {
    let mut o = *a;
    for i in 0..4 {
        for c in 0..3 {
            o[i][c] += h * k[i][c];
        }
    }
    o
}

fn rk4<S: System>(s: &S, st: &State, h: f64) -> State {
    let k1 = deriv(s, st);
    let k2 = deriv(s, &advanced(st, &k1, 0.5 * h));
    let k3 = deriv(s, &advanced(st, &k2, 0.5 * h));
    let k4 = deriv(s, &advanced(st, &k3, h));
    let mut o = *st;
    for i in 0..4 {
        for c in 0..3 {
            o[i][c] += h / 6.0 * (k1[i][c] + 2.0 * k2[i][c] + 2.0 * k3[i][c] + k4[i][c]);
        }
    }
    o
}

/// Benettin's algorithm with optional exponential forgetting.
///
/// The per-interval growth rates are smoothed by two cascaded one-pole filters
/// (each of time constant `forget / 2`). A single pole would leave an O(1/T)
/// ripple in the flow-direction exponent of a limit cycle that is larger than
/// the regime tolerance; the cascade suppresses it by another factor ~ω·T/2.
#[derive(Clone)]
pub struct Benettin {
    pub x: V3,
    q: [V3; 3],
    /// Stage-1 / stage-2 filtered growth rates.
    e1: [f64; 3],
    e2: [f64; 3],
    count: u64,
    since: f64,
    /// 0 = infinite memory (plain running mean).
    forget: f64,
}

impl Benettin {
    pub fn new(x: V3, forget: f64) -> Self {
        Benettin {
            x,
            q: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            e1: [0.0; 3],
            e2: [0.0; 3],
            count: 0,
            since: 0.0,
            forget,
        }
    }

    /// Restart the trajectory (keeps nothing of the old exponents).
    pub fn reset(&mut self, x: V3) {
        *self = Benettin::new(x, self.forget);
    }

    /// Integrate `steps` RK4 steps of size `dt`.
    pub fn advance<S: System>(&mut self, sys: &S, dt: f64, steps: usize) {
        for _ in 0..steps {
            let st = rk4(sys, &[self.x, self.q[0], self.q[1], self.q[2]], dt);
            self.x = st[0];
            self.q = [st[1], st[2], st[3]];
            self.since += dt;
            if self.since >= RENORM_DT - 1e-12 {
                self.renormalise();
            }
        }
    }

    fn renormalise(&mut self) {
        let mut g = [0.0; 3];
        for i in 0..3 {
            for j in 0..i {
                let d = dot(self.q[i], self.q[j]);
                for c in 0..3 {
                    self.q[i][c] -= d * self.q[j][c];
                }
            }
            let n = norm(self.q[i]).max(1e-300);
            for c in 0..3 {
                self.q[i][c] /= n;
            }
            g[i] = n.ln() / self.since;
        }
        self.count += 1;
        let running = 1.0 / self.count as f64;
        let rate = if self.forget > 0.0 {
            running.max(1.0 - (-self.since / (0.5 * self.forget)).exp())
        } else {
            running
        };
        for i in 0..3 {
            self.e1[i] += rate * (g[i] - self.e1[i]);
            self.e2[i] += rate * (self.e1[i] - self.e2[i]);
        }
        self.since = 0.0;
    }

    /// Current exponent estimates, sorted descending.
    pub fn exponents(&self) -> [f64; 3] {
        let mut l = if self.forget > 0.0 { self.e2 } else { self.e1 };
        l.sort_by(|a, b| b.total_cmp(a));
        l
    }

    pub fn healthy(&self) -> bool {
        self.x.iter().all(|v| v.is_finite() && v.abs() < 1e6)
            && self.q.iter().all(|v| v.iter().all(|c| c.is_finite()))
    }
}

/// Kaplan–Yorke dimension of a descending spectrum. Exponents within `EPS`
/// of zero are treated as zero so a cycle reads exactly 1 and a torus 2.
pub fn kaplan_yorke(l: [f64; 3]) -> f64 {
    let snap = |v: f64| if v.abs() <= EPS { 0.0 } else { v };
    let l = [snap(l[0]), snap(l[1]), snap(l[2])];
    let mut sum = 0.0;
    let mut j = 0;
    for v in l {
        if sum + v >= 0.0 {
            sum += v;
            j += 1;
        } else {
            break;
        }
    }
    match j {
        0 => 0.0,
        3 => 3.0,
        _ => j as f64 + sum / l[j].abs(),
    }
}

/// Regime code from a descending spectrum and its dimension.
pub fn regime(l: [f64; 3], d: f64) -> u8 {
    if l[0] < -EPS {
        FIXED
    } else if l[0] <= EPS {
        if l[1] < -EPS {
            CYCLE
        } else {
            TORUS
        }
    } else if d < 2.7 {
        STRANGE
    } else {
        LABYRINTH
    }
}

/// The live spectrum tracker: one tracer particle in the world field.
pub struct Spectrum {
    bet: Benettin,
    rng: Rng,
}

impl Spectrum {
    pub fn new(seed: u32) -> Self {
        let mut rng = Rng::new(seed, 7);
        let x = rng.in_ball(0.6);
        Spectrum {
            bet: Benettin::new(x, FORGET),
            rng,
        }
    }

    /// Integrate `world_time` of the current law (RK4, dt ≤ 0.01).
    pub fn step(&mut self, law: &Law, world_time: f64) {
        if world_time.is_nan() || world_time <= 0.0 {
            return;
        }
        let steps = (world_time / WORLD_DT).ceil().clamp(1.0, 400.0) as usize;
        self.bet.advance(law, world_time / steps as f64, steps);
        if !self.bet.healthy() {
            let x = self.rng.in_ball(0.6);
            self.bet.reset(x);
        }
    }

    /// `[λ1, λ2, λ3, D, regime, x, y, z]`
    pub fn read(&self) -> [f32; 8] {
        let l = self.bet.exponents();
        let d = kaplan_yorke(l);
        let x = self.bet.x;
        [
            l[0] as f32,
            l[1] as f32,
            l[2] as f32,
            d as f32,
            regime(l, d) as f32,
            x[0] as f32,
            x[1] as f32,
            x[2] as f32,
        ]
    }
}
