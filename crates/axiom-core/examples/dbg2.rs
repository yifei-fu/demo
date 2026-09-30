use axiom_core::anchors::*;
use axiom_core::law::*;
use axiom_core::rng::Rng;
use axiom_core::tables::sample;

pub fn mk(k0: usize, k1: usize, s: f64, r: f64, seed: u32, eta: f64) -> Law {
    let pl = Placement::new(seed);
    let slot = |k: usize, w: f64| {
        let t = sample(k, r);
        let mut p = [0.0; 8];
        for (d, v) in p.iter_mut().zip(t.p) {
            *d = v as f64;
        }
        Slot {
            kind: k,
            weight: w,
            tau: t.tau as f64,
            l: t.l as f64,
            c: t.c.map(|v| v as f64),
            omega: 1.5,
            p,
            cols: if std::env::var("IDROT").is_ok() {
                [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
            } else {
                pl.rot[k]
            },
        }
    };
    Law {
        r,
        theta: 0.0,
        kappa: kappa(r) - eta,
        confine: CONFINE_RADIUS,
        slots: [Some(slot(k0, 1.0 - s)), Some(slot(k1, s))],
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let r: f64 = args.get(1).map_or(0.85, |v| v.parse().unwrap());
    let eta: f64 = args.get(2).map_or(0.0, |v| v.parse().unwrap());
    let mut rng = Rng::new(5, 5);
    for (a, b) in [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)] {
        let (mut rest, mut wall, mut total) = (0, 0, 0);
        let mut row = String::new();
        for si in 1..=9 {
            let s = si as f64 / 10.0;
            let (mut rs, mut ws, mut n) = (0, 0, 0);
            for seed in 0..24u32 {
                let law = mk(a, b, s, r, seed, eta * 4.0 * s * (1.0 - s));
                let mut x = rng.in_ball(0.7);
                for _ in 0..5000 {
                    x = rk4(&law, x, 0.03);
                }
                let mut sp = 0.0f64;
                for _ in 0..200 {
                    x = rk4(&law, x, 0.03);
                    sp = sp.max(norm(law.field(x)));
                }
                n += 1;
                if sp < 0.01 {
                    rs += 1;
                    if norm(x) > 1.3 {
                        ws += 1;
                    }
                }
            }
            row += &format!(" {:2}", rs);
            rest += rs;
            wall += ws;
            total += n;
        }
        println!(
            "{}-{}: rest {:3}/{} (at wall {})  by s=0.1..0.9:{}",
            &NAMES[a][..3],
            &NAMES[b][..3],
            rest,
            total,
            wall,
            row
        );
    }
}
