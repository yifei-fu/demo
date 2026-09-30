//! Preset 0: each probe's x coordinate, DC-blocked, low-passed (cutoff follows
//! D and dive), normalised by a slow RMS follower so loud cycles and chaos are
//! never overwhelming — but a fixed point is still silence and a Hopf still
//! swells.

use super::dsp::pan_gains;
use super::{Ctx, ProbeView, LEVEL_REF, PROBES};

#[derive(Default)]
pub struct Classic {
    lp: [f32; PROBES],
    ms: [f32; PROBES],
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
            let v = self.lp[k] * gain * p.swell * p.amp;
            let (gl, gr) = pan_gains(p.pan);
            l += v * gl;
            r += v * gr;
        }
        (l, r)
    }
}
