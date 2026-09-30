//! Calibration of the radial routes (DESIGN.md §3.1).
//!
//!   cargo run --release --example calibrate                  # solve + print + check
//!   cargo run --release --example calibrate -- write         # also rewrite src/tables.rs
//!   cargo run --release --example calibrate -- scan thomas 1.5:0.1 n=25
//!   cargo run --release --example calibrate -- grid aizawa 0:1.3,0.7,0:0.9,3.5,0.25,0.1
//!
//! `scan` sweeps a linear path through parameter space and prints equilibria,
//! attractor size, frequency and Lyapunov spectrum so routes can be designed
//! by eye; `grid` draws a regime chart over two parameters. The default mode
//! measures every row of `routes.rs` (system time), derives c, L, τ, ω and
//! then verifies the finished tables in world coordinates.

mod routes;
mod tools;

use axiom_core::anchors::{eigenvalues, norm, Anchor, System, NAMES, V3};
use axiom_core::law::pure_law_with;
use axiom_core::spectrum::{classify, kaplan_yorke, regime, Benettin, REST_SPEED};
use axiom_core::tables::{sample_rows, COLS};
use routes::{Centre, Spec};
use std::sync::atomic::{AtomicUsize, Ordering};
use tools::*;

/// Target characteristic angular frequency in world time (rad per world unit).
const OMEGA_WORLD: f64 = 1.5;
/// Centre damping κ(r) = KAPPA0 (1 − r/KAPPA_R)² for r < KAPPA_R (see `law::kappa`).
const KAPPA0: f64 = 1.0;
const KAPPA_R: f64 = 0.4;

fn kappa(r: f64) -> f64 {
    KAPPA0 * (1.0 - r / KAPPA_R).max(0.0).powi(2)
}

fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(usize, &T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let out = std::sync::Mutex::new((0..items.len()).map(|_| None).collect::<Vec<Option<R>>>());
    std::thread::scope(|sc| {
        for _ in 0..4 {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= items.len() {
                    break;
                }
                let r = f(i, &items[i]);
                out.lock().unwrap()[i] = Some(r);
            });
        }
    });
    out.into_inner()
        .unwrap()
        .into_iter()
        .map(|o| o.unwrap())
        .collect()
}

// ------------------------------------------------------------------ scan --

fn start_point(a: &Anchor) -> V3 {
    equilibria(a)
        .first()
        .map(|e| [e[0] + 0.01, e[1] - 0.007, e[2] + 0.004])
        .unwrap_or([0.1, 0.1, 0.1])
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
        let pstr: Vec<String> = p.iter().map(|v| format!("{v:.4}")).collect();
        println!("t={t:.3} p=[{}]", pstr.join(", "));
        for e in equilibria(&a) {
            let ev = eigenvalues(&a.jac(e));
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
                sym_max(&a.jac(e))
            );
        }
        let m = measure(&a, start_point(&a), &sim);
        if !m.ok {
            println!("    ESCAPED");
            continue;
        }
        let c = bbox_centre(&m.pts);
        let d = kaplan_yorke(m.lam);
        println!(
            "    centre ({:+.3},{:+.3},{:+.3}) r99 {:.3} omega {:.3}  lam ({:+.4},{:+.4},{:+.3}) D {:.3} regime {}",
            c[0], c[1], c[2], radius_q(&m.pts, c, 0.99), crossing_omega(&m.vel, sim.sample),
            m.lam[0], m.lam[1], m.lam[2], d, regime(m.lam, d)
        );
    }
}

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
        }
    }
    let ranged: Vec<usize> = (0..spec.len())
        .filter(|&i| spec[i].0 != spec[i].1)
        .collect();
    let (ix, iy) = (ranged[0], ranged[1]);
    let cells: Vec<(usize, usize)> = (0..ny).flat_map(|j| (0..nx).map(move |i| (i, j))).collect();
    let chars = par_map(&cells, |_, &(i, j)| {
        let mut p: Vec<f64> = spec.iter().map(|s| s.0).collect();
        p[ix] = spec[ix].0 + (spec[ix].1 - spec[ix].0) * i as f64 / (nx - 1) as f64;
        p[iy] = spec[iy].0 + (spec[iy].1 - spec[iy].0) * j as f64 / (ny - 1) as f64;
        let a = Anchor::new(kind, &p);
        let m = measure(&a, start_point(&a), &sim);
        if !m.ok {
            return 'X';
        }
        let d = kaplan_yorke(m.lam);
        ['.', 'o', 'T', '#', '@'][regime(m.lam, d) as usize]
    });
    println!(
        "x = p{ix} {:.3}..{:.3}   y = p{iy} {:.3}..{:.3} (top = y max)   . fixed  o cycle  T torus  # strange  @ labyrinth",
        spec[ix].0, spec[ix].1, spec[iy].0, spec[iy].1
    );
    for j in (0..ny).rev() {
        println!("{}", chars[j * nx..(j + 1) * nx].iter().collect::<String>());
    }
}

// ----------------------------------------------------------- calibration --

#[derive(Clone)]
struct Row {
    r: f64,
    p: [f64; 8],
    /// Continuation equilibrium (the fixed point at the world origin).
    c_eq: V3,
    x0: V3,
    c: V3,
    tau: f64,
    l: f64,
    /// Characteristic frequency in system time.
    omega: f64,
    r99: f64,
    /// Mean |F| along the attractor in system time.
    speed_sys: f64,
    regime: u8,
    d: f64,
    lam_w: [f64; 3],
    ok: bool,
}

fn dist3(a: V3, b: V3) -> f64 {
    norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
}

fn max_imag(a: &Anchor, e: V3) -> f64 {
    eigenvalues(&a.jac(e))
        .iter()
        .map(|v| v.1.abs())
        .fold(0.0, f64::max)
}

fn init_rows(spec: &Spec) -> Vec<Row> {
    let mut prev: V3 = [0.0; 3];
    let mut out = Vec::new();
    for (r, p) in &spec.rows {
        let a = Anchor::new(spec.kind, p);
        let eqs = equilibria(&a);
        let stable = |e: &V3| eigenvalues(&a.jac(*e)).iter().all(|ev| ev.0 < 0.0);
        let dist = |e: &V3| norm([e[0] - prev[0], e[1] - prev[1], e[2] - prev[2]]);
        let nearest = |list: Vec<V3>| list.into_iter().min_by(|a, b| dist(a).total_cmp(&dist(b)));
        let c_eq = match spec.centre {
            Centre::Zero => Some([0.0; 3]),
            Centre::LorenzAxis => Some([0.0, 0.0, (a.p[1] - 1.0).max(0.0)]),
            // Follow the equilibrium branch: the stable one at r = 0, then the nearest.
            Centre::Eq if out.is_empty() => nearest(eqs.iter().copied().filter(stable).collect()),
            Centre::Eq => nearest(eqs.clone()),
        }
        .expect("route row without equilibrium");
        prev = c_eq;
        let near = eqs
            .iter()
            .copied()
            .min_by(|x, y| {
                let d = |e: &V3| norm([e[0] - c_eq[0], e[1] - c_eq[1], e[2] - c_eq[2]]);
                d(x).total_cmp(&d(y))
            })
            .unwrap_or(c_eq);
        out.push(Row {
            r: *r,
            p: a.p,
            c_eq,
            x0: [near[0] + 0.01, near[1] - 0.007, near[2] + 0.004],
            c: c_eq,
            tau: 1.0,
            l: spec.l_min,
            omega: 1.0,
            r99: 0.0,
            speed_sys: 0.0,
            regime: 0,
            d: 0.0,
            lam_w: [0.0; 3],
            ok: true,
        });
    }
    out
}

fn solve_route(spec: &Spec) -> Vec<Row> {
    let mut rows = init_rows(spec);
    let sim = sim_for(spec.kind);
    for _pass in 0..4 {
        let measured = par_map(&rows, |_, row| {
            let sys = Damped {
                anchor: Anchor {
                    kind: spec.kind,
                    p: row.p,
                },
                c: row.c,
                kd: kappa(row.r) / row.tau,
            };
            measure(&sys, row.x0, &sim)
        });
        for (row, m) in rows.iter_mut().zip(&measured) {
            row.ok = m.ok;
            if !m.ok {
                continue;
            }
            row.lam_w = [m.lam[0] * row.tau, m.lam[1] * row.tau, m.lam[2] * row.tau];
            row.d = kaplan_yorke(row.lam_w);
            row.regime = regime(row.lam_w, row.d);
            let fixed = row.regime == 0;
            row.c = match spec.centre {
                Centre::Zero => [0.0; 3],
                Centre::Eq if fixed => {
                    // The equilibrium the trajectory settled on (the origin
                    // one only while it is stable).
                    let end = m.pts.last().copied().unwrap_or(row.x0);
                    equilibria(&Anchor {
                        kind: spec.kind,
                        p: row.p,
                    })
                    .into_iter()
                    .min_by(|p, q| dist3(*p, end).total_cmp(&dist3(*q, end)))
                    .unwrap_or(row.c_eq)
                }
                Centre::Eq => bbox_centre(&m.pts),
                Centre::LorenzAxis if fixed => row.c_eq,
                Centre::LorenzAxis => [0.0, 0.0, bbox_centre(&m.pts)[2]],
            };
            row.r99 = if fixed {
                0.0
            } else {
                radius_q(&m.pts, row.c, 0.99)
            };
            row.speed_sys = if fixed {
                0.0
            } else {
                m.vel.iter().map(|v| norm(*v)).sum::<f64>() / m.vel.len() as f64
            };
            row.omega = if fixed {
                let end = m.pts.last().copied().unwrap_or(row.x0);
                let a = Anchor {
                    kind: spec.kind,
                    p: row.p,
                };
                equilibria(&a)
                    .into_iter()
                    .min_by(|p, q| dist3(*p, end).total_cmp(&dist3(*q, end)))
                    .map_or(0.0, |e| max_imag(&a, e))
            } else {
                crossing_omega(&m.vel, sim.sample)
            };
        }
        // c: light smoothing over runs of non-fixed rows (bbox estimates are noisy).
        let cs: Vec<V3> = rows.iter().map(|r| r.c).collect();
        for i in 1..rows.len() - 1 {
            if rows[i - 1].regime != 0 && rows[i].regime != 0 && rows[i + 1].regime != 0 {
                for (k, c) in rows[i].c.iter_mut().enumerate() {
                    *c = 0.25 * cs[i - 1][k] + 0.5 * cs[i][k] + 0.25 * cs[i + 1][k];
                }
            }
        }
        // ω: light median filter over the non-fixed rows, then τ and L.
        let raw: Vec<f64> = rows.iter().map(|r| r.omega).collect();
        for i in 1..rows.len() - 1 {
            if rows[i].regime != 0 {
                let mut w = [raw[i - 1], raw[i], raw[i + 1]];
                w.sort_by(|a, b| a.total_cmp(b));
                rows[i].omega = w[1];
            }
        }
        // L: the 99 % radius should fill `r99` of the ball (a bigger target
        // for the rim lets the wall clip the labyrinth to "volume-filling").
        let target = |r: f64| {
            let t = ((r - 0.6) / 0.4).clamp(0.0, 1.0);
            spec.r99 + (spec.r99_rim - spec.r99) * t * t * (3.0 - 2.0 * t)
        };
        let want: Vec<f64> = rows
            .iter()
            .map(|r| (r.r99 / target(r.r)).max(spec.l_min))
            .collect();
        for i in 0..rows.len() {
            let (a, b) = (want[i.saturating_sub(1)], want[(i + 1).min(rows.len() - 1)]);
            rows[i].l = 0.25 * a + 0.5 * want[i] + 0.25 * b;
        }
        // τ: ω_world = 1.5, unless that leaves the particles too slow.
        for row in rows.iter_mut() {
            let tau = if row.omega > 0.05 {
                (OMEGA_WORLD / row.omega).min(spec.tau_cap)
            } else {
                spec.tau_cap
            };
            let speed = tau * row.speed_sys / row.l;
            row.tau = if row.regime >= 3 && speed < spec.min_speed {
                (tau * spec.min_speed / speed).min(spec.tau_cap)
            } else {
                tau
            };
        }
        // Fixed-point rows carry no reliable frequency (a node has none): ramp τ
        // and L linearly from their r = 0 value to that of the first
        // oscillating row (L starts small so the unit ball stays inside the
        // fixed point's basin).
        if let Some(h) = rows.iter().position(|r| r.regime != 0) {
            let (r0, rh) = (rows[0].r, rows[h].r);
            let (t0, th, lh) = (rows[0].tau, rows[h].tau, rows[h].l);
            for row in rows.iter_mut().take(h) {
                let t = (row.r - r0) / (rh - r0);
                if row.r > r0 {
                    row.tau = t0 + (th - t0) * t;
                }
                row.l = spec.l_start + (lh - spec.l_start) * t;
            }
        }
    }
    rows
}

fn to_table(rows: &[Row]) -> Vec<[f32; COLS]> {
    rows.iter()
        .map(|w| {
            let mut v = [0.0f32; COLS];
            v[0] = w.r as f32;
            for i in 0..8 {
                v[1 + i] = w.p[i] as f32;
            }
            v[9] = w.c[0] as f32;
            v[10] = w.c[1] as f32;
            v[11] = w.c[2] as f32;
            v[12] = w.l as f32;
            v[13] = w.tau as f32;
            v[14] = if w.regime == 0 {
                OMEGA_WORLD
            } else {
                w.omega * w.tau
            } as f32;
            v
        })
        .collect()
}

fn fmt(v: f32) -> String {
    let s = format!("{:.5}", v);
    let s = s.trim_end_matches('0');
    if s.ends_with('.') {
        format!("{s}0")
    } else {
        s.to_string()
    }
}

fn table_source(specs: &[Spec], tables: &[Vec<[f32; COLS]>]) -> String {
    let mut s = String::new();
    let kinds: Vec<String> = specs.iter().map(|sp| sp.kind.to_string()).collect();
    s += &format!(
        "pub const ANCHORS: [usize; {}] = [{}];\n",
        specs.len(),
        kinds.join(", ")
    );
    s += &format!("pub const KAPPA0: f64 = {KAPPA0:?};\npub const KAPPA_R: f64 = {KAPPA_R:?};\n");
    s += "#[rustfmt::skip]\nstatic ROUTES: [&[[f32; COLS]]; 5] = [\n";
    for (kind, name) in NAMES.iter().enumerate() {
        match specs.iter().position(|sp| sp.kind == kind) {
            Some(i) => {
                s += &format!("    &[ // {name}\n");
                for row in &tables[i] {
                    let cells: Vec<String> = row.iter().map(|v| fmt(*v)).collect();
                    s += &format!("        [{}],\n", cells.join(", "));
                }
                s += "    ],\n";
            }
            None => s += "    &[], // dropped\n",
        }
    }
    s += "];\n";
    s
}

fn write_tables(src: &str) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tables.rs");
    let old = std::fs::read_to_string(path).unwrap();
    let a = old.find("// BEGIN GENERATED\n").unwrap() + "// BEGIN GENERATED\n".len();
    let b = old.find("// END GENERATED").unwrap();
    std::fs::write(path, format!("{}{}{}", &old[..a], src, &old[b..])).unwrap();
    println!("wrote {path}");
}

// ----------------------------------------------------------------- check --

/// World-space verification of a finished table on a fine r grid.
fn check(kind: usize, rows: &[[f32; COLS]]) {
    println!(
        "\n== {} (world coordinates, confinement on) ==",
        NAMES[kind]
    );
    println!(
        "  r     reg   D    lambda(world)                 r99   max   |mean|  speed  L      tau   omega"
    );
    let rs: Vec<f64> = (0..=40).map(|i| i as f64 / 40.0).collect();
    let out = par_map(&rs, |_, &r| {
        let law = pure_law_with(kind, r, &sample_rows(rows, r), kappa(r));
        let mut b = Benettin::new([0.31, -0.22, 0.27], 0.0);
        b.advance(&law, 0.01, 8000);
        b.restart_average();
        let mut pts = Vec::new();
        for _ in 0..3000 {
            b.advance(&law, 0.01, 10);
            pts.push(b.x);
        }
        let l = b.exponents();
        let speeds: Vec<f64> = pts.iter().map(|p| norm(law.field(*p))).collect();
        let speed = speeds.iter().sum::<f64>() / speeds.len() as f64;
        let resting = speeds.iter().all(|v| *v < REST_SPEED);
        let (d, code) = classify(l, resting);
        let mean = pts
            .iter()
            .fold([0.0; 3], |m, p| [m[0] + p[0], m[1] + p[1], m[2] + p[2]]);
        let mean = norm([
            mean[0] / pts.len() as f64,
            mean[1] / pts.len() as f64,
            mean[2] / pts.len() as f64,
        ]);
        let rmax = pts.iter().map(|p| norm(*p)).fold(0.0, f64::max);
        (
            l,
            d,
            code,
            radius_q(&pts, [0.0; 3], 0.99),
            rmax,
            mean,
            speed,
            b.healthy(),
        )
    });
    for (r, (l, d, reg, r99, rmax, mean, speed, ok)) in rs.iter().zip(out) {
        let s = sample_rows(rows, *r);
        println!(
            " {r:.3}   {reg}   {d:.2}  ({:+.3},{:+.3},{:+.3})  {r99:.2}  {rmax:.2}  {mean:.2}   {speed:.2}  {:6.2} {:.2}  {:.2}{}",
            l[0], l[1], l[2], s.l, s.tau, s.omega, if ok { "" } else { "  ESCAPED" }
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("scan") => return scan(&args[1..]),
        Some("grid") => return grid(&args[1..]),
        _ => {}
    }
    let only: Option<usize> = args
        .iter()
        .find(|a| !a.starts_with('-') && *a != "write")
        .map(|a| kind_by_name(a));
    let specs: Vec<Spec> = routes::all();
    let mut tables = Vec::new();
    for spec in &specs {
        if only.is_some_and(|k| k != spec.kind) {
            tables.push(Vec::new());
            continue;
        }
        let rows = solve_route(spec);
        println!("\n## {} — solved rows (system time)", NAMES[spec.kind]);
        println!("  r     reg  D    lam_w(0,1,2)                c(x,y,z)                 r99     L       tau    om_sys om_w");
        for w in &rows {
            println!(
                " {:.3}  {}   {:.2} ({:+.3},{:+.3},{:+.3}) ({:+.3},{:+.3},{:+.3})  {:7.3} {:7.3} {:6.3} {:6.3} {:5.2}{}",
                w.r, w.regime, w.d, w.lam_w[0], w.lam_w[1], w.lam_w[2], w.c[0], w.c[1], w.c[2],
                w.r99, w.l, w.tau, w.omega, w.omega * w.tau, if w.ok { "" } else { "  ESCAPED" }
            );
        }
        let table = to_table(&rows);
        check(spec.kind, &table);
        tables.push(table);
    }
    if only.is_none() {
        let src = table_source(&specs, &tables);
        println!("\n{src}");
        if args.iter().any(|a| a == "write") {
            write_tables(&src);
        }
    }
}
