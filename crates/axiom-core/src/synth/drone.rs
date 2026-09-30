//! A quiet additive drone on the root with slow LFOs; each preset weighs the
//! partials differently and the weights glide.

use super::dsp::smoothing;
use std::f64::consts::TAU;

/// One partial of the drone.
struct Partial {
    /// Frequency as a multiple of the root.
    mul: f64,
    /// A hair of detune, different for each, so the partials beat slowly.
    detune: f64,
    /// Rate of its level LFO relative to the shared one, and its phase.
    lfo_rate: f64,
    lfo_phase: f64,
}

const PARTIALS: [Partial; 5] = [
    Partial {
        mul: 1.0,
        detune: -0.0014,
        lfo_rate: 0.87,
        lfo_phase: 1.0,
    },
    Partial {
        mul: 2.0,
        detune: 0.0,
        lfo_rate: 1.61,
        lfo_phase: 3.0,
    },
    Partial {
        mul: 3.0,
        detune: 0.0007,
        lfo_rate: 1.98,
        lfo_phase: 4.0,
    },
    Partial {
        mul: 4.0,
        detune: 0.0014,
        lfo_rate: 2.35,
        lfo_phase: 5.0,
    },
    Partial {
        mul: 6.0,
        detune: 0.0021,
        lfo_rate: 2.72,
        lfo_phase: 6.0,
    },
];
const GAIN: f32 = 0.045;

pub struct Drone {
    levels: [f32; 5],
    target: [f32; 5],
    phase: [f64; 5],
    lfo: f64,
}

impl Drone {
    pub fn new(levels: [f32; 5]) -> Drone {
        Drone {
            levels,
            target: levels,
            phase: [0.0; 5],
            lfo: 0.0,
        }
    }

    pub fn set_levels(&mut self, levels: [f32; 5]) {
        self.target = levels;
    }

    /// Slow update: the levels glide to their target, the shared LFO turns.
    pub fn control(&mut self, dt: f32) {
        let k = smoothing(dt, 0.5);
        for (l, t) in self.levels.iter_mut().zip(&self.target) {
            *l += k * (t - *l);
        }
        self.lfo = (self.lfo + TAU * dt as f64 * 0.11) % TAU;
    }

    pub fn tick(&mut self, root_hz: f32, sample_rate: f32) -> f32 {
        let mut sum = 0.0f32;
        for (i, partial) in PARTIALS.iter().enumerate() {
            let f = root_hz as f64 * partial.mul * (1.0 + partial.detune);
            self.phase[i] = (self.phase[i] + TAU * f / sample_rate as f64) % TAU;
            let lfo = 0.6 + 0.4 * (self.lfo * partial.lfo_rate + partial.lfo_phase).sin();
            sum += self.levels[i] * lfo as f32 * self.phase[i].sin() as f32;
        }
        sum * GAIN
    }
}
