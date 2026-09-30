//! Density weave of the Thomas labyrinth: `cargo run --release --example weave`.
#[path = "../tests/common/weave.rs"]
mod weave;

use axiom_core::anchors::THOMAS;
use axiom_core::law::{pure_law_with, write_params, Law, Placement, PARAMS_LEN};
use axiom_core::spectrum::classify_law;
use axiom_core::tables::Sample;

fn env<T: std::str::FromStr>(k: &str, d: T) -> T {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// Kaplan–Yorke dimension of a law from several initial conditions.
fn dimensions(law: &Law) -> Vec<f64> {
    use axiom_core::spectrum::{kaplan_yorke, Benettin};
    [[0.31, -0.22, 0.27], [-0.5, 0.4, 0.1], [0.2, 0.7, -0.6], [-0.3, -0.6, 0.5]]
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

fn main() {
    if let Ok(list) = std::env::var("DSCAN") {
        let l: f32 = env("L", 35.0);
        let tau: f32 = env("TAU", 13.0);
        for b in list.split(',').filter_map(|v| v.parse::<f32>().ok()) {
            let s = Sample { p: [b, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], c: [0.0; 3], l, tau, omega: 5.0 };
            let law = pure_law_with(THOMAS, 1.0, &s, 0.0);
            let d = dimensions(&law);
            let line: Vec<String> = d.iter().map(|v| format!("{v:.2}")).collect();
            println!("b {b:.4}: D {}", line.join(" "));
        }
        return;
    }
    let n: usize = env("N", 100_000);
    let secs: f64 = env("SECS", 5.0);
    if let Ok(list) = std::env::var("BS") {
        let l: f32 = env("L", 24.2);
        let tau: f32 = env("TAU", 9.0);
        for b in list.split(',').filter_map(|v| v.parse::<f32>().ok()) {
            let s = Sample { p: [b, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], c: [0.0; 3], l, tau, omega: 5.0 };
            let mut law = pure_law_with(THOMAS, 1.0, &s, 0.0);
            law.confine = env("CONFINE", law.confine);
            let (d, reg) = classify_law(&law, 25.0, 150.0, 0.02);
            let w = weave::weave(&law, n, env("BALL", 1.0), secs, 0.02);
            let mx = w.modes.iter().cloned().fold(0.0, f64::max);
            println!("b {b:.4} L {l} tau {tau}: D {d:.2} regime {reg}  weave {:.4} (max mode {mx:.4}, noise {:.4})", w.amplitude, w.noise);
        }
        return;
    }
    let seed: u32 = env("SEED", 1);
    let r: f64 = env("R", 1.0);
    let theta = Placement::new(seed).angle_of(THOMAS).unwrap();
    let mut block = [0.0f32; PARAMS_LEN];
    write_params((r * theta.cos()) as f32, (r * theta.sin()) as f32, seed, &mut block);
    let law = Law::from_block(&block);
    let s = law.slots[0].unwrap();
    let (d, reg) = classify_law(&law, 25.0, 150.0, 0.02);
    let w = weave::weave(&law, n, 1.0, secs, 0.02);
    println!("r {r} b {:.4} tau {:.3} L {:.3}: D {d:.2} regime {reg} weave {:.4} (noise {:.4})", s.p[0], s.tau, s.l, w.amplitude, w.noise);
}
