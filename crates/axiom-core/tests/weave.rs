//! The labyrinth's weave (Round 6).
//!
//! In the Thomas labyrinth the flow `ẋ = sin y − b x, …` is periodic in system
//! coordinates and, for small `b`, nearly conservative. A cloud of particles
//! that starts uniform is then imprinted with the flow's lattice: a faint dot
//! or grid pattern in the density, at the wave vectors 2(±1,0,1), 2(0,±1,1)
//! and 2(1,±1,0). The pattern *grows* with `b` (dissipation herds the cloud
//! onto a structured attractor: 2.4% at the old rim value b = 0.008, 4% at
//! r = 0.9 where b = 0.011), so the route now runs `b` down to 0.0025 on the
//! rim. The measurement is in `common/weave.rs`.

#[path = "common/weave.rs"]
mod weave;

use axiom_core::anchors::THOMAS;
use axiom_core::law::{pure_law_with, write_params, Law, Placement, PARAMS_LEN};
use axiom_core::spectrum::{classify_law, LABYRINTH};
use axiom_core::tables::Sample;

/// Particles per measurement. The sampling noise on one mode is about
/// `2/√N` (0.4% here); the estimate subtracts it, so what is compared with
/// the limit is the lattice signal alone.
const PARTICLES: usize = 250_000;
const STEP: f64 = 0.025;
/// After this much world time from a uniform ball of radius 1.
const SECS: f64 = 5.0;
/// The most weave the labyrinth may show: a density modulation of 0.7%.
const LIMIT: f64 = 0.007;

/// The law at radius `r` on the Thomas arc of `seed`.
fn thomas_law(seed: u32, r: f64) -> Law {
    let theta = Placement::new(seed)
        .angle_of(THOMAS)
        .expect("Thomas is an anchor");
    let mut block = [0.0f32; PARAMS_LEN];
    write_params(
        (r * theta.cos()) as f32,
        (r * theta.sin()) as f32,
        seed,
        &mut block,
    );
    Law::from_block(&block)
}

#[test]
fn the_labyrinth_weave_is_faint() {
    for (seed, r) in [(1, 0.9), (7, 1.0)] {
        let law = thomas_law(seed, r);
        let w = weave::weave(&law, PARTICLES, 1.0, SECS, STEP);
        let strongest = w.modes.iter().cloned().fold(0.0, f64::max);
        eprintln!(
            "seed {seed} r {r}: weave {:.4}, strongest mode {strongest:.4}, noise {:.4}",
            w.amplitude, w.noise
        );
        assert!(
            w.amplitude <= LIMIT,
            "seed {seed} r {r}: the weave is {:.2}% after {SECS} s",
            100.0 * w.amplitude
        );
        // Every single mode, noise included, stays within twice the limit.
        assert!(strongest <= 2.0 * LIMIT, "seed {seed} r {r}: {strongest}");
    }
}

#[test]
fn the_weave_measurement_sees_the_old_route() {
    // The old rim (b = 0.008, L = 24.2, τ = 9) must read as a clear weave, or
    // the test above would pass for any route. Rotation does not matter (the
    // initial ball is round), so the pure, unrotated law will do.
    let sample = Sample {
        p: [0.008, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        c: [0.0; 3],
        l: 24.2,
        tau: 9.0,
        omega: 5.5,
    };
    let law = pure_law_with(THOMAS, 1.0, &sample, 0.0);
    let w = weave::weave(&law, PARTICLES, 1.0, SECS, STEP);
    eprintln!("old rim: weave {:.4}, noise {:.4}", w.amplitude, w.noise);
    assert!(
        w.amplitude >= 0.015,
        "the old weave reads only {:.2}%",
        100.0 * w.amplitude
    );
    assert!(w.noise < 0.005, "sampling noise {:.2}%", 100.0 * w.noise);
}

#[test]
fn the_thomas_rim_is_a_labyrinth_from_r_0_9() {
    // Lowering b removes the weave; it must not take the labyrinth with it:
    // D_KY >= 2.7 and regime 4 on the whole outer Thomas arc.
    for seed in [1, 7, 42] {
        for r in [0.9, 0.95, 1.0] {
            let law = thomas_law(seed, r);
            let (d, regime) = classify_law(&law, 25.0, 100.0, 0.025);
            assert!(
                d >= 2.7 && regime == LABYRINTH,
                "seed {seed} r {r}: D = {d:.2}, regime {regime}"
            );
        }
    }
    // (kept in step with the route: the rim damping is far below the 0.208 of
    // Thomas' classic chaos, and below the old 0.008)
    let b = thomas_law(1, 1.0)
        .slots
        .iter()
        .flatten()
        .find(|s| s.kind == THOMAS)
        .map(|s| s.p[0]);
    assert!(b.is_some_and(|b| b < 0.004), "rim b = {b:?}");
}
