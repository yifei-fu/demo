use axiom_core::anchors::rk4;
use axiom_core::law::{write_params, Law, PARAMS_LEN};

fn main() {
    let seed: u32 = std::env::var("SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let angle: f64 = std::env::var("ANGLE").ok().and_then(|v| v.parse().ok()).unwrap_or(180.0);
    let th = angle.to_radians();
    let mut block = [0.0f32; PARAMS_LEN];
    for i in 0..19 {
        let r = 0.2 + i as f64 * 0.04;
        write_params((r * th.cos()) as f32, (r * th.sin()) as f32, seed, &mut block);
        let law = Law::from_block(&block);
        println!("r {r:.2} omega {:.3}", law.omega());
        for start in [[0.3, -0.2, 0.25], [-0.4, 0.3, -0.2], [0.05, 0.05, 0.05]] {
            let mut x = start;
            for _ in 0..30_000 {
                x = rk4(&law, x, 0.01);
            }
            let (mut lo, mut hi) = ([1e9; 3], [-1e9f64; 3]);
            for _ in 0..8_000 {
                x = rk4(&law, x, 0.01);
                for c in 0..3 {
                    lo[c] = f64::min(lo[c], x[c]);
                    hi[c] = f64::max(hi[c], x[c]);
                }
            }
            println!(
                "    x [{:.3},{:.3}] y [{:.3},{:.3}] z [{:.3},{:.3}]",
                lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]
            );
        }
    }
}
