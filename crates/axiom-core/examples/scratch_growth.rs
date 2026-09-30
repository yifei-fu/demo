use axiom_core::anchors::{norm, rk4};
use axiom_core::law::{write_params, Law, PARAMS_LEN};

fn main() {
    let seed: u32 = std::env::var("SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let th = 180f64.to_radians();
    let mut block = [0.0f32; PARAMS_LEN];
    for r in [0.30, 0.32, 0.33, 0.34, 0.36, 0.40, 0.46] {
        write_params((r * th.cos()) as f32, (r * th.sin()) as f32, seed, &mut block);
        let law = Law::from_block(&block);
        let mut x = [1e-4, 0.0, 0.0];
        let mut out = String::new();
        let mut t = 0.0;
        for k in 0..400 {
            x = rk4(&law, x, 0.05);
            t += 0.05;
            if k % 40 == 39 {
                out += &format!(" t{t:.0}:{:.1e}", norm(x));
            }
        }
        println!("r {r:.2}:{out}");
    }
}
