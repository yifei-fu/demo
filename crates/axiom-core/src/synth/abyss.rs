//! Preset 3 · Abyss — deep and oceanic. Probes run an octave lower, through a
//! resonant low-pass swept by their z coordinate, under slow swells; stir
//! raises bubbles (short rising sine pings) instead of wind. Above the deep
//! body floats a shimmer: one soft, twinkling light per probe high in the
//! harmonic series of the root, brighter as its probe moves, so the voice
//! reaches a phone speaker and not only headphones.

use super::dsp::{pan_gains, svf_coeff, white, Svf};
use super::{Ctx, ProbeView, LEVEL_REF, PROBES};
use crate::rng::Rng;
use std::f32::consts::TAU;

/// The shimmer's partials, as multiples of the root: a just-intonation major
/// chord (12 : 15 : 18 : 20 : 24 : 30) five octaves up, where a phone speaker
/// can speak. Each one belongs to a probe and wakes with it.
const SHIMMER: [f32; PROBES] = [12.0, 15.0, 18.0, 20.0, 24.0, 30.0];
/// Partials above this many Hz are folded down by octaves.
const SHIMMER_MAX: f32 = 2_200.0;
/// Weight of the probes' deep body, of the lights at rest and of the extra
/// light a moving probe wakes.
const BODY: f32 = 0.40;
const GLOW_REST: f32 = 0.03;
const GLOW_MOVING: f32 = 0.42;
const BUBBLES: usize = 8;
/// Bubbles per second at full stir.
const BUBBLE_RATE: f32 = 16.0;

#[derive(Default, Clone, Copy)]
struct Bubble {
    phase: f32,
    freq: f32,
    amp: f32,
    pan: f32,
}

pub struct Abyss {
    filter: [Svf; PROBES],
    ms: [f32; PROBES],
    swell: [f32; PROBES],
    swell_rate: [f32; PROBES],
    shimmer: [f32; PROBES],
    twinkle: [f32; PROBES],
    twinkle_rate: [f32; PROBES],
    bubbles: [Bubble; BUBBLES],
    next: usize,
}

impl Abyss {
    pub fn new(rng: &mut Rng) -> Abyss {
        Abyss {
            filter: [Svf::default(); PROBES],
            ms: [0.0; PROBES],
            swell: std::array::from_fn(|k| k as f32 * 1.1),
            // 0.04–0.11 Hz: a swell every 9–25 seconds.
            swell_rate: std::array::from_fn(|_| 0.04 + 0.07 * rng.f64() as f32),
            shimmer: [0.0; PROBES],
            twinkle: std::array::from_fn(|k| k as f32 * 2.3),
            // 0.13–0.40 Hz: each light comes and goes every few seconds.
            twinkle_rate: std::array::from_fn(|_| 0.13 + 0.27 * rng.f64() as f32),
            bubbles: [Bubble::default(); BUBBLES],
            next: 0,
        }
    }

    pub fn tick(&mut self, probes: &[ProbeView; PROBES], ctx: &Ctx, rng: &mut Rng) -> (f32, f32) {
        let (mut l, mut r) = (0.0, 0.0);
        for (k, p) in probes.iter().enumerate() {
            // z sweeps the cutoff between ~70 Hz and ~900 Hz.
            let z = p.x[2] as f32;
            let cutoff = 70.0 + 850.0 * (0.5 + 0.5 * (1.6 * z).tanh());
            let lo = self.filter[k]
                .process(p.dc, svf_coeff(cutoff, ctx.sr), 0.4)
                .lo;
            self.swell[k] = (self.swell[k] + TAU * self.swell_rate[k] / ctx.sr) % TAU;
            let swell = 0.65 + 0.35 * self.swell[k].sin();
            // Resonance can pile up energy: level the filtered signal.
            self.ms[k] += ctx.rms_k * (lo * lo - self.ms[k]);
            let rms = self.ms[k].sqrt();
            let gain = if rms > LEVEL_REF {
                LEVEL_REF / rms
            } else {
                1.0
            };
            // Bioluminescence: a soft light per probe, brighter as it moves.
            let mut hz = SHIMMER[k] * ctx.root_hz;
            while hz > SHIMMER_MAX {
                hz *= 0.5;
            }
            self.shimmer[k] = (self.shimmer[k] + TAU * hz / ctx.sr) % TAU;
            self.twinkle[k] = (self.twinkle[k] + TAU * self.twinkle_rate[k] / ctx.sr) % TAU;
            let glow = 0.5 + 0.5 * self.twinkle[k].sin();
            let awake = (rms / LEVEL_REF).min(1.0) * p.swell;
            let light = self.shimmer[k].sin() * glow * glow * (GLOW_REST + GLOW_MOVING * awake);
            let v = (lo * gain * swell * p.swell * BODY + light) * p.amp * 0.95;
            let (gl, gr) = pan_gains(p.pan);
            l += v * gl;
            r += v * gr;
        }
        // Bubbles: a Poisson stream whose rate follows stir².
        if white(rng) * 0.5 + 0.5 < ctx.stir * ctx.stir * BUBBLE_RATE / ctx.sr {
            let b = &mut self.bubbles[self.next];
            self.next = (self.next + 1) % BUBBLES;
            *b = Bubble {
                phase: 0.0,
                freq: 240.0 + 700.0 * (white(rng) * 0.5 + 0.5),
                amp: 0.05 + 0.07 * (white(rng) * 0.5 + 0.5),
                pan: white(rng) * 0.7,
            };
        }
        let rise = 1.0 + 30.0 / ctx.sr; // frequency climbs ~e^30t: doubles in ~25 ms
        let fall = (-1.0 / (0.03 * ctx.sr)).exp();
        for b in self.bubbles.iter_mut().filter(|b| b.amp > 1e-5) {
            b.phase = (b.phase + TAU * b.freq / ctx.sr) % TAU;
            b.freq = (b.freq * rise).min(2_400.0);
            b.amp *= fall;
            let v = b.phase.sin() * b.amp;
            let (gl, gr) = pan_gains(b.pan);
            l += v * gl;
            r += v * gr;
        }
        (l, r)
    }
}
