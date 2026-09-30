//! A quiet additive drone on the root with slow LFOs; each preset weighs the
//! partials differently and the weights glide.

use super::dsp::smoothing;
use std::f64::consts::TAU;

/// Partial frequencies as multiples of the root.
const PARTIALS: [f64; 7] = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const GAIN: f32 = 0.045;

pub struct Drone {
    levels: [f32; 7],
    target: [f32; 7],
    phase: [f64; 7],
    lfo: f64,
}

impl Drone {
    pub fn new(levels: [f32; 7]) -> Drone {
        Drone {
            levels,
            target: levels,
            phase: [0.0; 7],
            lfo: 0.0,
        }
    }

    pub fn set_levels(&mut self, levels: [f32; 7]) {
        self.target = levels;
    }

    pub fn control(&mut self, dt: f32, _sample_rate: f32) {
        let k = smoothing(dt, 0.5);
        for (l, t) in self.levels.iter_mut().zip(&self.target) {
            *l += k * (t - *l);
        }
        self.lfo = (self.lfo + TAU * dt as f64 * 0.11) % TAU;
    }

    pub fn tick(&mut self, root_hz: f32, sample_rate: f32) -> f32 {
        let mut sum = 0.0f32;
        for (i, mul) in PARTIALS.iter().enumerate() {
            // A hair of detune per partial makes them beat slowly.
            let detune = 1.0 + 0.0007 * (i as f64 - 3.0);
            let f = root_hz as f64 * mul * detune;
            self.phase[i] = (self.phase[i] + TAU * f / sample_rate as f64) % TAU;
            let lfo = 0.6 + 0.4 * (self.lfo * (0.5 + 0.37 * i as f64) + i as f64).sin();
            sum += self.levels[i] * lfo as f32 * self.phase[i].sin() as f32;
        }
        sum * GAIN
    }
}
