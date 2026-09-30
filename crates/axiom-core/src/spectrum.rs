//! Lyapunov spectrum (Benettin, 3 tangent vectors, modified Gram–Schmidt),
//! Kaplan–Yorke dimension and the regime code — DESIGN.md §3.4.
//!
//! **Benettin.** A tracer `x` and three tangent vectors are integrated
//! together, `ẋ = F(x)`, `q̇ᵢ = J(x) qᵢ`. Every 0.05 time units the frame is
//! re-orthonormalised by modified Gram–Schmidt and the log stretch of each
//! vector, `ln‖qᵢ‖ / Δt`, is the growth rate of that direction over the
//! interval. Their exponentially forgotten averages are the Lyapunov exponents
//! λ₁ ≥ λ₂ ≥ λ₃ of the *current* law (memory ≈ 10 time units for the reported
//! λ so it follows navigation; 40 for the dimension and regime so the label is
//! steady).
//!
//! **Kaplan–Yorke.** `D = j + (λ₁ + … + λⱼ) / |λⱼ₊₁|`, `j` the largest count
//! whose partial sum is non-negative. Exponents within ε of zero are snapped
//! to 0, so a limit cycle (0, −, −) reads exactly 1, a torus (0, 0, −) exactly 2
//! and chaos lies in between 2 and 3.
//!
//! **Regime.** λ₁ < −ε is a fixed point; |λ₁| ≤ ε a cycle (λ₂ < −ε) or a
//! torus; λ₁ > ε strange chaos (D < 2.7) or, when it fills volume (D ≥ 2.7),
//! a labyrinth. A tracer that has actually stopped is a fixed point whatever
//! its finite-time exponents still remember.

use crate::anchors::{dot, mat_vec, norm, System, M3, V3};
use crate::law::Law;
use crate::rng::Rng;

/// Regime-boundary tolerance (world units of exponent).
pub const EPS: f64 = 0.01;
/// Exponential forgetting time constants in world-time units: the reported
/// exponents track navigation (≈ 10 per the spec); dimension and regime need a
/// longer memory to be steady.
pub const FORGET: f64 = 10.0;
pub const FORGET_SLOW: f64 = 40.0;
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

/// Smoothing of the per-interval growth rates: two cascaded one-pole filters
/// (each of time constant `forget / 2`), or a plain running mean when
/// `forget == 0`. A single pole would leave an O(1/T) ripple in the
/// flow-direction exponent of a limit cycle that is larger than the regime
/// tolerance; the cascade suppresses it by another factor ~ω·T/2.
#[derive(Clone, Copy)]
struct Filter {
    forget: f64,
    e1: [f64; 3],
    e2: [f64; 3],
}

impl Filter {
    fn new(forget: f64) -> Self {
        Filter {
            forget,
            e1: [0.0; 3],
            e2: [0.0; 3],
        }
    }

    /// `count` is the number of updates so far (including this one): early on
    /// the filter is a running mean, so it starts unbiased.
    fn update(&mut self, g: [f64; 3], dt: f64, count: u64) {
        let running = 1.0 / count as f64;
        let rate = if self.forget > 0.0 {
            running.max(1.0 - (-dt / (0.5 * self.forget)).exp())
        } else {
            running
        };
        for (i, gi) in g.iter().enumerate() {
            self.e1[i] += rate * (gi - self.e1[i]);
            self.e2[i] += rate * (self.e1[i] - self.e2[i]);
        }
    }

    fn value(&self) -> [f64; 3] {
        let mut l = if self.forget > 0.0 { self.e2 } else { self.e1 };
        l.sort_by(|a, b| b.total_cmp(a));
        l
    }
}

/// Benettin's algorithm: RK4 of the flow and three tangent vectors,
/// re-orthonormalised (modified Gram–Schmidt) every 0.05 time units. The
/// growth rates feed two `Filter`s with independent memory lengths so that
/// callers can trade tracking speed against noise.
#[derive(Clone)]
pub struct Benettin {
    pub x: V3,
    q: [V3; 3],
    count: u64,
    since: f64,
    filters: [Filter; 2],
}

impl Benettin {
    /// One memory length (0 = infinite memory, a plain running mean).
    pub fn new(x: V3, forget: f64) -> Self {
        Benettin::with_memories(x, [forget, forget])
    }

    /// Two memory lengths; see `exponents` and `exponents_slow`.
    pub fn with_memories(x: V3, forgets: [f64; 2]) -> Self {
        Benettin {
            x,
            q: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            count: 0,
            since: 0.0,
            filters: forgets.map(Filter::new),
        }
    }

    /// Restart the trajectory (keeps nothing of the old exponents).
    pub fn reset(&mut self, x: V3) {
        *self = Benettin::with_memories(x, self.filters.map(|f| f.forget));
    }

    /// Forget the accumulated exponents but keep the (already aligned)
    /// tangent frame, so a measurement starts without alignment bias.
    pub fn restart_average(&mut self) {
        self.filters = self.filters.map(|f| Filter::new(f.forget));
        self.count = 0;
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
        for (i, gi) in g.iter_mut().enumerate() {
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
            *gi = n.ln() / self.since;
        }
        self.count += 1;
        for f in self.filters.iter_mut() {
            f.update(g, self.since, self.count);
        }
        self.since = 0.0;
    }

    /// Exponents with the first memory length, sorted descending.
    pub fn exponents(&self) -> [f64; 3] {
        self.filters[0].value()
    }

    /// Exponents with the second memory length, sorted descending.
    pub fn exponents_slow(&self) -> [f64; 3] {
        self.filters[1].value()
    }

    pub fn healthy(&self) -> bool {
        self.x.iter().all(|v| v.is_finite() && v.abs() < 1e6)
            && self.q.iter().all(|v| v.iter().all(|c| c.is_finite()))
    }
}

/// Kaplan–Yorke dimension of a descending spectrum. The two leading exponents
/// within `EPS` of zero are treated as zero so a cycle reads exactly 1 and a
/// torus exactly 2.
pub fn kaplan_yorke(l: [f64; 3]) -> f64 {
    let snap = |v: f64| if v.abs() <= EPS { 0.0 } else { v };
    let l = [snap(l[0]), snap(l[1]), l[2]];
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

/// Dimension and regime of a tracer given its exponents and whether it is at
/// rest. A fixed point needs *both* a contracting spectrum and a tracer that
/// has actually stopped: a moving tracer whose finite-time λ1 is slightly
/// below −ε is a limit cycle seen through a biased window, so its λ1 is
/// floored at the cycle band instead.
pub fn classify(l: [f64; 3], at_rest: bool) -> (f64, u8) {
    if at_rest {
        return (0.0, FIXED);
    }
    let l = [l[0].max(-EPS), l[1], l[2]];
    let d = kaplan_yorke(l);
    (d, regime(l, d))
}

/// Offline classification of a law: a tracer runs `transient` world units,
/// then `average` more with infinite-memory exponents. Returns
/// `(D_KY, regime)`; a tracer that stops is reported as a fixed point at once.
/// This is what the map preview and the share tests use.
pub fn classify_law(law: &Law, transient: f64, average: f64, dt: f64) -> (f64, u8) {
    const CHUNK: f64 = 0.5;
    let per_chunk = (CHUNK / dt).round().max(1.0) as usize;
    let chunks = ((transient + average) / CHUNK).ceil() as usize;
    let restart = (transient / CHUNK).round() as usize;
    let mut b = Benettin::new([0.31, -0.22, 0.27], 0.0);
    let mut rest = 0;
    for k in 0..chunks {
        b.advance(law, dt, per_chunk);
        if !b.healthy() {
            break;
        }
        rest = if norm(law.field(b.x)) < REST_SPEED {
            rest + 1
        } else {
            0
        };
        if rest >= 12 {
            return (0.0, FIXED);
        }
        if k + 1 == restart {
            b.restart_average();
        }
    }
    classify(b.exponents(), rest >= 4)
}

/// A tracer that has been this slow (world units per unit time) for a while is
/// sitting on a fixed point, whatever the averaged exponents still remember.
pub const REST_SPEED: f64 = 0.01;
/// Time constant of the tracer-speed average.
const SPEED_MEMORY: f64 = 2.0;

/// The live spectrum tracker: one tracer particle in the world field.
///
/// Two memories run side by side. The reported exponents λ use the spec's
/// `FORGET ≈ 10` so they follow navigation. The dimension and regime use the
/// slower `FORGET_SLOW`: with the world normalised to ω ≈ 1.5 a loop lasts
/// ~4 time units, so 10 units are only ~2.4 loops — too few for a cycle's
/// exponent to settle inside the ±ε band, and the label would flicker.
pub struct Spectrum {
    bet: Benettin,
    rng: Rng,
    speed: f64,
}

impl Spectrum {
    pub fn new(seed: u32) -> Self {
        let mut rng = Rng::new(seed, 7);
        let x = rng.in_ball(0.6);
        Spectrum {
            bet: Benettin::with_memories(x, [FORGET, FORGET_SLOW]),
            rng,
            speed: 1.0,
        }
    }

    /// Integrate `world_time` of the current law (RK4, dt ≤ 0.01).
    pub fn step(&mut self, law: &Law, world_time: f64) {
        if world_time.is_nan() || world_time <= 0.0 {
            return;
        }
        let steps = (world_time / WORLD_DT).ceil().clamp(1.0, 400.0) as usize;
        self.bet.advance(law, world_time / steps as f64, steps);
        if self.bet.healthy() {
            let k = 1.0 - (-world_time / SPEED_MEMORY).exp();
            self.speed += k * (norm(law.field(self.bet.x)) - self.speed);
        } else {
            let x = self.rng.in_ball(0.6);
            self.bet.reset(x);
            self.speed = 1.0;
        }
    }

    /// `[λ1, λ2, λ3, D, regime, x, y, z]`
    pub fn read(&self) -> [f32; 8] {
        let l = self.bet.exponents();
        let slow = self.bet.exponents_slow();
        let (d, code) = classify(slow, self.speed < REST_SPEED);
        let x = self.bet.x;
        [
            l[0] as f32,
            l[1] as f32,
            l[2] as f32,
            d as f32,
            code as f32,
            x[0] as f32,
            x[1] as f32,
            x[2] as f32,
        ]
    }
}
