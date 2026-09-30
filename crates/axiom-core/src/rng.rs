//! Tiny seeded PRNG (PCG32) — no dependencies, deterministic everywhere.

#[derive(Clone)]
pub struct Rng {
    state: u64,
    inc: u64,
}

impl Rng {
    /// `stream` separates independent sequences drawn from the same seed.
    pub fn new(seed: u32, stream: u32) -> Self {
        let mut rng = Rng {
            state: 0,
            inc: ((stream as u64) << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(splitmix(seed as u64));
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in [0, 1).
    pub fn f64(&mut self) -> f64 {
        let hi = (self.next_u32() >> 5) as f64; // 27 bits
        let lo = (self.next_u32() >> 6) as f64; // 26 bits
        (hi * 67_108_864.0 + lo) / 9_007_199_254_740_992.0
    }

    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f64()
    }

    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f64 {
        self.range(-1.0, 1.0)
    }

    /// Standard normal (Box–Muller).
    pub fn gauss(&mut self) -> f64 {
        let u = self.f64().max(1e-12);
        let v = self.f64();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }

    /// Uniform integer in 0..n.
    pub fn below(&mut self, n: usize) -> usize {
        ((self.f64() * n as f64) as usize).min(n.saturating_sub(1))
    }

    /// Uniform point inside the ball of radius `r`.
    pub fn in_ball(&mut self, r: f64) -> [f64; 3] {
        loop {
            let p = [self.signed(), self.signed(), self.signed()];
            if p[0] * p[0] + p[1] * p[1] + p[2] * p[2] <= 1.0 {
                return [p[0] * r, p[1] * r, p[2] * r];
            }
        }
    }
}

fn splitmix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
