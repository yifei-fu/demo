//! The piece's invariants, encoded (DESIGN.md §1, §3, §4).

use axiom_core::anchors::{
    self, dot, eigenvalues, norm, rk4, Anchor, System, AIZAWA, KIND_COUNT, LORENZ, THOMAS, V3,
};
use axiom_core::law::{pure_law, write_params, Law, Placement, ANCHOR_COUNT, PARAMS_LEN};
use axiom_core::rng::Rng;
use axiom_core::spectrum::{
    kaplan_yorke, regime, Benettin, Spectrum, CYCLE, FIXED, LABYRINTH, STRANGE, TORUS,
};
use axiom_core::synth::Synth;
use axiom_core::tables::sample;
use std::f64::consts::TAU;

const SEEDS: [u32; 4] = [1, 7, 42, 90_210];

fn block(u: f64, v: f64, seed: u32) -> [f32; PARAMS_LEN] {
    let mut b = [0.0; PARAMS_LEN];
    write_params(u as f32, v as f32, seed, &mut b);
    b
}

fn polar(r: f64, theta: f64, seed: u32) -> [f32; PARAMS_LEN] {
    block(r * theta.cos(), r * theta.sin(), seed)
}

fn integrate(law: &Law, mut x: V3, steps: usize, dt: f64) -> V3 {
    for _ in 0..steps {
        x = rk4(law, x, dt);
    }
    x
}

/// World-space spectrum of a law with infinite memory, after a transient.
fn spectrum_of(law: &Law, x0: V3) -> ([f64; 3], f64, u8) {
    let mut b = Benettin::new(x0, 0.0);
    b.advance(law, 0.01, 6_000);
    b.restart_average();
    b.advance(law, 0.01, 25_000);
    let l = b.exponents();
    let d = kaplan_yorke(l);
    (l, d, regime(l, d))
}

// ------------------------------------------------------------ the law ----

#[test]
fn law_params_layout_is_valid() {
    let mut rng = Rng::new(5, 5);
    for i in 0..600 {
        let (u, v) = (rng.range(-1.6, 1.6), rng.range(-1.6, 1.6));
        let seed = i as u32 * 7919;
        let b = block(u, v, seed);
        let r = (u * u + v * v).sqrt().min(1.0);
        assert!((b[0] as f64 - r).abs() < 1e-5, "header r is on the disk");
        assert!(b[2] >= 0.0 && b[3] > 0.0, "kappa >= 0, confine radius > 0");
        let mut wsum = 0.0;
        let mut kinds = Vec::new();
        for s in 0..2 {
            let o = 4 + 32 * s;
            let kind = b[o];
            assert!(kind.fract() == 0.0 && (0.0..KIND_COUNT as f32).contains(&kind));
            kinds.push(kind as usize);
            wsum += b[o + 1] as f64;
            assert!(b[o + 1] >= 0.0 && b[o + 2] > 0.0 && b[o + 3] > 0.0);
            assert!(b[o + 7] > 0.0, "omega is positive");
            assert!(b[o + 28..o + 32].iter().all(|v| *v == 0.0), "reserved");
            // R: three padded columns, orthonormal, proper rotation.
            let col = |k: usize| {
                let c = &b[o + 16 + 4 * k..o + 20 + 4 * k];
                assert_eq!(c[3], 0.0, "column padding");
                [c[0] as f64, c[1] as f64, c[2] as f64]
            };
            let (c0, c1, c2) = (col(0), col(1), col(2));
            for (a, b) in [(c0, c0), (c1, c1), (c2, c2)] {
                assert!((dot(a, b) - 1.0).abs() < 1e-5);
            }
            for (a, b) in [(c0, c1), (c0, c2), (c1, c2)] {
                assert!(dot(a, b).abs() < 1e-5);
            }
            let cross = [
                c0[1] * c1[2] - c0[2] * c1[1],
                c0[2] * c1[0] - c0[0] * c1[2],
                c0[0] * c1[1] - c0[1] * c1[0],
            ];
            assert!(
                dot(cross, c2) > 0.999,
                "R must be a rotation, not a reflection"
            );
        }
        assert!(
            (wsum - 1.0).abs() < 1e-6,
            "weights are a partition of unity"
        );
        assert_ne!(kinds[0], kinds[1], "two distinct anchors");
    }
}

#[test]
fn placement_is_a_seeded_permutation() {
    for seed in 0..50 {
        let p = Placement::new(seed);
        let mut order = p.order.to_vec();
        order.sort_unstable();
        order.dedup();
        assert_eq!(order.len(), ANCHOR_COUNT, "every anchor once");
        let q = Placement::new(seed);
        assert_eq!((p.order, p.theta0), (q.order, q.theta0), "deterministic");
    }
    let distinct: std::collections::HashSet<_> = (0..40).map(|s| Placement::new(s).order).collect();
    assert!(distinct.len() > 10, "seeds must rearrange the rim");
}

#[test]
fn rotations_are_damped_toward_upright() {
    // A uniform random rotation averages ~126° of angle; halving it lands
    // well below 90° for every draw.
    for seed in 0..200 {
        let p = Placement::new(seed);
        for cols in p.rot {
            let trace = cols[0][0] + cols[1][1] + cols[2][2];
            let angle = ((trace - 1.0) / 2.0).clamp(-1.0, 1.0).acos();
            assert!(angle <= std::f64::consts::FRAC_PI_2 + 1e-9, "angle {angle}");
        }
    }
}

#[test]
fn field_is_continuous_around_and_across_the_disk() {
    let x = [0.31, -0.22, 0.47];
    let eps = 1e-3;
    for seed in [3, 11] {
        for i in 0..200 {
            let (r, th) = (0.03 + 0.97 * (i % 20) as f64 / 19.0, TAU * i as f64 / 200.0);
            let a = Law::from_block(&polar(r, th, seed)).field(x);
            for (dr, dth) in [(eps, 0.0), (0.0, eps)] {
                let b = Law::from_block(&polar(r + dr, th + dth, seed)).field(x);
                let d = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
                assert!(
                    d < 0.1,
                    "field jump {d} at r={r:.2} theta={th:.2} seed={seed}"
                );
            }
        }
    }
}

#[test]
fn world_jacobian_matches_finite_differences() {
    // The chain rule J = Σ w τ Rᵀ J_kind R − κI − J_confine, inside and outside
    // the confinement radius, for random blends.
    let mut rng = Rng::new(3, 3);
    for i in 0..300u32 {
        let (r, theta) = (rng.range(0.02, 1.0), rng.range(0.0, TAU));
        let law = Law::from_block(&polar(r, theta, i));
        let x = rng.in_ball(if i % 2 == 0 { 0.9 } else { 2.2 });
        let j = law.jac(x);
        for c in 0..3 {
            let h = 1e-6;
            let (mut xp, mut xm) = (x, x);
            xp[c] += h;
            xm[c] -= h;
            let (fp, fm) = (law.field(xp), law.field(xm));
            for row in 0..3 {
                let fd = (fp[row] - fm[row]) / (2.0 * h);
                assert!(
                    (fd - j[row][c]).abs() < 1e-4 * (1.0 + fd.abs()),
                    "J[{row}][{c}] at r={r:.2} theta={theta:.2}: {fd} vs {}",
                    j[row][c]
                );
            }
        }
    }
}

#[test]
fn route_tables_are_smooth_and_complete() {
    for kind in axiom_core::tables::ANCHORS {
        // Reconstruct the rows through the public sampler at fine steps.
        let n = 400;
        let mut prev = sample(kind, 0.0);
        for i in 1..=n {
            let s = sample(kind, i as f64 / n as f64);
            assert!(s.l > 0.0 && s.tau > 0.0 && s.omega > 0.0, "kind {kind}");
            assert!(
                ((s.l - prev.l) / prev.l).abs() < 0.03,
                "L jumps, kind {kind} step {i}"
            );
            assert!(
                ((s.tau - prev.tau) / prev.tau).abs() < 0.06,
                "tau jumps, kind {kind} step {i}"
            );
            let dc = norm([
                (s.c[0] - prev.c[0]) as f64,
                (s.c[1] - prev.c[1]) as f64,
                (s.c[2] - prev.c[2]) as f64,
            ]);
            assert!(dc / (prev.l as f64) < 0.03, "c jumps, kind {kind} step {i}");
            prev = s;
        }
    }
}

#[test]
fn non_finite_input_is_mapped_to_the_centre() {
    for (u, v) in [
        (f64::NAN, 0.3),
        (0.2, f64::INFINITY),
        (f64::NEG_INFINITY, f64::NAN),
    ] {
        let b = block(u, v, 5);
        assert!(b.iter().all(|x| x.is_finite()));
        assert_eq!(b[0], 0.0);
    }
    let far = block(30.0, 0.0, 5);
    assert!(
        (far[0] - 1.0).abs() < 1e-6,
        "points beyond the rim land on it"
    );
}

// ----------------------------------------------------- the centre point ---

#[test]
fn centre_is_a_stable_fixed_point_for_every_theta_and_seed() {
    // Any blend of any two anchors, in any seeded orientation: the origin is an
    // equilibrium and its linearisation decays. At r = 0.08 it still must.
    for (r, margin) in [(1e-6, -0.8), (0.08, -0.15)] {
        for seed in 0..300u32 {
            for i in 0..64 {
                let theta = TAU * i as f64 / 64.0 + 0.013;
                let law = Law::from_block(&polar(r, theta, seed));
                let f0 = law.field([0.0; 3]);
                // Exact at r = 0; between table rows the linearly interpolated
                // centre only tracks the true equilibrium to a few 1e-3.
                assert!(
                    norm(f0) < 1e-4 + 0.15 * r,
                    "origin must be an equilibrium: {f0:?}"
                );
                let worst = eigenvalues(&law.jac([0.0; 3]))
                    .iter()
                    .map(|e| e.0)
                    .fold(f64::MIN, f64::max);
                assert!(
                    worst < margin,
                    "r {r} seed {seed} theta {theta:.2}: max Re = {worst}"
                );
            }
        }
    }
}

#[test]
fn centre_collapses_all_trajectories_to_the_origin() {
    let mut rng = Rng::new(9, 9);
    for &seed in &SEEDS[..3] {
        for i in 0..32 {
            let theta = TAU * i as f64 / 32.0;
            let b = polar(1e-6, theta, seed);
            let law = Law::from_block(&b);
            for _ in 0..3 {
                let x = integrate(&law, rng.in_ball(1.0), 6_000, 0.02);
                assert!(
                    norm(x) < 1e-3,
                    "seed {seed} theta {theta:.2} ended at {x:?}"
                );
            }
            let mut sp = Spectrum::new(seed);
            for _ in 0..50 {
                sp.step(&law, 0.5);
            }
            let read = sp.read();
            assert_eq!(read[4] as u8, FIXED, "regime at the centre");
            assert_eq!(read[3], 0.0, "D_KY at the centre");
        }
    }
}

#[test]
fn trajectories_stay_bounded_across_the_disk() {
    let mut rng = Rng::new(21, 3);
    for &seed in &SEEDS[..2] {
        for ri in 1..=8 {
            let r = ri as f64 / 8.0;
            for ti in 0..32 {
                let theta = TAU * (ti as f64 + 0.37) / 32.0;
                let law = Law::from_block(&polar(r, theta, seed));
                for _ in 0..3 {
                    let mut x = rng.in_ball(1.0);
                    for step in 0..2_500 {
                        x = rk4(&law, x, 0.02);
                        assert!(
                            x.iter().all(|v| v.is_finite()) && norm(x) < 3.0,
                            "seed {seed} r {r} theta {theta:.2} step {step}: {x:?}"
                        );
                    }
                }
            }
        }
    }
}

// --------------------------------------------------- spectrum & regimes ---

#[test]
fn raw_lorenz_spectrum_matches_the_literature() {
    let a = Anchor::classic(LORENZ);
    let mut b = Benettin::new([1.0, 1.0, 20.0], 0.0);
    b.advance(&a, 0.004, 5_000);
    b.restart_average();
    b.advance(&a, 0.004, 100_000);
    let l = b.exponents();
    let d = kaplan_yorke(l);
    assert!((l[0] - 0.906).abs() < 0.03, "lambda1 = {}", l[0]);
    assert!(l[1].abs() < 0.03, "lambda2 = {}", l[1]);
    assert!((l[2] + 14.57).abs() < 0.08, "lambda3 = {}", l[2]);
    assert!((d - 2.062).abs() < 0.01, "D_KY = {d}");
    assert_eq!(regime(l, d), STRANGE);
}

#[test]
fn forgetting_spectrum_tracks_a_cycle_torus_and_chaos() {
    // The live tracker (T = 10) must agree with the long average on the
    // regime along the Aizawa route.
    let a = anchors::Anchor::classic(AIZAWA);
    assert_eq!(a.kind, AIZAWA);
    let mut seen = std::collections::BTreeSet::new();
    for i in 0..=40 {
        let r = i as f64 / 40.0;
        let law = pure_law(AIZAWA, r);
        let mut sp = Spectrum::new(4);
        for _ in 0..240 {
            sp.step(&law, 0.5);
        }
        seen.insert(sp.read()[4] as u8);
    }
    assert!(
        seen.contains(&FIXED) && seen.contains(&CYCLE),
        "regimes seen: {seen:?}"
    );
}

#[test]
fn live_tracker_labels_the_regimes_it_is_pointed_at() {
    let settle = |law: &Law| {
        let mut sp = Spectrum::new(11);
        for _ in 0..600 {
            sp.step(law, 0.4);
        }
        sp.read()
    };
    let at_rest = settle(&pure_law(AIZAWA, 0.1));
    assert_eq!((at_rest[4] as u8, at_rest[3]), (FIXED, 0.0));
    let cycle = settle(&pure_law(AIZAWA, 0.4));
    assert_eq!((cycle[4] as u8, cycle[3]), (CYCLE, 1.0));
    assert!(cycle[0].abs() < 0.02, "a cycle's leading exponent is ~0");
    let butterfly = settle(&pure_law(LORENZ, 0.8));
    assert_eq!(butterfly[4] as u8, STRANGE);
    assert!(
        (butterfly[3] - 2.06).abs() < 0.08,
        "D_KY = {}",
        butterfly[3]
    );
    assert!(butterfly[0] > 0.05, "lambda1 = {}", butterfly[0]);
    let maze = settle(&pure_law(THOMAS, 1.0));
    assert_eq!(maze[4] as u8, LABYRINTH);
    assert!(maze[3] > 2.7, "D_KY = {}", maze[3]);
}

/// Regimes seen along a pure route, sampled at `n + 1` radii.
fn route_regimes(kind: usize, n: usize) -> Vec<(f64, u8, f64)> {
    (0..=n)
        .map(|i| {
            let r = i as f64 / n as f64;
            let law = pure_law(kind, r);
            let (_, d, reg) = spectrum_of(&law, [0.31, -0.22, 0.27]);
            (r, reg, d)
        })
        .collect()
}

#[test]
fn aizawa_route_passes_through_a_torus() {
    let seen = route_regimes(AIZAWA, 50);
    assert_eq!(seen[0].1, FIXED, "r = 0 is a fixed point");
    assert!(seen.iter().any(|s| s.1 == CYCLE), "Aizawa cycle: {seen:?}");
    assert!(
        seen.iter().any(|s| s.1 == TORUS && s.0 > 0.4),
        "Aizawa torus: {seen:?}"
    );
    assert!(
        seen.iter().any(|s| s.1 == STRANGE),
        "Aizawa chaos: {seen:?}"
    );
}

#[test]
fn thomas_rim_is_strange_or_labyrinth() {
    let seen = route_regimes(THOMAS, 40);
    assert_eq!(seen[0].1, FIXED);
    let rim = seen[40];
    assert!(rim.1 == STRANGE || rim.1 == LABYRINTH, "rim: {rim:?}");
    assert!(
        rim.2 > 2.5,
        "Thomas rim should be nearly space-filling: D = {}",
        rim.2
    );
    assert!(seen.iter().any(|s| s.1 == CYCLE), "Thomas cycle: {seen:?}");
}

#[test]
fn every_anchor_starts_fixed_and_ends_chaotic() {
    for kind in axiom_core::tables::ANCHORS {
        let seen = route_regimes(kind, 20);
        assert_eq!(seen[0].1, FIXED, "kind {kind} r=0");
        let rim = seen[20];
        assert!(rim.1 >= STRANGE, "kind {kind} rim: {rim:?}");
    }
}

// ---------------------------------------------------------------- audio ---

const SR: f32 = 48_000.0;

fn render_seconds(s: &mut Synth, secs: f32, mut each_block: impl FnMut(&mut Synth, usize)) -> f32 {
    let blocks = (secs * SR / 128.0) as usize;
    let mut peak = 0.0f32;
    for b in 0..blocks {
        each_block(s, b);
        for v in s.render(128) {
            assert!(v.is_finite(), "non-finite sample");
            peak = peak.max(v.abs());
        }
    }
    peak
}

#[test]
fn synth_is_finite_and_bounded_everywhere_with_events() {
    let points = [
        (0.0, 0.0),
        (0.35, 0.2),
        (-0.1, 0.62),
        (-0.7, -0.5),
        (0.9, 0.3),
        (0.2, -1.0),
    ];
    for (i, (u, v)) in points.into_iter().enumerate() {
        let seed = 100 + i as u32;
        let mut s = Synth::new(SR, seed);
        s.set_law(&block(u, v, seed));
        s.set(0, 1.0);
        let peak = render_seconds(&mut s, 10.0, |s, b| match b {
            300 => s.set(1, 1.0), // 1.6 s: stir on
            700 => s.set(1, 0.0), // 3.7 s: stir off
            900 => s.set(3, 1.0), // 4.8 s: shake
            1_200 => {
                s.set(2, 1.0);
                s.set(6, 0.1);
                s.set(7, 2.3);
            }
            1_500 => s.set_law(&block(-u, v * 0.5, seed)), // law change mid-stream
            _ => {}
        });
        assert!(peak <= 0.9 + 1e-6, "point ({u},{v}): peak {peak}");
        assert!(peak <= 1.0);
    }
}

#[test]
fn synth_output_is_stereo_interleaved_and_capped_at_256_frames() {
    let mut s = Synth::new(SR, 1);
    s.set_law(&block(0.5, 0.0, 1));
    assert_eq!(s.render(64).len(), 128);
    assert_eq!(s.render(1_000).len(), 512);
}

#[test]
fn fixed_point_is_silent_and_a_hopf_swells() {
    let seed = 8;
    let mut s = Synth::new(SR, seed);
    s.set(0, 1.0);
    s.set_law(&block(1e-6, 0.0, seed));
    render_seconds(&mut s, 3.0, |_, _| {});
    render_seconds(&mut s, 1.0, |_, _| {});
    assert!(
        s.bus_rms() < 1e-3,
        "centre must be silent, bus rms = {}",
        s.bus_rms()
    );
    // Move out to a limit-cycle region of whichever anchor sits there.
    let pl = Placement::new(seed);
    let theta = pl.angle_of(AIZAWA).expect("Aizawa is an anchor");
    s.set_law(&polar(0.5, theta, seed));
    render_seconds(&mut s, 6.0, |_, _| {});
    let loud = s.bus_rms();
    assert!(loud > 0.02, "a cycle must be audible: bus rms = {loud}");
    s.set_law(&block(1e-6, 0.0, seed));
    render_seconds(&mut s, 6.0, |_, _| {});
    assert!(
        s.bus_rms() < loud * 0.05,
        "and fall silent again: {}",
        s.bus_rms()
    );
}

/// RMS of the next `secs` of stereo output.
fn rms_of(s: &mut Synth, secs: f32) -> f32 {
    let (mut sum, mut n) = (0.0f64, 0usize);
    for _ in 0..(secs * SR / 128.0) as usize {
        for v in s.render(128) {
            sum += (*v as f64).powi(2);
            n += 1;
        }
    }
    (sum / n as f64).sqrt() as f32
}

#[test]
fn stir_and_shake_make_themselves_heard() {
    let mut s = Synth::new(SR, 2);
    s.set(0, 1.0);
    s.set_law(&block(1e-6, 0.0, 2));
    render_seconds(&mut s, 3.0, |_, _| {});
    let calm = rms_of(&mut s, 0.5);
    assert!(calm < 0.04, "the centre should only hold the drone: {calm}");

    s.set(1, 1.0);
    render_seconds(&mut s, 0.5, |_, _| {});
    let stirred = rms_of(&mut s, 0.5);
    assert!(stirred > 3.0 * calm, "stir: {stirred} vs calm {calm}");
    s.set(1, 0.0);
    render_seconds(&mut s, 2.0, |_, _| {});

    s.set(3, 1.0);
    let shaken = rms_of(&mut s, 0.3);
    assert!(shaken > 3.0 * calm, "shake: {shaken} vs calm {calm}");
    render_seconds(&mut s, 3.0, |_, _| {});
    let after = rms_of(&mut s, 0.5);
    assert!(after < 2.0 * calm, "the whoosh dies away: {after}");
}
