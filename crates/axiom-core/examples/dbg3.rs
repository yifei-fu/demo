use axiom_core::anchors::*;
use axiom_core::law::*;
use axiom_core::spectrum::*;
fn main() {
    for (l, tau) in [(25.0, 2.5), (18.0, 7.0), (14.0, 7.0), (12.0, 6.0)] {
        for b in [0.03, 0.02, 0.015, 0.01, 0.007, 0.005] {
            let mut p = [0.0; 8];
            p[0] = b;
            let law = Law {
                r: 1.0,
                theta: 0.0,
                kappa: 0.0,
                confine: CONFINE_RADIUS,
                slots: [
                    Some(Slot {
                        kind: 0,
                        weight: 1.0,
                        tau,
                        l,
                        c: [0.0; 3],
                        omega: 1.5,
                        p,
                        cols: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                    }),
                    None,
                ],
            };
            let mut bet = Benettin::new([0.31, -0.22, 0.27], 0.0);
            bet.advance(&law, 0.01, 6000);
            bet.restart_average();
            let (mut sp, mut n, mut mx) = (0.0, 0, 0.0f64);
            for _ in 0..8000 {
                bet.advance(&law, 0.01, 10);
                sp += norm(law.field(bet.x));
                n += 1;
                mx = mx.max(norm(bet.x));
            }
            let ls = bet.exponents();
            let d = kaplan_yorke(ls);
            println!("L={l} tau={tau} b={b}: D {d:.2} lam ({:+.3},{:+.3},{:+.3}) mean speed {:.2} max|x| {:.2}", ls[0], ls[1], ls[2], sp / n as f64, mx);
        }
    }
}
