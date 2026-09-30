//! Density modulation of the Thomas labyrinth ("the weave").
//!
//! Near the rim the Thomas flow `ẋ = sin y − b x, …` is almost conservative and
//! periodic in system coordinates, so a cloud of particles that starts uniform
//! is imprinted with the flow's own lattice: a faint dot or grid pattern in the
//! density. This measures it. Particles start on a low-discrepancy (Halton)
//! filling of a ball, are integrated in the world field, and the density is
//! projected onto Fourier modes of the *system* lattice: for a wave vector `k`
//! the density is `ρ = ρ₀ (1 + m cos(k·x_sys + φ))` with `m = 2 |⟨e^{i k·x_sys}⟩|`.

use axiom_core::anchors::{rk4, V3};
use axiom_core::law::Law;
use std::f64::consts::TAU;

/// Wave vectors (system coordinates) the Thomas flow imprints: 2(±1,0,1),
/// 2(0,±1,1) and 2(1,±1,0).
pub const MODES: [V3; 6] = [
    [2.0, 0.0, 2.0],
    [-2.0, 0.0, 2.0],
    [0.0, 2.0, 2.0],
    [0.0, -2.0, 2.0],
    [2.0, 2.0, 0.0],
    [2.0, -2.0, 0.0],
];

/// The `i`-th point of the base-`b` van der Corput sequence.
fn radical_inverse(mut i: u64, b: u64) -> f64 {
    let (mut f, mut r) = (1.0, 0.0);
    while i > 0 {
        f /= b as f64;
        r += f * (i % b) as f64;
        i /= b;
    }
    r
}

/// Halton point `i` mapped uniformly into the ball of radius `radius`.
pub fn ball_point(i: u64, radius: f64) -> V3 {
    let (u, v, w) = (
        radical_inverse(i + 1, 2),
        radical_inverse(i + 1, 3),
        radical_inverse(i + 1, 5),
    );
    let r = radius * u.cbrt();
    let cos = 2.0 * v - 1.0;
    let sin = (1.0 - cos * cos).sqrt();
    let phi = TAU * w;
    [r * sin * phi.cos(), r * sin * phi.sin(), r * cos]
}

/// Mode amplitudes `m_k` for every wave vector of `modes`, after `secs` of
/// world time, from `n` particles started uniformly in the ball of radius
/// `radius` (RK4, step `dt`, on four threads).
pub fn amplitudes(law: &Law, modes: &[V3], n: usize, radius: f64, secs: f64, dt: f64) -> Vec<f64> {
    let slot = law.slots[0].expect("a law with a Thomas slot");
    let steps = (secs / dt).round() as usize;
    let threads = 4;
    let chunk = n.div_ceil(threads);
    let sums: Vec<Vec<(f64, f64)>> = std::thread::scope(|sc| {
        let jobs: Vec<_> = (0..threads)
            .map(|t| {
                sc.spawn(move || {
                    let mut acc = vec![(0.0, 0.0); modes.len()];
                    for i in (t * chunk)..((t + 1) * chunk).min(n) {
                        let mut x = ball_point(i as u64, radius);
                        for _ in 0..steps {
                            x = rk4(law, x, dt);
                        }
                        // system coordinates: x_sys = c + L R x
                        let mut xs = slot.c;
                        for (col, xi) in slot.cols.iter().zip(x) {
                            for k in 0..3 {
                                xs[k] += slot.l * xi * col[k];
                            }
                        }
                        for (a, k) in acc.iter_mut().zip(modes) {
                            let phase = k[0] * xs[0] + k[1] * xs[1] + k[2] * xs[2];
                            a.0 += phase.cos();
                            a.1 += phase.sin();
                        }
                    }
                    acc
                })
            })
            .collect();
        jobs.into_iter().map(|j| j.join().expect("particles")).collect()
    });
    (0..modes.len())
        .map(|m| {
            let (re, im) = sums.iter().fold((0.0, 0.0), |(a, b), s| (a + s[m].0, b + s[m].1));
            2.0 * (re * re + im * im).sqrt() / n as f64
        })
        .collect()
}

/// Deterministic pseudo-random unit-ish wave vectors of length `|k|` in
/// directions the lattice does not favour: the noise floor of the estimate.
pub fn control_modes(len: f64, count: usize) -> Vec<V3> {
    (0..count)
        .map(|i| {
            let (u, v) = (radical_inverse(i as u64 + 7, 7), radical_inverse(i as u64 + 7, 11));
            let cos = 2.0 * u - 1.0;
            let sin = (1.0 - cos * cos).sqrt();
            let phi = TAU * v;
            [len * sin * phi.cos(), len * sin * phi.sin(), len * cos]
        })
        .collect()
}

/// What `weave` found.
pub struct Weave {
    /// Amplitude `m` of each lattice mode (raw, noise included).
    pub modes: Vec<f64>,
    /// RMS amplitude of the control modes: the sampling noise.
    pub noise: f64,
    /// Noise-corrected RMS amplitude of the lattice modes:
    /// `sqrt(max(0, mean m² − noise²))`.
    pub amplitude: f64,
}

/// The weave of `law` (whose slot 0 is Thomas) after `secs` of world time, from
/// `n` particles started uniformly in the ball of radius `radius`, integrated
/// with RK4 at step `dt` on four threads.
pub fn weave(law: &Law, n: usize, radius: f64, secs: f64, dt: f64) -> Weave {
    let controls = control_modes(2.0 * 2f64.sqrt(), 30);
    let all: Vec<V3> = MODES.iter().copied().chain(controls.iter().copied()).collect();
    let m = amplitudes(law, &all, n, radius, secs, dt);
    let (lattice, control) = m.split_at(MODES.len());
    let mean_sq = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64;
    let noise = mean_sq(control).sqrt();
    Weave {
        modes: lattice.to_vec(),
        noise,
        amplitude: (mean_sq(lattice) - noise * noise).max(0.0).sqrt(),
    }
}
