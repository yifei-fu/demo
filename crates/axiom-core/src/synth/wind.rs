//! Wind (stir, dive) and whoosh (shake): band-passed noise, shared by all presets.

use super::dsp::{smoothing, white, Svf};
use crate::rng::Rng;
use std::f64::consts::TAU;

/// A shake: the whoosh rises over 50 ms (soft, no click) and its level falls
/// as e^(-2t/1.3 s), so it stands ~7 dB proud of the music for half a second
/// and has settled after ~1.5 s.
const WHOOSH_GAIN: f32 = 1.8;
const WHOOSH_DECAY: f32 = 1.15;
const WHOOSH_ATTACK: f32 = 0.05;

#[derive(Default)]
pub struct Wind {
    lfo_phase: f64,
    lp: [f32; 2],
    band: [Svf; 2],
    whoosh_band: [Svf; 2],
    centre: f32,
    /// The shake's level: `whoosh` decays from 1, `swell` follows it softly.
    whoosh: f32,
    swell: f32,
}

impl Wind {
    /// A shake: the whoosh starts at full level and dies away.
    pub fn whoosh(&mut self) {
        self.whoosh = 1.0;
    }

    /// Slow updates: the band's centre drifts on a slow LFO, opens with dive.
    pub fn control(&mut self, dt: f32, sample_rate: f32, dive: f32) {
        self.lfo_phase = (self.lfo_phase + TAU * dt as f64 * 0.11) % TAU;
        let sweep = 0.5 + 0.5 * self.lfo_phase.sin() as f32;
        let target_hz = 380.0 + 900.0 * sweep + 500.0 * dive;
        let f = (std::f32::consts::TAU * target_hz / sample_rate).min(1.0);
        self.centre += (f - self.centre) * smoothing(dt, 0.5);
        self.whoosh *= (-dt / WHOOSH_DECAY).exp();
        if self.whoosh < 1e-4 {
            self.whoosh = 0.0;
        }
        self.swell += (self.whoosh - self.swell) * smoothing(dt, WHOOSH_ATTACK);
    }

    /// Stereo noise. `gain` is the preset's wind scale.
    pub fn tick(&mut self, stir: f32, dive: f32, gain: f32, rng: &mut Rng) -> [f32; 2] {
        let level = gain * (0.4 * stir * stir.sqrt() + 0.15 * dive);
        let sweep = (self.centre * (0.35 + 2.2 * self.swell)).min(1.0);
        let mut out = [0.0f32; 2];
        for (c, o) in out.iter_mut().enumerate() {
            self.lp[c] += 0.12 * (white(rng) - self.lp[c]);
            let band = self.band[c].bandpass(self.lp[c] * 2.5, self.centre, 0.9);
            let whoosh = self.whoosh_band[c].bandpass(white(rng), sweep, 0.6);
            *o = band * level + whoosh * WHOOSH_GAIN * self.swell * self.swell;
        }
        out
    }
}
