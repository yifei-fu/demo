//! The five anchor systems in *system coordinates*, with analytic Jacobians.
//! Kind ids and parameter orders are fixed by DESIGN.md §3.1.

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
        LORENZ => [
            p[0] * (y - x),
            x * (p[1] - z) - y,
            x * y - p[2] * z,
        ],
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
        LORENZ => [
            [-p[0], p[0], 0.0],
            [p[1] - z, -1.0, -x],
            [y, x, -p[2]],
        ],
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
}
