//! The five anchor systems in *system coordinates*, with analytic Jacobians.
//! Kind ids and parameter orders are fixed by DESIGN.md §3.1.
//!
//! An anchor is an autonomous flow `ẋ = F_kind(x; p)` with up to eight
//! parameters `p`: Thomas' cyclically symmetric `ẋ = sin y − b x` (and its
//! two rotations), Aizawa's sphere-and-tube flow, Lorenz's `σ, ρ, β` and
//! Rössler's `a, b, c`. Halvorsen's is here so the block format is complete,
//! but no route uses it. The Jacobian `J = ∂F/∂x` is written out by hand
//! because the spectrum needs it at every step (`spectrum`); tests check it
//! against finite differences. `rk4` is the one integrator everything
//! shares, so the particles, the probes and the tracer agree.

pub type V3 = [f64; 3];
/// Row-major: `m[row][col]`.
pub type M3 = [[f64; 3]; 3];

pub const THOMAS: usize = 0;
pub const AIZAWA: usize = 1;
pub const LORENZ: usize = 2;
pub const ROSSLER: usize = 3;
pub const HALVORSEN: usize = 4;
pub const KIND_COUNT: usize = 5;

pub const NAMES: [&str; KIND_COUNT] = ["Thomas", "Aizawa", "Lorenz", "Rossler", "Halvorsen"];

/// Anything with a vector field and its Jacobian.
pub trait System {
    fn field(&self, x: V3) -> V3;
    fn jac(&self, x: V3) -> M3;
}

/// One anchor kind with concrete parameters.
#[derive(Clone, Copy, Debug)]
pub struct Anchor {
    pub kind: usize,
    pub p: [f64; 8],
}

impl Anchor {
    pub fn new(kind: usize, p: &[f64]) -> Self {
        let mut q = [0.0; 8];
        q[..p.len().min(8)].copy_from_slice(&p[..p.len().min(8)]);
        Anchor { kind, p: q }
    }

    /// The classic chaotic parameter values.
    pub fn classic(kind: usize) -> Self {
        match kind {
            THOMAS => Anchor::new(kind, &[0.208_186]),
            AIZAWA => Anchor::new(kind, &[0.95, 0.7, 0.6, 3.5, 0.25, 0.1]),
            LORENZ => Anchor::new(kind, &[10.0, 28.0, 8.0 / 3.0]),
            ROSSLER => Anchor::new(kind, &[0.2, 0.2, 5.7]),
            _ => Anchor::new(HALVORSEN, &[1.89]),
        }
    }
}

impl System for Anchor {
    fn field(&self, x: V3) -> V3 {
        field(self.kind, &self.p, x)
    }
    fn jac(&self, x: V3) -> M3 {
        jac(self.kind, &self.p, x)
    }
}

pub fn field(kind: usize, p: &[f64; 8], [x, y, z]: V3) -> V3 {
    match kind {
        THOMAS => [y.sin() - p[0] * x, z.sin() - p[0] * y, x.sin() - p[0] * z],
        AIZAWA => {
            let (al, be, ga, de, ep, ze) = (p[0], p[1], p[2], p[3], p[4], p[5]);
            let q = x * x + y * y;
            [
                (z - be) * x - de * y,
                de * x + (z - be) * y,
                ga + al * z - z * z * z / 3.0 - q * (1.0 + ep * z) + ze * z * x * x * x,
            ]
        }
        LORENZ => [p[0] * (y - x), x * (p[1] - z) - y, x * y - p[2] * z],
        ROSSLER => [-y - z, x + p[0] * y, p[1] + z * (x - p[2])],
        _ => {
            let a = p[0];
            [
                -a * x - 4.0 * y - 4.0 * z - y * y,
                -a * y - 4.0 * z - 4.0 * x - z * z,
                -a * z - 4.0 * x - 4.0 * y - x * x,
            ]
        }
    }
}

pub fn jac(kind: usize, p: &[f64; 8], [x, y, z]: V3) -> M3 {
    match kind {
        THOMAS => {
            let b = p[0];
            [[-b, y.cos(), 0.0], [0.0, -b, z.cos()], [x.cos(), 0.0, -b]]
        }
        AIZAWA => {
            let (al, be, de, ep, ze) = (p[0], p[1], p[3], p[4], p[5]);
            let e = 1.0 + ep * z;
            [
                [z - be, -de, x],
                [de, z - be, y],
                [
                    -2.0 * x * e + 3.0 * ze * z * x * x,
                    -2.0 * y * e,
                    al - z * z - ep * (x * x + y * y) + ze * x * x * x,
                ],
            ]
        }
        LORENZ => [[-p[0], p[0], 0.0], [p[1] - z, -1.0, -x], [y, x, -p[2]]],
        ROSSLER => [[0.0, -1.0, -1.0], [1.0, p[0], 0.0], [z, 0.0, x - p[2]]],
        _ => {
            let a = p[0];
            [
                [-a, -4.0 - 2.0 * y, -4.0],
                [-4.0, -a, -4.0 - 2.0 * z],
                [-4.0 - 2.0 * x, -4.0, -a],
            ]
        }
    }
}

/// Eigenvalues of a real 3×3 matrix as `(re, im)` pairs (closed-form cubic).
pub fn eigenvalues(m: &M3) -> [(f64, f64); 3] {
    let tr = m[0][0] + m[1][1] + m[2][2];
    let s2 = (m[0][0] * m[1][1] - m[0][1] * m[1][0])
        + (m[0][0] * m[2][2] - m[0][2] * m[2][0])
        + (m[1][1] * m[2][2] - m[1][2] * m[2][1]);
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    // λ³ + aλ² + bλ + c, depressed to t³ + pt + q with λ = t + shift.
    let (a, b, c) = (-tr, s2, -det);
    let p = b - a * a / 3.0;
    let q = 2.0 * a * a * a / 27.0 - a * b / 3.0 + c;
    let shift = -a / 3.0;
    let disc = (q / 2.0).powi(2) + (p / 3.0).powi(3);
    if disc > 0.0 {
        let s = disc.sqrt();
        let u = (-q / 2.0 + s).cbrt();
        let v = (-q / 2.0 - s).cbrt();
        let im = 3f64.sqrt() / 2.0 * (u - v);
        [
            (u + v + shift, 0.0),
            (-(u + v) / 2.0 + shift, im),
            (-(u + v) / 2.0 + shift, -im),
        ]
    } else {
        let m2 = 2.0 * (-p / 3.0).max(0.0).sqrt();
        let arg = if m2 == 0.0 {
            0.0
        } else {
            (3.0 * q / (p * m2)).clamp(-1.0, 1.0)
        };
        let phi = arg.acos();
        let t = |k: f64| {
            (
                m2 * ((phi - std::f64::consts::TAU * k) / 3.0).cos() + shift,
                0.0,
            )
        };
        [t(0.0), t(1.0), t(2.0)]
    }
}

/// One classical RK4 step of `ẋ = F(x)`.
pub fn rk4<S: System>(s: &S, x: V3, h: f64) -> V3 {
    let add = |a: V3, k: V3, f: f64| [a[0] + f * k[0], a[1] + f * k[1], a[2] + f * k[2]];
    let k1 = s.field(x);
    let k2 = s.field(add(x, k1, 0.5 * h));
    let k3 = s.field(add(x, k2, 0.5 * h));
    let k4 = s.field(add(x, k3, h));
    [
        x[0] + h / 6.0 * (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0]),
        x[1] + h / 6.0 * (k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1]),
        x[2] + h / 6.0 * (k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2]),
    ]
}

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

pub fn mat_vec(m: &M3, v: V3) -> V3 {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The analytic Jacobians must match central differences of the fields.
    #[test]
    fn jacobians_match_finite_differences() {
        let x0 = [0.37, -0.81, 0.55];
        for kind in 0..KIND_COUNT {
            let a = Anchor::classic(kind);
            let j = a.jac(x0);
            for c in 0..3 {
                let h = 1e-6;
                let mut xp = x0;
                let mut xm = x0;
                xp[c] += h;
                xm[c] -= h;
                let fp = a.field(xp);
                let fm = a.field(xm);
                for row in 0..3 {
                    let fd = (fp[row] - fm[row]) / (2.0 * h);
                    assert!(
                        (fd - j[row][c]).abs() < 1e-6,
                        "kind {kind} J[{row}][{c}]: fd {fd} vs {}",
                        j[row][c]
                    );
                }
            }
        }
    }

    fn sorted_re(m: &M3) -> Vec<f64> {
        let mut re: Vec<f64> = eigenvalues(m).iter().map(|e| e.0).collect();
        re.sort_by(|a, b| a.total_cmp(b));
        re
    }

    #[test]
    fn eigenvalues_of_known_matrices() {
        // Thomas at the origin: -b plus the cube roots of unity.
        let b = 0.4;
        let m = [[-b, 1.0, 0.0], [0.0, -b, 1.0], [1.0, 0.0, -b]];
        let re = sorted_re(&m);
        assert!((re[0] + b + 0.5).abs() < 1e-9 && (re[1] + b + 0.5).abs() < 1e-9);
        assert!((re[2] - (1.0 - b)).abs() < 1e-9);
        let im = eigenvalues(&m)
            .iter()
            .map(|e| e.1.abs())
            .fold(0.0, f64::max);
        assert!((im - 3f64.sqrt() / 2.0).abs() < 1e-9);
        let re = sorted_re(&[[2.0, 0.0, 0.0], [0.0, -3.0, 0.0], [0.0, 0.0, 0.5]]);
        assert!(
            (re[0] + 3.0).abs() < 1e-9 && (re[1] - 0.5).abs() < 1e-9 && (re[2] - 2.0).abs() < 1e-9
        );
    }
}
