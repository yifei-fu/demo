//! Small DSP building blocks shared by the voices.

use super::{Ctx, SWELL_HEADROOM};
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

/// State-variable filter (Chamberlin form), used here as a band-pass. `f` is
/// 2·sin(π·fc/sr) ≈ 2π·fc/sr (keep it below ~1.4 for stability), `q` the
/// damping (smaller = more resonant).
#[derive(Default, Clone, Copy)]
pub struct Svf {
    lo: f32,
    bp: f32,
}

impl Svf {
    /// One step; returns the band-pass output.
    pub fn bandpass(&mut self, x: f32, f: f32, q: f32) -> f32 {
        let hi = x - self.lo - q * self.bp;
        self.bp += f * hi;
        self.lo += f * self.bp;
        self.bp
    }
}

/// Onset swell: a gain that stops a signal's level from rising faster than the
/// swell rate (`SWELL_RATE_DB`). A peak detector (instant attack, short hold)
/// follows the signal; a ceiling climbs toward `SWELL_HEADROOM` times that peak
/// at the swell rate, and falls back to it quickly. The gain is
/// `ceiling / peak` while the peak is above the ceiling, else 1: a steady or
/// falling signal, or a rise within the headroom, passes untouched.
#[derive(Clone, Copy, Default)]
pub struct Rise {
    peak: f32,
    ceil: f32,
}

impl Rise {
    /// Let the ceiling jump to `ceil` (a shake is not an onset).
    pub fn lift(&mut self, ceil: f32) {
        self.ceil = ceil;
    }

    /// The gain for a sample of size `x`. `floor` is the level the ceiling
    /// never falls below, and so where a swell starts from.
    pub fn gain(&mut self, x: f32, floor: f32, ctx: &Ctx) -> f32 {
        self.peak = x.abs().max(self.peak * ctx.swell_hold);
        let goal = SWELL_HEADROOM * self.peak + floor;
        self.ceil = if goal > self.ceil {
            goal.min(self.ceil.max(floor) * ctx.swell_up)
        } else {
            self.ceil + ctx.swell_down * (goal - self.ceil)
        };
        if self.peak > self.ceil {
            self.ceil / self.peak
        } else {
            1.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Loudness (dB) of consecutive 100 ms windows of `x`.
    fn levels(x: &[f32], sr: f32) -> Vec<f32> {
        x.chunks_exact((0.1 * sr) as usize)
            .map(|c| 10.0 * (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 + 1e-12).log10())
            .collect()
    }

    #[test]
    fn rise_swells_an_onset_and_leaves_a_steady_tone_alone() {
        let sr = 48_000.0;
        let ctx = Ctx::new(sr, 55.0);
        let mut rise = Rise::default();
        // A tone that is silent for a second, then jumps to full level.
        let tone = |n: usize| {
            if n < sr as usize {
                0.0
            } else {
                0.4 * (TAU * 220.0 * n as f32 / sr).sin()
            }
        };
        let out: Vec<f32> = (0..(4.0 * sr) as usize)
            .map(|n| tone(n) * rise.gain(tone(n), 0.012, &ctx))
            .collect();
        let l = levels(&out[sr as usize..], sr);
        let steps: Vec<f32> = l.windows(2).map(|w| w[1] - w[0]).collect();
        let worst = steps.iter().cloned().fold(f32::MIN, f32::max);
        assert!(worst < 2.6, "rises {worst} dB in 100 ms: {steps:?}");
        // ... and arrives: the last window is the tone's own level.
        let full = levels(
            &(0..sr as usize)
                .map(|n| tone(n + sr as usize))
                .collect::<Vec<_>>(),
            sr,
        );
        assert!((l[l.len() - 1] - full[0]).abs() < 0.5, "{l:?}");
        // A steady tone is passed untouched once settled.
        let last = &out[(3 * sr as usize)..];
        let original: Vec<f32> = (3 * sr as usize..4 * sr as usize).map(tone).collect();
        assert!(last
            .iter()
            .zip(&original)
            .all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn rise_does_not_pump_a_wandering_level() {
        // Chaos wanders in level by a few dB every fraction of a second. That
        // must pass at unity: only a real onset is slowed.
        let sr = 48_000.0;
        let ctx = Ctx::new(sr, 55.0);
        let mut rise = Rise::default();
        let mut rng = crate::rng::Rng::new(3, 3);
        let mut lowpassed = 0.0f32;
        let mut sum_db = 0.0;
        let mut worst = 0.0f32;
        let n = (8.0 * sr) as usize;
        for i in 0..n {
            let t = i as f32 / sr;
            // ±3 dB at 1.3 Hz and ±2 dB at 0.4 Hz, over a noisy carrier
            let envelope =
                0.3 * (1.0 + 0.4 * (TAU * 1.3 * t).sin()) * (1.0 + 0.25 * (TAU * 0.4 * t).sin());
            lowpassed += 0.2 * (white(&mut rng) - lowpassed);
            let x = envelope * (2.0 * lowpassed + (TAU * 180.0 * t).sin());
            let g = rise.gain(x, 0.012, &ctx);
            if i > (2.0 * sr) as usize {
                let db = 20.0 * g.log10();
                sum_db += db;
                worst = worst.min(db);
            }
        }
        let mean_db = sum_db / (n as f32 - 2.0 * sr);
        assert!(mean_db > -0.3, "mean gain {mean_db} dB");
        assert!(worst > -3.0, "worst gain {worst} dB");
    }
}
