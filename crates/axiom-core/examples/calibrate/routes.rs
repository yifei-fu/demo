//! The hand-designed part of the calibration: where along r each anchor's
//! parameters sit. Everything else (c, L, τ, ω) is measured from these.
//!
//! Halvorsen (kind 4) is implemented in `anchors.rs` but has no route: its
//! strange attractor sits at the very edge of its basin, so 40–60 % of the
//! particles that start in the unit ball run away and get pinned at the
//! confinement wall; shrinking L enough to avoid that pushes the attractor
//! out of the ball. It also hands its fixed point over from the origin to a
//! far focus at a = 4 (a global bifurcation), which no c(r) can hide.

use axiom_core::anchors::{AIZAWA, LORENZ, ROSSLER, THOMAS};

/// How the world origin (the route's centre `c`) is chosen.
#[derive(Clone, Copy)]
pub enum Centre {
    /// Stable equilibrium while it exists, then the attractor's bounding-box centre.
    Eq,
    /// Always the system origin (the attractor is inversion-symmetric).
    Zero,
    /// (0, 0, ρ−1) for the fixed points, then the bounding box in z.
    LorenzAxis,
}

pub struct Spec {
    pub kind: usize,
    /// `(r, parameters)` control rows.
    pub rows: Vec<(f64, Vec<f64>)>,
    /// Smallest allowed L (keeps early, tiny attractors small in the world).
    pub l_min: f64,
    /// L at r = 0, ramping to the first oscillating row. Keeps the unit ball
    /// (where particles start) inside the fixed point's basin of attraction.
    pub l_start: f64,
    /// Largest allowed τ (keeps stiff fixed points integrable).
    pub tau_cap: f64,
    /// World radius that 99 % of a grown attractor should fit in, at r = 0.6
    /// and at the rim (linear in between; the wall clips anything beyond R_c).
    pub r99: f64,
    pub r99_rim: f64,
    /// Particles on a grown attractor should move at least this fast (world
    /// units per second). Where the attractor is slow, τ is raised above the
    /// ω = 1.5 normalisation and the `omega` column says so.
    pub min_speed: f64,
    pub centre: Centre,
}

fn rows(list: &[(f64, &[f64])]) -> Vec<(f64, Vec<f64>)> {
    list.iter().map(|(r, p)| (*r, p.to_vec())).collect()
}

pub fn all() -> Vec<Spec> {
    vec![
        Spec {
            kind: THOMAS,
            rows: rows(&[
                (0.00, &[1.5]),
                (0.08, &[1.25]),
                (0.16, &[0.95]),
                (0.24, &[0.6]),
                (0.30, &[0.42]),
                (0.34, &[0.34]),
                (0.38, &[0.29]),
                (0.43, &[0.245]),
                (0.48, &[0.21]),
                (0.54, &[0.16]),
                (0.60, &[0.12]),
                (0.66, &[0.09]),
                (0.72, &[0.045]),
                (0.78, &[0.022]),
                (0.83, &[0.011]),
                (0.87, &[0.0065]),
                (0.90, &[0.0045]),
                (0.95, &[0.0038]),
                (1.00, &[0.0035]),
            ]),
            l_min: 5.0,
            l_start: 5.0,
            tau_cap: 9.0,
            r99: 0.8,
            r99_rim: 1.3,
            min_speed: 0.45,
            centre: Centre::Zero,
        },
        Spec {
            kind: AIZAWA,
            rows: rows(&[
                (0.00, &[-1.4, 0.7, 0.0, 3.5, 0.25, 0.1]),
                (0.06, &[-1.2, 0.7, 0.2, 3.5, 0.25, 0.1]),
                (0.12, &[-0.95, 0.7, 0.4, 3.5, 0.25, 0.1]),
                (0.18, &[-0.72, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.26, &[-0.4, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.34, &[-0.05, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.42, &[0.3, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.46, &[0.6, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.50, &[0.66, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.62, &[0.72, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.74, &[0.79, 0.7, 0.6, 3.5, 0.25, 0.1]),
                (0.80, &[0.84, 0.7, 0.61, 3.5, 0.25, 0.1]),
                (0.85, &[0.93, 0.7, 0.63, 3.5, 0.25, 0.1]),
                (0.90, &[1.01, 0.7, 0.66, 3.5, 0.25, 0.1]),
                (0.95, &[1.06, 0.7, 0.685, 3.5, 0.25, 0.1]),
                (1.00, &[1.1, 0.7, 0.7, 3.5, 0.25, 0.1]),
            ]),
            l_min: 1.7,
            l_start: 1.7,
            tau_cap: 4.0,
            r99: 0.8,
            r99_rim: 0.8,
            min_speed: 0.45,
            centre: Centre::Eq,
        },
        Spec {
            kind: LORENZ,
            // σ starts small so the fixed point at r = 0 is nearly normal (its
            // Jacobian's symmetric part is negative) and rises to the classic 10
            // before the Hopf region.
            rows: rows(&[
                (0.00, &[3.0, 0.0, 8.0 / 3.0]),
                (0.06, &[4.5, 0.25, 8.0 / 3.0]),
                (0.12, &[6.5, 0.7, 8.0 / 3.0]),
                (0.18, &[8.5, 1.6, 8.0 / 3.0]),
                (0.24, &[10.0, 6.0, 8.0 / 3.0]),
                (0.30, &[10.0, 12.0, 8.0 / 3.0]),
                (0.36, &[10.0, 19.0, 8.0 / 3.0]),
                (0.42, &[10.0, 24.5, 8.0 / 3.0]),
                (0.50, &[10.0, 27.0, 8.0 / 3.0]),
                (0.70, &[10.0, 30.0, 8.0 / 3.0]),
                (1.00, &[10.0, 34.0, 8.0 / 3.0]),
            ]),
            l_min: 20.0,
            l_start: 20.0,
            tau_cap: 0.6,
            r99: 0.8,
            r99_rim: 0.8,
            min_speed: 0.45,
            centre: Centre::LorenzAxis,
        },
        Spec {
            kind: ROSSLER,
            rows: rows(&[
                (0.00, &[0.2, 12.0, 5.7]),
                (0.08, &[0.2, 11.0, 5.7]),
                (0.16, &[0.2, 9.5, 5.7]),
                (0.24, &[0.2, 7.8, 5.7]),
                (0.30, &[0.2, 6.3, 5.7]),
                (0.36, &[0.2, 4.6, 5.7]),
                (0.42, &[0.2, 2.6, 5.7]),
                (0.48, &[0.2, 1.7, 5.7]),
                (0.54, &[0.2, 1.0, 5.7]),
                (0.60, &[0.2, 0.7, 5.7]),
                (0.68, &[0.2, 0.5, 5.7]),
                (0.76, &[0.2, 0.42, 5.7]),
                (0.84, &[0.2, 0.36, 5.7]),
                (0.92, &[0.2, 0.28, 5.7]),
                (1.00, &[0.2, 0.2, 5.7]),
            ]),
            l_min: 8.0,
            l_start: 8.0,
            tau_cap: 2.0,
            r99: 1.0,
            r99_rim: 1.0,
            min_speed: 0.45,
            centre: Centre::Eq,
        },
    ]
}
