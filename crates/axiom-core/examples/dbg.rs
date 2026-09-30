use axiom_core::anchors::*;
use axiom_core::law::*;
use axiom_core::spectrum::*;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u32 = args[1].parse().unwrap();
    let r: f64 = args[2].parse().unwrap();
    let pl = Placement::new(seed);
    let deg_step = 4;
    for deg in (0..360).step_by(deg_step) {
        let th = (deg as f64).to_radians();
        let mut b = [0.0f32; 68];
        write_params((r * th.cos()) as f32, (r * th.sin()) as f32, seed, &mut b);
        let law = Law::from_block(&b);
        let mut bet = Benettin::new([0.31, -0.22, 0.27], 0.0);
        bet.advance(&law, 0.025, 1000);
        bet.restart_average();
        bet.advance(&law, 0.025, 4000);
        let l = bet.exponents();
        let d = kaplan_yorke(l);
        let w = pl.weights(th);
        println!("{deg:3} {}({:.2}) {}({:.2}) reg {} D {:.2} lam ({:+.3},{:+.3},{:+.3}) |x| {:.2} kappa {:+.2}", &NAMES[w[0].0][..3], w[0].1, &NAMES[w[1].0][..3], w[1].1, regime(l, d), d, l[0], l[1], l[2], norm(bet.x), law.kappa);
    }
}
