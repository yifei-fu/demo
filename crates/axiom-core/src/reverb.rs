//! 8-line feedback delay network: mutually prime delay lengths, a Hadamard
//! feedback matrix, per-line damping. Everything is preallocated.

const LINES: usize = 8;
/// Delay lengths (samples at 48 kHz); rescaled and made prime for other rates.
const BASE: [f32; LINES] = [
    1031.0, 1327.0, 1523.0, 1801.0, 2027.0, 2311.0, 2593.0, 2857.0,
];
/// Output tap signs — two orthogonal-ish patterns give a decorrelated stereo pair.
const TAP_L: [f32; LINES] = [1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0];
const TAP_R: [f32; LINES] = [1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0];

fn is_prime(n: usize) -> bool {
    n >= 2
        && (2..)
            .take_while(|d| d * d <= n)
            .all(|d| !n.is_multiple_of(d))
}

fn next_prime(mut n: usize) -> usize {
    while !is_prime(n) {
        n += 1;
    }
    n
}

pub struct Fdn {
    lines: [Vec<f32>; LINES],
    pos: [usize; LINES],
    gain: [f32; LINES],
    lp: [f32; LINES],
    damp: f32,
    flip: bool,
    sample_rate: f32,
    target_gain: [f32; LINES],
    target_damp: f32,
}

impl Fdn {
    /// `rt60` in seconds; `damp` in 0..1 (higher = darker tail).
    pub fn new(sample_rate: f32, rt60: f32, damp: f32) -> Fdn {
        let scale = sample_rate / 48_000.0;
        let mut lens = [0usize; LINES];
        let mut prev = 0;
        for (i, l) in lens.iter_mut().enumerate() {
            *l = next_prime(((BASE[i] * scale) as usize).max(prev + 1));
            prev = *l;
        }
        let mut fdn = Fdn {
            lines: lens.map(|n| vec![0.0; n]),
            pos: [0; LINES],
            gain: [0.0; LINES],
            lp: [0.0; LINES],
            damp: 0.0,
            flip: false,
            sample_rate,
            target_gain: [0.0; LINES],
            target_damp: 0.0,
        };
        fdn.set_decay(rt60, damp);
        fdn.gain = fdn.target_gain;
        fdn.damp = fdn.target_damp;
        fdn
    }

    /// New tail length and darkness; `glide` moves the network there without
    /// a click. `rt60` in seconds, `damp` in 0..1 (higher = darker).
    pub fn set_decay(&mut self, rt60: f32, damp: f32) {
        for (g, line) in self.target_gain.iter_mut().zip(&self.lines) {
            *g = (-3.0 * std::f32::consts::LN_10 * line.len() as f32
                / (self.sample_rate * rt60.max(0.05)))
            .exp();
        }
        self.target_damp = damp.clamp(0.0, 0.95);
    }

    /// One control-rate step towards the target decay (`k` in 0..1).
    pub fn glide(&mut self, k: f32) {
        for (g, t) in self.gain.iter_mut().zip(&self.target_gain) {
            *g += k * (t - *g);
        }
        self.damp += k * (self.target_damp - self.damp);
    }

    pub fn lengths(&self) -> [usize; LINES] {
        std::array::from_fn(|i| self.lines[i].len())
    }

    /// One stereo sample in, one stereo (wet only) sample out.
    pub fn process(&mut self, in_l: f32, in_r: f32) -> (f32, f32) {
        // Tiny alternating offset keeps the loop out of denormal range.
        self.flip = !self.flip;
        let ad = if self.flip { 1e-20 } else { -1e-20 };
        let mut x: [f32; LINES] = std::array::from_fn(|i| {
            let out = self.lines[i][self.pos[i]];
            self.lp[i] += (1.0 - self.damp) * (out - self.lp[i]);
            self.gain[i] * self.lp[i]
        });
        let wet_l: f32 = TAP_L.iter().zip(&x).map(|(t, v)| t * v).sum();
        let wet_r: f32 = TAP_R.iter().zip(&x).map(|(t, v)| t * v).sum();
        hadamard(&mut x);
        for (i, v) in x.iter().enumerate() {
            let inject = if i % 2 == 0 { in_l } else { in_r };
            self.lines[i][self.pos[i]] = inject + v + ad;
            self.pos[i] += 1;
            if self.pos[i] == self.lines[i].len() {
                self.pos[i] = 0;
            }
        }
        (wet_l * 0.35, wet_r * 0.35)
    }
}

/// In-place fast Walsh–Hadamard transform, scaled to be orthonormal.
fn hadamard(x: &mut [f32; LINES]) {
    let mut h = 1;
    while h < LINES {
        for i in (0..LINES).step_by(h * 2) {
            for j in i..i + h {
                let (a, b) = (x[j], x[j + h]);
                x[j] = a + b;
                x[j + h] = a - b;
            }
        }
        h *= 2;
    }
    let s = 1.0 / (LINES as f32).sqrt();
    for v in x.iter_mut() {
        *v *= s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn energy(fdn: &mut Fdn, from: usize, to: usize, sr: usize) -> f32 {
        let mut e = 0.0;
        for n in 0..to * sr {
            let input = if n == 0 { 1.0 } else { 0.0 };
            let (l, r) = fdn.process(input, input);
            if n >= from * sr {
                e += l * l + r * r;
            }
        }
        e
    }

    #[test]
    fn delay_lengths_are_distinct_primes() {
        for sr in [44_100.0, 48_000.0, 96_000.0] {
            let lens = Fdn::new(sr, 3.0, 0.3).lengths();
            for (i, a) in lens.iter().enumerate() {
                assert!(is_prime(*a), "{a} is not prime");
                assert!(lens[i + 1..].iter().all(|b| b != a));
            }
        }
    }

    #[test]
    fn impulse_response_decays() {
        let sr = 48_000;
        let mut early = Fdn::new(sr as f32, 3.0, 0.3);
        let e_early = energy(&mut early, 0, 1, sr);
        let mut late = Fdn::new(sr as f32, 3.0, 0.3);
        let e_late = energy(&mut late, 6, 8, sr);
        assert!(e_early > 1e-3, "reverb produced no tail: {e_early}");
        // RT60 = 3 s: two seconds after t = 6 s the tail is >70 dB down.
        assert!(
            e_late < e_early * 1e-7,
            "tail did not decay: {e_late} vs {e_early}"
        );
    }

    #[test]
    fn hadamard_is_orthonormal() {
        let mut x = [1.0, -2.0, 0.5, 3.0, 0.0, 1.5, -1.0, 2.0];
        let e0: f32 = x.iter().map(|v| v * v).sum();
        hadamard(&mut x);
        let e1: f32 = x.iter().map(|v| v * v).sum();
        assert!((e0 - e1).abs() < 1e-4);
    }
}
