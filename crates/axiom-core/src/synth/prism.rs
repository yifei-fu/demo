//! Preset 2 · Prism — crystalline two-operator FM. Each probe drives a bell
//! pair (a modulator and two slightly detuned carriers, a subtle chorus) an
//! octave above its tone; the probe's x sets the FM index, y the pan, and its
//! natural level the loudness, so a fixed point is silent and a Hopf swells.

use super::dsp::pan_gains;
use super::{Ctx, ProbeView, LEVEL_REF, PROBES};
use std::f32::consts::TAU;

/// Modulator : carrier frequency ratios, harmonic so the glass stays in tune.
const RATIOS: [f32; PROBES] = [3.0, 2.0, 3.0, 2.0, 3.0, 2.0];
/// Half of the chorus spread: ±3 cents.
const DETUNE: f32 = 0.0017;
const GAIN: f32 = 0.2;

#[derive(Default)]
pub struct Prism {
    carrier: [[f32; 2]; PROBES],
    modulator: [f32; PROBES],
    x_slow: [f32; PROBES],
}

impl Prism {
    pub fn tick(&mut self, probes: &[ProbeView; PROBES], ctx: &Ctx) -> (f32, f32) {
        let (mut l, mut r) = (0.0, 0.0);
        for (k, p) in probes.iter().enumerate() {
            let fc = (ctx.root_hz * p.mul * 2.0).min(4_000.0);
            let fm = fc * RATIOS[k];
            self.x_slow[k] += 0.06 * (p.x[0] as f32 - self.x_slow[k]);
            let index = 0.4 + 2.2 * (0.5 + 0.5 * self.x_slow[k].clamp(-1.0, 1.0));
            self.modulator[k] = (self.modulator[k] + TAU * fm / ctx.sr) % TAU;
            let m = index * self.modulator[k].sin();
            let mut bell = 0.0;
            for (j, sign) in [1.0f32, -1.0].into_iter().enumerate() {
                self.carrier[k][j] =
                    (self.carrier[k][j] + TAU * fc * (1.0 + sign * DETUNE) / ctx.sr) % TAU;
                bell += (self.carrier[k][j] + m).sin();
            }
            let a = (p.level / LEVEL_REF).min(1.0);
            let v = 0.5 * bell * a * GAIN * p.amp / 0.45;
            let (gl, gr) = pan_gains(p.pan);
            l += v * gl;
            r += v * gr;
        }
        (l, r)
    }
}
