//! Calibration of the radial routes (DESIGN.md §3.1).
//!
//!   cargo run --release --example calibrate                 # tables for tables.rs
//!   cargo run --release --example calibrate -- scan thomas 1.5:0.1 n=25
//!   cargo run --release --example calibrate -- scan aizawa -0.5:0.95,0.7,0:0.6,3.5,0.25,0.1
//!
//! `scan` sweeps a linear path through parameter space and prints, per point,
//! the equilibria (with stability), the attractor size, frequency and Lyapunov
//! spectrum, so that routes can be designed by looking at them.

use axiom_core::anchors::{self, dot, mat_vec, norm, Anchor, System, KIND_COUNT, M3, NAMES, V3};
use axiom_core::spectrum::{kaplan_yorke, regime, Benettin};
use std::f64::consts::{PI, TAU};

/// Target characteristic angular frequency in world time (rad per world unit).
const OMEGA_WORLD: f64 = 1.5;

// ----------------------------------------------------------------- maths --

/// Eigenvalues of a real 3×3 matrix as (re, im) pairs.
fn eigs(m: &M3) -> [(f64, f64); 3] {
    let tr = m[0][0] + m[1][1] + m[2][2];
    let s2 = (m[0][0] * m[1][1] - m[0][1] * m[1][0])
        + (m[0][0] * m[2][2] - m[0][2] * m[2][0])
        + (m[1][1] * m[2][2] - m[1][2] * m[2][1]);
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    // λ³ + aλ² + bλ + c
    let (a, b, c) = (-tr, s2, -det);
    let p = b - a * a / 3.0;
    let q = 2.0 * a * a * a / 27.0 - a * b / 3.0 + c;
    let shift = -a / 3.0;
    let disc = (q / 2.0).powi(2) + (p / 3.0).powi(3);
    if disc > 0.0 {
        let s = disc.sqrt();
        let u = (-q / 2.0 + s).cbrt();
        let v = (-q / 2.0 - s).cbrt();
        [
            (u + v + shift, 0.0),
            (-(u + v) / 2.0 + shift, 3f64.sqrt() / 2.0 * (u - v)),
            (-(u + v) / 2.0 + shift, -3f64.sqrt() / 2.0 * (u - v)),
        ]
    } else {
        let m2 = 2.0 * (-p / 3.0).max(0.0).sqrt();
        let arg = if m2 == 0.0 {
            0.0
        } else {
            (3.0 * q / (p * m2)).clamp(-1.0, 1.0)
        };
        let phi = arg.acos();
        let t = |k: f64| (m2 * ((phi - TAU * k) / 3.0).cos() + shift, 0.0);
        [t(0.0), t(1.0), t(2.0)]
    }
}

/// Largest eigenvalue of the symmetric part of `m` (1-norm growth bound).
fn sym_max(m: &M3) -> f64 {
    let s = [
        [m[0][0], 0.5 * (m[0][1] + m[1][0]), 0.5 * (m[0][2] + m[2][0])],
        [0.5 * (m[0][1] + m[1][0]), m[1][1], 0.5 * (m[1][2] + m[2][1])],
        [0.5 * (m[0][2] + m[2][0]), 0.5 * (m[1][2] + m[2][1]), m[2][2]],
    ];
    eigs(&s).iter().map(|e| e.0).fold(f64::MIN, f64::max)
}

fn solve3(m: &M3, b: V3) -> Option<V3> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let mut out = [0.0; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let mut t = *m;
        for r in 0..3 {
            t[r][c] = b[r];
        }
        *o = (t[0][0] * (t[1][1] * t[2][2] - t[1][2] * t[2][1])
            - t[0][1] * (t[1][0] * t[2][2] - t[1][2] * t[2][0])
            + t[0][2] * (t[1][0] * t[2][1] - t[1][1] * t[2][0]))
            / det;
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

/// All equilibria found by multi-start Newton (deduplicated).
fn equilibria(a: &Anchor) -> Vec<V3> {
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
            if out.iter().all(|e| norm([e[0] - x[0], e[1] - x[1], e[2] - x[2]]) > 1e-6) {
                out.push(x);
            }
        }
    }
    out.sort_by(|p, q| norm(*p).total_cmp(&norm(*q)));
    out
}

// ------------------------------------------------------------ measuring --

struct Measure {
    centre: V3,
    /// Radius (from `c_ref`) containing 99 % of the samples, and the max.
    r99: f64,
    rmax: f64,
    /// Angular frequency in system time (max up-crossing rate over coordinates).
    omega: f64,
    lam: [f64; 3],
    d: f64,
    regime: u8,
    /// Whether the trajectory stayed finite.
    ok: bool,
}

struct Sim {
    dt: f64,
    trans: f64,
    span: f64,
    /// Sampling interval for the statistics.
    sample: f64,
}

fn sim_for(kind: usize) -> Sim {
    match kind {
        anchors::THOMAS => Sim { dt: 0.02, trans: 400.0, span: 6000.0, sample: 0.1 },
        anchors::AIZAWA => Sim { dt: 0.005, trans: 150.0, span: 1500.0, sample: 0.025 },
        anchors::LORENZ => Sim { dt: 0.004, trans: 40.0, span: 500.0, sample: 0.02 },
        anchors::ROSSLER => Sim { dt: 0.01, trans: 400.0, span: 4000.0, sample: 0.05 },
        _ => Sim { dt: 0.01, trans: 200.0, span: 2000.0, sample: 0.05 },
    }
}

fn measure<S: System>(sys: &S, x0: V3, sim: &Sim, c_ref: Option<V3>) -> Measure {
    let mut b = Benettin::new(x0, 0.0);
    b.advance(sys, sim.dt, (sim.trans / sim.dt) as usize);
    let x = b.x;
    b.reset(x);
    let stride = (sim.sample / sim.dt).round().max(1.0) as usize;
    let n = (sim.span / (stride as f64 * sim.dt)) as usize;
    let mut pts: Vec<V3> = Vec::with_capacity(n);
    for _ in 0..n {
        b.advance(sys, sim.dt, stride);
        if !b.healthy() {
            return Measure {
                centre: [0.0; 3],
                r99: f64::INFINITY,
                rmax: f64::INFINITY,
                omega: 0.0,
                lam: [0.0; 3],
                d: 0.0,
                regime: 9,
                ok: false,
            };
        }
        pts.push(b.x);
    }
    let mut mean = [0.0; 3];
    for p in &pts {
        for i in 0..3 {
            mean[i] += p[i] / n as f64;
        }
    }
    let centre = c_ref.unwrap_or(mean);
    let mut rs: Vec<f64> = pts
        .iter()
        .map(|p| norm([p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]))
        .collect();
    rs.sort_by(|a, b| a.total_cmp(b));
    // up-crossings of the mean with a small hysteresis band
    let mut best = 0.0f64;
    for i in 0..3 {
        let var = pts.iter().map(|p| (p[i] - mean[i]).powi(2)).sum::<f64>() / n as f64;
        let h = 0.05 * var.sqrt();
        let (mut high, mut count) = (false, 0usize);
        for p in &pts {
            let d = p[i] - mean[i];
            if d > h && !high {
                high = true;
                count += 1;
            } else if d < -h {
                high = false;
            }
        }
        best = best.max(count as f64 / (n as f64 * stride as f64 * sim.dt));
    }
    let lam = b.exponents();
    let d = kaplan_yorke_sys(lam);
    Measure {
        centre: mean,
        r99: rs[(0.99 * n as f64) as usize],
        rmax: rs[n - 1],
        omega: TAU * best,
        lam,
        d,
        regime: regime(lam, d),
        ok: true,
    }
}

/// System-time exponents are much larger than the world-time regime tolerance
/// would be, so callers rescale before classification; this keeps D consistent.
fn kaplan_yorke_sys(l: [f64; 3]) -> f64 {
    kaplan_yorke(l)
}

// ------------------------------------------------------------------ scan --

fn parse_spec(s: &str) -> Vec<(f64, f64)> {
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

fn kind_by_name(s: &str) -> usize {
    NAMES
        .iter()
        .position(|n| n.to_lowercase().starts_with(&s.to_lowercase()))
        .expect("unknown anchor name")
}

fn scan(args: &[String]) {
    let kind = kind_by_name(&args[0]);
    let spec = parse_spec(&args[1]);
    let mut n = 21;
    let mut sim = sim_for(kind);
    for a in &args[2..] {
        if let Some(v) = a.strip_prefix("n=") {
            n = v.parse().unwrap();
        } else if let Some(v) = a.strip_prefix("span=") {
            sim.span = v.parse().unwrap();
        } else if let Some(v) = a.strip_prefix("trans=") {
            sim.trans = v.parse().unwrap();
        }
    }
    println!("scan {} ({} points)", NAMES[kind], n);
    for i in 0..n {
        let t = i as f64 / (n - 1).max(1) as f64;
        let p: Vec<f64> = spec.iter().map(|(a, b)| a + (b - a) * t).collect();
        let a = Anchor::new(kind, &p);
        let eqs = equilibria(&a);
        let pstr: Vec<String> = p.iter().map(|v| format!("{v:.4}")).collect();
        println!("t={t:.3} p=[{}]", pstr.join(", "));
        for e in &eqs {
            let ev = eigs(&a.jac(*e));
            let es: Vec<String> = ev
                .iter()
                .map(|(re, im)| {
                    if im.abs() > 1e-9 {
                        format!("{re:+.3}{im:+.3}i")
                    } else {
                        format!("{re:+.3}")
                    }
                })
                .collect();
            println!(
                "    eq ({:+.3},{:+.3},{:+.3}) eig {}  sym {:+.3}",
                e[0],
                e[1],
                e[2],
                es.join(" "),
                sym_max(&a.jac(*e))
            );
        }
        let x0 = eqs
            .iter()
            .min_by(|p, q| norm(**p).total_cmp(&norm(**q)))
            .map(|e| [e[0] + 0.01, e[1] - 0.007, e[2] + 0.004])
            .unwrap_or([0.1, 0.1, 0.1]);
        let m = measure(&a, x0, &sim, None);
        println!(
            "    centre ({:+.3},{:+.3},{:+.3}) r99 {:.3} rmax {:.3} omega {:.3}  lam ({:+.4},{:+.4},{:+.3}) D {:.3} regime {}{}",
            m.centre[0], m.centre[1], m.centre[2], m.r99, m.rmax, m.omega,
            m.lam[0], m.lam[1], m.lam[2], m.d, m.regime, if m.ok { "" } else { " (ESCAPED)" }
        );
    }
}

/// Regime chart over two ranged parameters (first = x axis, second = y axis).
fn grid(args: &[String]) {
    let kind = kind_by_name(&args[0]);
    let spec = parse_spec(&args[1]);
    let (mut nx, mut ny) = (48usize, 24usize);
    let mut sim = sim_for(kind);
    sim.span = 300.0;
    sim.trans = 100.0;
    for a in &args[2..] {
        if let Some(v) = a.strip_prefix("nx=") {
            nx = v.parse().unwrap();
        } else if let Some(v) = a.strip_prefix("ny=") {
            ny = v.parse().unwrap();
        } else if let Some(v) = a.strip_prefix("span=") {
            sim.span = v.parse().unwrap();
        } else if let Some(v) = a.strip_prefix("trans=") {
            sim.trans = v.parse().unwrap();
        }
    }
    let ranged: Vec<usize> = (0..spec.len()).filter(|&i| spec[i].0 != spec[i].1).collect();
    let (ix, iy) = (ranged[0], ranged[1]);
    let cells: Vec<(usize, usize)> = (0..ny).flat_map(|j| (0..nx).map(move |i| (i, j))).collect();
    let results = std::sync::Mutex::new(vec![b' '; nx * ny]);
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|sc| {
        for _ in 0..4 {
            sc.spawn(|| loop {
                let k = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if k >= cells.len() {
                    break;
                }
                let (i, j) = cells[k];
                let mut p: Vec<f64> = spec.iter().map(|s| s.0).collect();
                let tx = i as f64 / (nx - 1) as f64;
                let ty = j as f64 / (ny - 1) as f64;
                p[ix] = spec[ix].0 + (spec[ix].1 - spec[ix].0) * tx;
                p[iy] = spec[iy].0 + (spec[iy].1 - spec[iy].0) * ty;
                let a = Anchor::new(kind, &p);
                let eqs = equilibria(&a);
                let x0 = eqs
                    .iter()
                    .min_by(|p, q| norm(**p).total_cmp(&norm(**q)))
                    .map(|e| [e[0] + 0.01, e[1] - 0.007, e[2] + 0.004])
                    .unwrap_or([0.1, 0.1, 0.1]);
                let m = measure(&a, x0, &sim, None);
                let ch = match m.regime {
                    0 => b'.',
                    1 => b'o',
                    2 => b'T',
                    3 => b'#',
                    4 => b'@',
                    _ => b'X',
                };
                results.lock().unwrap()[j * nx + i] = ch;
            });
        }
    });
    let res = results.lock().unwrap();
    println!(
        "x = p{ix} {:.3}..{:.3}   y = p{iy} {:.3}..{:.3} (top = y max)   . fixed  o cycle  T torus  # strange  @ labyrinth",
        spec[ix].0, spec[ix].1, spec[iy].0, spec[iy].1
    );
    for j in (0..ny).rev() {
        println!("{}", String::from_utf8_lossy(&res[j * nx..(j + 1) * nx]));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("scan") => return scan(&args[1..]),
        Some("grid") => return grid(&args[1..]),
        _ => {}
    }
    let _ = (dot, mat_vec, PI, KIND_COUNT);
    println!("(routes not defined yet)");
}
