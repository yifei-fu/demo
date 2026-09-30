//! Preset 1 · Ink — a Poincaré-section rhythm.
//!
//! The probes run at rhythm speed (a few Hz) instead of audio rate. Every time
//! a probe crosses the plane z = 0 upward, a Karplus–Strong pluck sounds; its
//! pitch is a just-intonation degree chosen by where it crossed (x, quantised).
//! A cycle therefore gives a steady ostinato, a torus a quasi-periodic pattern,
//! chaos an irregular but tonal rain, a fixed point silence. The continuous
//! probe voice is a very quiet hum on the last pitch of each probe.

use super::dsp::{pan_gains, white};
use super::{Ctx, ProbeView, PROBES};
use crate::rng::Rng;
use std::f32::consts::TAU;

/// Just-intonation major pentatonic over two octaves.
const SCALE: [f32; 10] = [
    1.0,
    9.0 / 8.0,
    5.0 / 4.0,
    3.0 / 2.0,
    5.0 / 3.0,
    2.0,
    9.0 / 4.0,
    5.0 / 2.0,
    3.0,
    10.0 / 3.0,
];
const VOICES: usize = 16;
/// A probe must dip this far below the plane before it can strike again, so
/// jitter around z = 0 cannot machine-gun a note.
const HYSTERESIS: f32 = 0.02;
const LOWEST_HZ: f32 = 45.0;

/// One Karplus–Strong string: a delay line with a two-point average and a
/// first-order all-pass for fractional tuning (so the just-intonation ratios
/// stay in tune at high pitch).
struct Pluck {
    buf: Vec<f32>,
    len: usize,
    pos: usize,
    prev: f32,
    ap_x: f32,
    ap_y: f32,
    a: f32,
    decay: f32,
    gains: (f32, f32),
    env: f32,
    age: usize,
}

impl Pluck {
    fn new(capacity: usize) -> Pluck {
        Pluck {
            buf: vec![0.0; capacity],
            len: 2,
            pos: 0,
            prev: 0.0,
            ap_x: 0.0,
            ap_y: 0.0,
            a: 0.0,
            decay: 0.0,
            gains: (0.0, 0.0),
            env: 0.0,
            age: 0,
        }
    }

    fn active(&self) -> bool {
        self.env > 3e-4 || self.age < 2 * self.len
    }

    fn strike(
        &mut self,
        freq: f32,
        sample_rate: f32,
        amp: f32,
        pan: f32,
        bright: f32,
        rng: &mut Rng,
    ) {
        let delay = sample_rate / freq;
        self.len = ((delay - 1.0).floor() as usize).clamp(2, self.buf.len());
        // Loop delay = len + 0.5 (the average) + all-pass fraction in [0.5, 1.5).
        let frac = (delay - 0.5 - self.len as f32).clamp(0.5, 1.5);
        self.a = (1.0 - frac) / (1.0 + frac);
        let t60 = (1.6 * (220.0 / freq).powf(0.4)).clamp(0.35, 2.5);
        self.decay = 10f32.powf(-3.0 / (freq * t60));
        // Burst of low-passed noise, normalised and stripped of DC.
        let norm = 1.0 / (bright / (2.0 - bright) / 3.0).sqrt();
        let mut s = 0.0;
        let mut mean = 0.0;
        for v in self.buf[..self.len].iter_mut() {
            s += bright * (white(rng) - s);
            *v = s;
            mean += s;
        }
        mean /= self.len as f32;
        for v in self.buf[..self.len].iter_mut() {
            *v = (*v - mean) * norm * amp;
        }
        self.pos = 0;
        self.prev = 0.0;
        self.ap_x = 0.0;
        self.ap_y = 0.0;
        self.env = amp;
        self.age = 0;
        let (gl, gr) = pan_gains(pan);
        self.gains = (gl, gr);
    }

    fn step(&mut self) -> f32 {
        let out = self.buf[self.pos];
        let avg = 0.5 * (out + self.prev);
        self.prev = out;
        let y = self.a * avg + self.ap_x - self.a * self.ap_y;
        self.ap_x = avg;
        self.ap_y = y;
        self.buf[self.pos] = y * self.decay;
        self.pos += 1;
        if self.pos >= self.len {
            self.pos = 0;
        }
        self.env = out.abs().max(self.env * 0.9995);
        self.age += 1;
        out
    }
}

pub struct Ink {
    sample_rate: f32,
    pool: Vec<Pluck>,
    armed: [bool; PROBES],
    since: [f32; PROBES],
    /// Pitch of each probe's last pluck (Hz) and its hum.
    pitch: [f32; PROBES],
    hum_phase: [f32; PROBES],
    hum_amp: [f32; PROBES],
    plucks: u64,
}

impl Ink {
    pub fn new(sample_rate: f32) -> Ink {
        let capacity = (sample_rate / LOWEST_HZ) as usize + 4;
        Ink {
            sample_rate,
            pool: (0..VOICES).map(|_| Pluck::new(capacity)).collect(),
            armed: [false; PROBES],
            since: [1.0; PROBES],
            pitch: [220.0; PROBES],
            hum_phase: [0.0; PROBES],
            hum_amp: [0.0; PROBES],
            plucks: 0,
        }
    }

    pub fn plucks(&self) -> u64 {
        self.plucks
    }

    fn strike(&mut self, k: usize, p: &ProbeView, ctx: &Ctx, rng: &mut Rng) {
        let degree =
            (((p.x[0] as f32 + 1.0) * 0.5 * SCALE.len() as f32) as usize).min(SCALE.len() - 1);
        // The two lowest probes sing an octave down.
        let octave = if k < 2 { 0.5 } else { 1.0 };
        let freq = (ctx.root_hz * 4.0 * octave * SCALE[degree])
            .max(LOWEST_HZ)
            .min(0.4 * self.sample_rate);
        let v = (p.speed / 0.35).min(1.0);
        let vigour = v * (2.0 - v);
        let slot = self
            .pool
            .iter()
            .position(|v| !v.active())
            .unwrap_or_else(|| {
                (0..VOICES)
                    .min_by(|&a, &b| self.pool[a].env.total_cmp(&self.pool[b].env))
                    .unwrap_or(0)
            });
        self.pool[slot].strike(
            freq,
            self.sample_rate,
            0.3 * vigour,
            p.pan,
            0.3 + 0.4 * vigour,
            rng,
        );
        self.pitch[k] = freq;
        self.plucks += 1;
    }

    pub fn tick(&mut self, probes: &[ProbeView; PROBES], ctx: &Ctx, rng: &mut Rng) -> (f32, f32) {
        let (mut l, mut r) = (0.0, 0.0);
        for (k, p) in probes.iter().enumerate() {
            self.since[k] += 1.0 / self.sample_rate;
            if p.dz < -ctx.hyst {
                self.armed[k] = true;
            } else if self.armed[k] && p.dz >= 0.0 && self.since[k] >= ctx.gap {
                self.armed[k] = false;
                self.since[k] = 0.0;
                self.strike(k, p, ctx, rng);
            }
            // The quiet continuous voice: a hum that lives only while the probe moves.
            let target = 0.012 * (p.speed / 0.4).clamp(0.0, 1.0);
            self.hum_amp[k] += 0.0008 * (target - self.hum_amp[k]);
            self.hum_phase[k] = (self.hum_phase[k] + TAU * self.pitch[k] / self.sample_rate) % TAU;
            let hum = self.hum_phase[k].sin() * self.hum_amp[k];
            let (gl, gr) = pan_gains(p.pan);
            l += hum * gl;
            r += hum * gr;
        }
        for v in self.pool.iter_mut().filter(|v| v.active()) {
            let y = v.step();
            l += y * v.gains.0;
            r += y * v.gains.1;
        }
        (l, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pitch of a string from the autocorrelation peak of its ring.
    fn measured_hz(freq: f32, sr: f32) -> f32 {
        let mut rng = Rng::new(1, 1);
        let mut string = Pluck::new((sr / LOWEST_HZ) as usize + 4);
        string.strike(freq, sr, 0.3, 0.0, 0.5, &mut rng);
        let ring: Vec<f32> = (0..(0.4 * sr) as usize).map(|_| string.step()).collect();
        let (lo, hi) = ((sr / freq * 0.8) as usize, (sr / freq * 1.2) as usize + 1);
        let corr = |lag: usize| {
            ring[..ring.len() - lag]
                .iter()
                .zip(&ring[lag..])
                .map(|(a, b)| a * b)
                .sum::<f32>()
        };
        let best = (lo..hi)
            .max_by(|&a, &b| corr(a).total_cmp(&corr(b)))
            .unwrap();
        // parabolic refinement of the peak
        let (a, b, c) = (corr(best - 1), corr(best), corr(best + 1));
        let off = 0.5 * (a - c) / (a - 2.0 * b + c);
        sr / (best as f32 + off)
    }

    #[test]
    fn plucks_are_in_tune_across_the_range() {
        for sr in [44_100.0, 48_000.0] {
            for f in [110.0, 165.0, 220.0, 330.0, 660.0, 1_100.0, 1_760.0] {
                let got = measured_hz(f, sr);
                assert!(
                    (got / f - 1.0).abs() < 0.004,
                    "{f} Hz at {sr}: measured {got}"
                );
            }
        }
    }
}
