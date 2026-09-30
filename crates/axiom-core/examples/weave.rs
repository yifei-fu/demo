//! The lattice weave of the Thomas labyrinth (see `tests/weave.rs`).
//!
//!   cargo run --release --example weave                       # the shipped law at r = 1
//!   R=0.9 SEED=7 N=800000 cargo run --release --example weave # another point of the Thomas arc
//!   BS=0.002,0.004,0.008 cargo run --release --example weave  # scan b of a pure Thomas law
//!   DSCAN=0.002,0.004 cargo run --release --example weave     # D_KY of the same, four starts
//!
//! `N` particles (default 100 000) start uniformly in a ball of radius 1 and
//! are integrated for `SECS` (5) world seconds; the printed weave is the
//! noise-corrected RMS amplitude of the six lattice modes, with the strongest
//! single mode and the sampling noise beside it. `BS` and `DSCAN` take `L` and
//! `TAU` (the length and time scale of the law), and `BS` also `CONFINE` (the
//! wall radius) and `BALL` (the initial radius).

#[path = "../tests/common/weave.rs"]
mod weave;

use axiom_core::anchors::THOMAS;
use axiom_core::law::{pure_law_with, write_params, Law, Placement, PARAMS_LEN};
use axiom_core::spectrum::{classify_law, kaplan_yorke, Benettin};
use axiom_core::tables::Sample;

fn env<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// A pure, unrotated Thomas law with damping `b` (the ball is round, so the
/// rotation does not matter to the weave).
fn pure_thomas(b: f32, l: f32, tau: f32) -> Law {
    let sample = Sample {
        p: [b, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        c: [0.0; 3],
        l,
        tau,
        omega: 5.0,
    };
    pure_law_with(THOMAS, 1.0, &sample, 0.0)
}

/// Kaplan–Yorke dimension of a law from four initial conditions.
fn dimensions(law: &Law) -> Vec<f64> {
    [
        [0.31, -0.22, 0.27],
        [-0.5, 0.4, 0.1],
        [0.2, 0.7, -0.6],
        [-0.3, -0.6, 0.5],
    ]
    .iter()
    .map(|x0| {
        let mut b = Benettin::new(*x0, 0.0);
        b.advance(law, 0.02, 1_250);
        b.restart_average();
        b.advance(law, 0.02, 10_000);
        kaplan_yorke(b.exponents())
    })
    .collect()
}

fn values(key: &str) -> Vec<f32> {
    std::env::var(key)
        .map(|v| v.split(',').filter_map(|x| x.parse().ok()).collect())
        .unwrap_or_default()
}

fn main() {
    let (n, secs): (usize, f64) = (env("N", 100_000), env("SECS", 5.0));
    let strongest = |w: &weave::Weave| w.modes.iter().cloned().fold(0.0, f64::max);

    for b in values("DSCAN") {
        let law = pure_thomas(b, env("L", 35.0), env("TAU", 13.0));
        let d: Vec<String> = dimensions(&law).iter().map(|v| format!("{v:.2}")).collect();
        println!("b {b:.4}: D_KY {}", d.join(" "));
    }
    for b in values("BS") {
        let (l, tau) = (env("L", 24.2), env("TAU", 9.0));
        let mut law = pure_thomas(b, l, tau);
        law.confine = env("CONFINE", law.confine);
        let (d, regime) = classify_law(&law, 25.0, 150.0, 0.02);
        let w = weave::weave(&law, n, env("BALL", 1.0), secs, 0.02);
        println!(
            "b {b:.4} L {l} tau {tau}: D {d:.2} regime {regime} weave {:.4} (strongest mode {:.4}, noise {:.4})",
            w.amplitude,
            strongest(&w),
            w.noise
        );
    }
    if !values("DSCAN").is_empty() || !values("BS").is_empty() {
        return;
    }

    let (seed, r): (u32, f64) = (env("SEED", 1), env("R", 1.0));
    let theta = Placement::new(seed)
        .angle_of(THOMAS)
        .expect("Thomas is an anchor");
    let mut block = [0.0f32; PARAMS_LEN];
    let (u, v) = ((r * theta.cos()) as f32, (r * theta.sin()) as f32);
    write_params(u, v, seed, &mut block);
    let law = Law::from_block(&block);
    let slot = law
        .slots
        .iter()
        .flatten()
        .find(|s| s.kind == THOMAS)
        .expect("a Thomas slot");
    let (d, regime) = classify_law(&law, 25.0, 150.0, 0.02);
    let w = weave::weave(&law, n, 1.0, secs, 0.02);
    println!(
        "seed {seed} r {r} b {:.4} tau {:.3} L {:.3}: D {d:.2} regime {regime} weave {:.4} (strongest mode {:.4}, noise {:.4})",
        slot.p[0],
        slot.tau,
        slot.l,
        w.amplitude,
        strongest(&w),
        w.noise
    );
}
