//! Numerical tools for the calibration: equilibria, long-trajectory
//! measurement, frequency estimation.

use axiom_core::anchors::{eigenvalues, norm, Anchor, System, KIND_COUNT, M3, NAMES, V3};
use axiom_core::spectrum::Benettin;
use std::f64::consts::TAU;

pub fn sym_max(m: &M3) -> f64 {
    let s = |i: usize, j: usize| 0.5 * (m[i][j] + m[j][i]);
    let sym = [
        [s(0, 0), s(0, 1), s(0, 2)],
        [s(1, 0), s(1, 1), s(1, 2)],
        [s(2, 0), s(2, 1), s(2, 2)],
    ];
    eigenvalues(&sym)
        .iter()
        .map(|e| e.0)
        .fold(f64::MIN, f64::max)
}

fn det3(m: &M3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn solve3(m: &M3, b: V3) -> Option<V3> {
    let det = det3(m);
    if det.abs() < 1e-12 {
        return None;
    }
    let mut out = [0.0; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let mut t = *m;
        for r in 0..3 {
            t[r][c] = b[r];
        }
        *o = det3(&t) / det;
    }
    Some(out)
}

fn newton(a: &Anchor, mut x: V3) -> Option<V3> {
    for _ in 0..60 {
        let f = a.field(x);
        if norm(f) < 1e-13 {
            return Some(x);
        }
        let dx = solve3(&a.jac(x), f)?;
        for i in 0..3 {
            x[i] -= dx[i].clamp(-2.0, 2.0);
        }
    }
    (norm(a.field(x)) < 1e-9).then_some(x)
}

/// All equilibria found by multi-start Newton, nearest the origin first.
pub fn equilibria(a: &Anchor) -> Vec<V3> {
    let mut out: Vec<V3> = Vec::new();
    let mut starts: Vec<V3> = vec![[0.0; 3]];
    for &s in &[-20.0, -6.0, -2.5, -1.0, 1.0, 2.5, 6.0, 20.0] {
        starts.push([0.0, 0.0, s]);
        starts.push([s, s, s]);
        starts.push([s, -s, s * 0.5]);
        starts.push([s * 0.3, s, -s]);
    }
    for s in starts {
        if let Some(x) = newton(a, s) {
            if out
                .iter()
                .all(|e| norm([e[0] - x[0], e[1] - x[1], e[2] - x[2]]) > 1e-6)
            {
                out.push(x);
            }
        }
    }
    out.sort_by(|p, q| norm(*p).total_cmp(&norm(*q)));
    out
}

/// An anchor plus the world-space centre damping, written in system
/// coordinates: `F(x) − (κ/τ)(x − c)`.
pub struct Damped {
    pub anchor: Anchor,
    pub c: V3,
    pub kd: f64,
}

impl System for Damped {
    fn field(&self, x: V3) -> V3 {
        let mut f = self.anchor.field(x);
        for i in 0..3 {
            f[i] -= self.kd * (x[i] - self.c[i]);
        }
        f
    }
    fn jac(&self, x: V3) -> M3 {
        let mut j = self.anchor.jac(x);
        for (i, row) in j.iter_mut().enumerate() {
            row[i] -= self.kd;
        }
        j
    }
}

pub struct Sim {
    pub dt: f64,
    pub trans: f64,
    pub span: f64,
    /// Sampling interval for the statistics.
    pub sample: f64,
}

pub fn sim_for(kind: usize) -> Sim {
    let (dt, trans, span, sample) = match kind {
        0 => (0.02, 400.0, 6000.0, 0.1),
        1 => (0.005, 150.0, 1500.0, 0.025),
        2 => (0.004, 40.0, 500.0, 0.02),
        3 => (0.01, 400.0, 4000.0, 0.05),
        _ => (0.01, 200.0, 2000.0, 0.05),
    };
    Sim {
        dt,
        trans,
        span,
        sample,
    }
}

pub struct Measure {
    pub pts: Vec<V3>,
    pub vel: Vec<V3>,
    /// Exponents in system time (infinite memory).
    pub lam: [f64; 3],
    pub ok: bool,
}

/// Integrate from `x0`, discard the transient, sample the attractor.
pub fn measure<S: System>(sys: &S, x0: V3, sim: &Sim) -> Measure {
    let mut b = Benettin::new(x0, 0.0);
    b.advance(sys, sim.dt, (sim.trans / sim.dt) as usize);
    b.restart_average();
    let stride = (sim.sample / sim.dt).round().max(1.0) as usize;
    let n = (sim.span / (stride as f64 * sim.dt)) as usize;
    let mut pts = Vec::with_capacity(n);
    let mut vel = Vec::with_capacity(n);
    for _ in 0..n {
        b.advance(sys, sim.dt, stride);
        if !b.healthy() {
            return Measure {
                pts,
                vel,
                lam: [0.0; 3],
                ok: false,
            };
        }
        pts.push(b.x);
        vel.push(sys.field(b.x));
    }
    Measure {
        pts,
        vel,
        lam: b.exponents(),
        ok: true,
    }
}

/// Midpoint of the 2 %–98 % range of each coordinate.
pub fn bbox_centre(pts: &[V3]) -> V3 {
    let mut c = [0.0; 3];
    for (i, ci) in c.iter_mut().enumerate() {
        let mut v: Vec<f64> = pts.iter().map(|p| p[i]).collect();
        v.sort_by(|a, b| a.total_cmp(b));
        *ci = 0.5 * (v[v.len() / 50] + v[v.len() - 1 - v.len() / 50]);
    }
    c
}

/// Radius (from `c`) containing the fraction `q` of the samples.
pub fn radius_q(pts: &[V3], c: V3, q: f64) -> f64 {
    let mut rs: Vec<f64> = pts
        .iter()
        .map(|p| norm([p[0] - c[0], p[1] - c[1], p[2] - c[2]]))
        .collect();
    rs.sort_by(|a, b| a.total_cmp(b));
    rs[((q * rs.len() as f64) as usize).min(rs.len() - 1)]
}

/// Loop rate from up-crossings of the mean of each velocity component
/// (median over the three), with a small hysteresis band. Unlike a spectral
/// peak this is not fooled by period-doubled orbits, whose subharmonic can
/// out-shout the fundamental, nor by the slow meandering of a labyrinth.
pub fn crossing_omega(vel: &[V3], sample: f64) -> f64 {
    let n = vel.len();
    let mut rates = [0.0; 3];
    for (c, rate) in rates.iter_mut().enumerate() {
        let mean = vel.iter().map(|v| v[c]).sum::<f64>() / n as f64;
        let var = vel.iter().map(|v| (v[c] - mean).powi(2)).sum::<f64>() / n as f64;
        let h = 0.1 * var.sqrt();
        let (mut high, mut count) = (false, 0usize);
        for v in vel {
            let d = v[c] - mean;
            if d > h && !high {
                high = true;
                count += 1;
            } else if d < -h {
                high = false;
            }
        }
        *rate = count as f64 / (n as f64 * sample);
    }
    rates.sort_by(|a, b| a.total_cmp(b));
    TAU * rates[1]
}

pub fn parse_spec(s: &str) -> Vec<(f64, f64)> {
    s.split(',')
        .map(|item| match item.split_once(':') {
            Some((a, b)) => (a.parse().unwrap(), b.parse().unwrap()),
            None => {
                let v: f64 = item.parse().unwrap();
                (v, v)
            }
        })
        .collect()
}

pub fn kind_by_name(s: &str) -> usize {
    (0..KIND_COUNT)
        .find(|&k| NAMES[k].to_lowercase().starts_with(&s.to_lowercase()))
        .expect("unknown anchor name")
}
