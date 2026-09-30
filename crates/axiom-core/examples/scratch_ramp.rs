//! Scratch: Ink onset along ramps.
use axiom_core::law::{write_params, Law, PARAMS_LEN};
use axiom_core::spectrum::classify_law;
use axiom_core::synth::Synth;

const SR: f32 = 48_000.0;

fn onset(preset: u32, root: f32, seed: u32, angle: f64, rmax: f64, secs: f64) -> (Option<f64>, Option<f64>, u64) {
    let mut synth = Synth::new(SR, seed);
    synth.set(4, preset as f32);
    synth.set(5, root);
    synth.set(6, 0.1);
    synth.set(7, 1.5);
    let lead = 6.0;
    let n = ((lead + secs) * SR as f64) as usize;
    let th = angle.to_radians();
    let mut block = [0.0f32; PARAMS_LEN];
    let mut next = 0usize;
    let (mut first, mut third) = (None, None);
    let mut c0 = None;
    let mut s = 0;
    while s < n {
        if s >= next {
            let t = s as f64 / SR as f64 - lead;
            let r = if t <= 0.0 { 0.0 } else { rmax * (t / secs).min(1.0) };
            write_params((r * th.cos()) as f32, (r * th.sin()) as f32, seed, &mut block);
            synth.set_law(&block);
            next += 1600;
        }
        synth.render(128);
        s += 128;
        let t = s as f64 / SR as f64 - lead;
        let r = if t <= 0.0 { 0.0 } else { rmax * (t / secs).min(1.0) };
        if std::env::var("TRACE").is_ok() && (s / 128) % 375 == 0 {
            let d = synth.debug_probes();
            let line: Vec<String> = d
                .iter()
                .map(|(x, sp, _)| format!("[{:+.3},{:+.3},{:+.3}|{:.3}]", x[0], x[1], x[2], sp))
                .collect();
            println!("t {t:.1} r {r:.2} {}", line.join(" "));
        }
        let c = synth.pluck_count();
        if t >= 0.0 && c0.is_none() {
            c0 = Some(c);
        }
        let c = c - c0.unwrap_or(c);
        if c >= 1 && first.is_none() && t > 0.0 {
            first = Some(r);
        }
        if c >= 4 && third.is_none() && t > 0.0 {
            third = Some(r);
        }
    }
    (first, third, synth.pluck_count() - c0.unwrap_or(0))
}

/// First r (0.01 steps) where the law is not a fixed point.
fn critical(seed: u32, angle: f64) -> Option<f64> {
    let th = angle.to_radians();
    let mut block = [0.0f32; PARAMS_LEN];
    for i in 0..90 {
        let r = i as f64 * 0.01;
        write_params((r * th.cos()) as f32, (r * th.sin()) as f32, seed, &mut block);
        let (_, reg) = classify_law(&Law::from_block(&block), 25.0, 40.0, 0.025);
        if reg != 0 {
            return Some(r);
        }
    }
    None
}

fn still(seed: u32, r: f64, angle: f64) -> u64 {
    let mut synth = Synth::new(SR, seed);
    synth.set(4, 1.0);
    synth.set(5, 65.4);
    synth.set(6, -1.0);
    synth.set(7, 0.0);
    let th = angle.to_radians();
    let mut block = [0.0f32; PARAMS_LEN];
    write_params((r * th.cos()) as f32, (r * th.sin()) as f32, seed, &mut block);
    synth.set_law(&block);
    let mut s = 0;
    let mut c0 = 0;
    while s < 25 * 48_000 {
        synth.render(128);
        s += 128;
        if s == 5 * 48_000 {
            c0 = synth.pluck_count();
        }
    }
    synth.pluck_count() - c0
}

fn main() {
    if std::env::var("STILL").is_ok() {
        for seed in [1u32, 7, 42, 90210] {
            let mut line = String::new();
            for r in [0.0, 0.1, 0.2, 0.25, 0.28] {
                for a in [0.0, 90.0, 180.0, 270.0] {
                    line += &format!(" {}", still(seed, r, a));
                }
                line += " |";
            }
            println!("seed {seed:>5} stray plucks in 20 s at r=0,.1,.2,.25,.28 x angles 0,90,180,270:{line}");
        }
        return;
    }
    let secs: f64 = std::env::var("SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(6.0);
    let seeds: Vec<u32> = std::env::var("SEEDS").ok().map(|v| v.split(',').filter_map(|x| x.parse().ok()).collect()).unwrap_or(vec![1, 7, 42, 90210]);
    let angles: Vec<f64> = (0..8).map(|i| i as f64 * 45.0).collect();
    for seed in seeds {
        for &a in &angles {
            let rc = critical(seed, a);
            let (f, t, c) = onset(1, 65.4, seed, a, 0.9, secs);
            println!(
                "seed {seed:>5} angle {a:>5.0}  r_crit {:>5}  first pluck r {:>5}  4th pluck r {:>5}  plucks {c}",
                rc.map_or("-".into(), |v| format!("{v:.2}")),
                f.map_or("-".into(), |v| format!("{v:.2}")),
                t.map_or("-".into(), |v| format!("{v:.2}")),
            );
        }
    }
}
