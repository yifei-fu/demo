//! Small DSP building blocks shared by the voices.

use crate::rng::Rng;
use std::f32::consts::TAU;

/// A value that glides to its target.
#[derive(Clone, Copy)]
pub struct Ramp {
    pub cur: f32,
    pub target: f32,
}

impl Ramp {
    pub fn new(v: f32) -> Ramp {
        Ramp { cur: v, target: v }
    }

    pub fn tick(&mut self, k: f32) -> f32 {
        self.cur += (self.target - self.cur) * k;
        if (self.target - self.cur).abs() < 1e-7 {
            self.cur = self.target;
        }
        self.cur
    }
}

/// One-pole smoothing coefficient for a time constant `t` seconds, applied
/// every `dt` seconds.
pub fn smoothing(dt: f32, t: f32) -> f32 {
    1.0 - (-dt / t).exp()
}

/// One-pole low-pass coefficient for a cutoff in Hz.
pub fn lowpass_coeff(hz: f32, sample_rate: f32) -> f32 {
    1.0 - (-TAU * hz / sample_rate).exp()
}

/// Uniform white noise in [-1, 1).
pub fn white(rng: &mut Rng) -> f32 {
    (rng.next_u32() as i32) as f32 * (1.0 / 2_147_483_648.0)
}

/// Equal-power stereo gains for a pan in [-1, 1].
pub fn pan_gains(pan: f32) -> (f32, f32) {
    (
        ((1.0 - pan) * 0.5).max(0.0).sqrt(),
        ((1.0 + pan) * 0.5).max(0.0).sqrt(),
    )
}

/// State-variable filter (Chamberlin form). `f` is 2·sin(π·fc/sr) ≈ 2π·fc/sr,
/// `q` the damping (smaller = more resonant).
#[derive(Default, Clone, Copy)]
pub struct Svf {
    lo: f32,
    bp: f32,
}

/// The three outputs of an `Svf` step.
pub struct SvfOut {
    pub lo: f32,
    pub bp: f32,
}

impl Svf {
    pub fn process(&mut self, x: f32, f: f32, q: f32) -> SvfOut {
        let hi = x - self.lo - q * self.bp;
        self.bp += f * hi;
        self.lo += f * self.bp;
        SvfOut {
            lo: self.lo,
            bp: self.bp,
        }
    }
}

/// Second-order sections in a row need a frequency coefficient: keep it
/// stable (f < ~1.4) whatever the caller asks for.
pub fn svf_coeff(hz: f32, sample_rate: f32) -> f32 {
    (TAU * hz / sample_rate).min(1.2)
}
