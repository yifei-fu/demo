//! Preset 0: each probe's x coordinate, DC-blocked, low-passed (cutoff follows
//! D and dive), normalised by a slow RMS follower so loud cycles and chaos are
//! never overwhelming — but a fixed point is still silence and a Hopf still
//! swells.
//!
//! A phone speaker gives nothing below ~200 Hz, and chaos wanders slowly. So
//! each probe is also ring-modulated by a carrier on a harmonic of the root:
//! the probe's own motion, lifted into the upper register (partials at
//! multiples of the probe's tone for a cycle, a shimmering band for chaos),
//! silent whenever the probe is.

use super::dsp::pan_gains;
use super::{Ctx, ProbeView, LEVEL_REF, PROBES};
use std::f32::consts::TAU;

/// Weight of the probe itself and of its ring-modulated copy. The copy is the
/// heavier one: on a phone the copy *is* the sound, and on headphones the body
/// still carries the low half of the spectrum.
const BODY: f32 = 0.8;
const PRESENCE: f32 = 1.1;
/// Carrier: the fourth harmonic of the probe's tone, folded down by octaves
/// below this many Hz.
const CARRIER_MAX: f32 = 1_600.0;

#[derive(Default)]
pub struct Classic {
    lp: [f32; PROBES],
    ms: [f32; PROBES],
    carrier: [f32; PROBES],
}

impl Classic {
    pub fn tick(&mut self, probes: &[ProbeView; PROBES], ctx: &Ctx) -> (f32, f32) {
        let (mut l, mut r) = (0.0, 0.0);
        for (k, p) in probes.iter().enumerate() {
            self.lp[k] += ctx.lp_a * (p.dc - self.lp[k]);
            self.ms[k] += ctx.rms_k * (self.lp[k] * self.lp[k] - self.ms[k]);
            let rms = self.ms[k].sqrt();
            let gain = if rms > LEVEL_REF {
                LEVEL_REF / rms
            } else {
                1.0
            };
            let body = self.lp[k] * gain * p.swell;
            let mut hz = 4.0 * ctx.root_hz * p.mul;
            while hz > CARRIER_MAX {
                hz *= 0.5;
            }
            self.carrier[k] = (self.carrier[k] + TAU * hz / ctx.sr) % TAU;
            let v = (BODY * body + PRESENCE * body * self.carrier[k].sin()) * p.amp;
            let (gl, gr) = pan_gains(p.pan);
            l += v * gl;
            r += v * gr;
        }
        (l, r)
    }
}
