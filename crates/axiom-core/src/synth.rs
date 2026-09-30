//! The sound of the attractor (DESIGN.md §1 "Sound", §4 ids).
//!
//! Six probe trajectories integrate the *same world field* the particles fly
//! through, at audio rate. Probe k advances `h_k = 2π f_k / (ω · sr)` world
//! units per sample, so the law's characteristic angular frequency ω lands on
//! the just-intonation harmonic `f_k = root · n_k`. What you hear is therefore
//! the dynamics themselves: a fixed point is silence, a Hopf bifurcation a tone
//! that swells out of the noise floor, a cycle a pitched timbre, a torus
//! beating, chaos breathing noise.

use crate::anchors::{rk4, V3};
use crate::law::Law;
use crate::reverb::Fdn;
use crate::rng::Rng;
use std::f64::consts::TAU;

pub const MAX_FRAMES: usize = 256;
const PROBES: usize = 6;
/// Harmonics of the root the probes may be tuned to (chosen per seed).
const HARMONICS: [f32; 8] = [2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0];
/// Partials of the quiet drone, with their level.
const DRONE: [(f32, f32); 5] = [(1.0, 0.5), (2.0, 0.6), (3.0, 0.4), (4.0, 0.3), (6.0, 0.15)];

/// Probe state noise floor (world units per sample). Far below hearing, but it
/// seeds a Hopf bifurcation and keeps every filter out of denormal range.
const NOISE_FLOOR: f32 = 2.0e-6;
/// Extra per-sample state kick at full stir.
const STIR_KICK: f32 = 6.0e-4;
/// Probe level above which the slow follower turns the gain down.
const LEVEL_REF: f32 = 0.22;
const CONTROL_EVERY: usize = 16;

#[derive(Clone, Copy)]
struct Ramp {
    cur: f32,
    target: f32,
}

impl Ramp {
    fn new(v: f32) -> Ramp {
        Ramp { cur: v, target: v }
    }
    fn tick(&mut self, k: f32) -> f32 {
        self.cur += (self.target - self.cur) * k;
        if (self.target - self.cur).abs() < 1e-7 {
            self.cur = self.target;
        }
        self.cur
    }
}

struct Probe {
    x: V3,
    /// Harmonic number of the root this probe is tuned to.
    mul: f32,
    /// Static stereo offset; the y coordinate moves the pan around it.
    pan_bias: f32,
    pan: f32,
    amp: f32,
    dc_x: f32,
    dc_y: f32,
    lp: f32,
    ms: f32,
}

/// State-variable band-pass for the wind and the whoosh.
#[derive(Default, Clone, Copy)]
struct Band {
    lo: f32,
    bp: f32,
}

impl Band {
    fn process(&mut self, x: f32, f: f32, q: f32) -> f32 {
        let hi = x - self.lo - q * self.bp;
        self.bp += f * hi;
        self.lo += f * self.bp;
        self.bp
    }
}

/// Which voice the probes feed. Only the default exists so far; "Ink" (a
/// Karplus–Strong pluck at every z = 0 crossing of a probe) and the others
/// will add variants here and a branch in `Synth::voice`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Preset {
    Default,
}

impl Preset {
    fn from_id(id: u32) -> Preset {
        // Unknown ids fall back to the default voice.
        let _ = id;
        Preset::Default
    }
}

pub struct Synth {
    sr: f32,
    rng: Rng,
    law: Law,
    omega: f64,
    omega_target: f64,
    root_hz: f32,
    master: Ramp,
    stir: Ramp,
    dive: Ramp,
    dky: f32,
    lam1: f32,
    preset: Preset,
    probes: [Probe; PROBES],
    // one-pole coefficients refreshed at control rate
    lp_a: f32,
    rms_k: f32,
    wet: f32,
    // drone
    drone_phase: [f64; DRONE.len()],
    lfo_phase: f64,
    // wind / whoosh
    wind_lp: [f32; 2],
    wind_band: [Band; 2],
    wind_f: f32,
    whoosh: f32,
    whoosh_band: [Band; 2],
    fdn: Fdn,
    limiter: f32,
    out: Vec<f32>,
    bus_ms: f32,
    control_count: usize,
}

impl Synth {
    pub fn new(sample_rate: f32, seed: u32) -> Synth {
        let sr = sample_rate.clamp(8_000.0, 192_000.0);
        let mut rng = Rng::new(seed, 3);
        // Six distinct harmonics, in ascending order, chosen per seed.
        let mut pool = HARMONICS;
        for i in (1..pool.len()).rev() {
            pool.swap(i, rng.below(i + 1));
        }
        let mut chosen: Vec<f32> = pool[..PROBES].to_vec();
        chosen.sort_by(|a, b| a.total_cmp(b));
        let probes = std::array::from_fn(|k| {
            let x = rng.in_ball(0.4);
            Probe {
                x,
                mul: chosen[k],
                pan_bias: (k as f32 / (PROBES - 1) as f32 - 0.5) * 0.9 + rng.signed() as f32 * 0.1,
                pan: 0.0,
                amp: 0.8 / (1.0 + 0.22 * chosen[k]),
                dc_x: 0.0,
                dc_y: 0.0,
                lp: 0.0,
                ms: 0.0,
            }
        });
        let mut s = Synth {
            sr,
            rng,
            law: Law::from_block(&[]),
            omega: 1.5,
            omega_target: 1.5,
            root_hz: 55.0,
            master: Ramp::new(0.8),
            stir: Ramp::new(0.0),
            dive: Ramp::new(0.0),
            dky: 0.0,
            lam1: 0.0,
            preset: Preset::Default,
            probes,
            lp_a: 0.1,
            rms_k: 1.0 - (-1.0 / (0.4 * sr)).exp(),
            wet: 0.25,
            drone_phase: [0.0; DRONE.len()],
            lfo_phase: 0.0,
            wind_lp: [0.0; 2],
            wind_band: [Band::default(); 2],
            wind_f: 0.1,
            whoosh: 0.0,
            whoosh_band: [Band::default(); 2],
            fdn: Fdn::new(sr, 3.6, 0.32),
            limiter: 0.0,
            out: vec![0.0; 2 * MAX_FRAMES],
            bus_ms: 0.0,
            control_count: 0,
        };
        s.control();
        s.lp_a = s.cutoff_coeff();
        s
    }

    /// Install a 68-float `LawParams` block.
    pub fn set_law(&mut self, block: &[f32]) {
        self.law = Law::from_block(block);
        self.omega_target = self.law.omega().clamp(0.3, 6.0);
    }

    /// `synth_set` ids: 0 master · 1 stir · 2 dive · 3 shake · 4 preset ·
    /// 5 root_hz · 6 λ1 · 7 D.
    pub fn set(&mut self, id: u32, value: f32) {
        if !value.is_finite() {
            return;
        }
        match id {
            0 => self.master.target = value.clamp(0.0, 1.0),
            1 => self.stir.target = value.clamp(0.0, 1.0),
            2 => self.dive.target = value.clamp(0.0, 1.0),
            3 if value >= 0.5 => self.shake(),
            4 => self.preset = Preset::from_id(value as u32),
            5 => self.root_hz = value.clamp(20.0, 440.0),
            6 => self.lam1 = value,
            7 => self.dky = value.clamp(0.0, 3.0),
            _ => {}
        }
    }

    /// Scatter the probes; they fall back onto the attractor audibly.
    fn shake(&mut self) {
        for p in self.probes.iter_mut() {
            p.x = self.rng.in_ball(1.1);
        }
        self.whoosh = 1.0;
    }

    pub fn preset(&self) -> Preset {
        self.preset
    }

    /// RMS of the probe bus (before drone, wind and reverb), slowly averaged.
    pub fn bus_rms(&self) -> f32 {
        self.bus_ms.sqrt()
    }

    fn noise(&mut self) -> f32 {
        (self.rng.next_u32() as i32) as f32 * (1.0 / 2_147_483_648.0)
    }

    fn cutoff_coeff(&self) -> f32 {
        // Chaos is brighter than a cycle; diving opens the filter a little.
        let chaos = (self.lam1 * 5.0).clamp(0.0, 1.0);
        let cut =
            600.0 * (self.dky * 1.15).exp2() * (1.0 + 0.7 * self.dive.cur) * (1.0 + 0.5 * chaos);
        let cut = cut.min(7_000.0);
        1.0 - (-TAU as f32 * cut / self.sr).exp()
    }

    /// Slow updates: smoothing, filter coefficients.
    fn control(&mut self) {
        let dt = CONTROL_EVERY as f32 / self.sr;
        let k = |t: f32| 1.0 - (-dt / t).exp();
        self.master.tick(k(0.03));
        self.stir.tick(k(0.08));
        self.dive.tick(k(0.25));
        self.omega += (self.omega_target - self.omega) * k(0.3) as f64;
        self.lp_a = self.cutoff_coeff();
        let chaos = (self.lam1 * 5.0).clamp(0.0, 1.0);
        self.wet += (0.22 + 0.5 * self.dive.cur + 0.1 * chaos - self.wet) * k(0.3);
        self.lfo_phase = (self.lfo_phase + TAU * dt as f64 * 0.11) % TAU;
        let sweep = 0.5 + 0.5 * self.lfo_phase.sin() as f32;
        let target_f = 380.0 + 900.0 * sweep + 500.0 * self.dive.cur;
        let f = (TAU as f32 * target_f / self.sr).min(1.0);
        self.wind_f += (f - self.wind_f) * k(0.5);
        self.whoosh *= (-dt / 0.55).exp();
        if self.whoosh < 1e-4 {
            self.whoosh = 0.0;
        }
    }

    /// Turn a probe's coordinates into a stereo sample (the default voice).
    fn voice(&mut self, k: usize, stir: f32) -> (f32, f32) {
        let (kick, wob) = (stir * STIR_KICK, NOISE_FLOOR);
        let n = [self.noise(), self.noise(), self.noise()];
        let p = &mut self.probes[k];
        for (x, n) in p.x.iter_mut().zip(n) {
            *x += ((kick + wob) * n) as f64;
        }
        let s = p.x[0] as f32;
        let y = s - p.dc_x + 0.9975 * p.dc_y;
        p.dc_x = s;
        p.dc_y = y;
        p.lp += self.lp_a * (y - p.lp);
        p.ms += self.rms_k * (p.lp * p.lp - p.ms);
        let rms = p.ms.sqrt();
        let gain = if rms > LEVEL_REF {
            LEVEL_REF / rms
        } else {
            1.0
        };
        let v = p.lp * gain * p.amp;
        let target = (p.pan_bias + 1.1 * p.x[1] as f32).clamp(-1.0, 1.0);
        p.pan += 0.002 * (target - p.pan);
        (
            v * ((1.0 - p.pan) * 0.5).sqrt(),
            v * ((1.0 + p.pan) * 0.5).sqrt(),
        )
    }

    fn tick(&mut self) -> (f32, f32) {
        let stir = self.stir.cur;
        let omega = self.omega;
        let sr = self.sr as f64;
        let (mut bus_l, mut bus_r) = (0.0, 0.0);
        for k in 0..PROBES {
            let f = (self.root_hz * self.probes[k].mul) as f64;
            let h = (TAU * f / (omega * sr)).clamp(1e-4, 0.12);
            let mut x = rk4(&self.law, self.probes[k].x, h);
            if !x.iter().all(|v| v.is_finite() && v.abs() < 4.0) {
                // A trajectory that escaped the basin: start it over.
                x = self.rng.in_ball(0.3);
            }
            self.probes[k].x = x;
            let (l, r) = match self.preset {
                Preset::Default => self.voice(k, stir),
            };
            bus_l += l;
            bus_r += r;
        }
        self.bus_ms += self.rms_k * (0.5 * (bus_l * bus_l + bus_r * bus_r) - self.bus_ms);

        // drone
        let mut drone = 0.0f32;
        for (i, (mul, level)) in DRONE.iter().enumerate() {
            let detune = 1.0 + 0.0007 * (i as f64 - 2.0);
            let f = (self.root_hz * mul) as f64 * detune;
            self.drone_phase[i] = (self.drone_phase[i] + TAU * f / sr) % TAU;
            let lfo = 0.6 + 0.4 * (self.lfo_phase * (0.5 + 0.37 * i as f64) + i as f64).sin();
            drone += level * lfo as f32 * self.drone_phase[i].sin() as f32;
        }
        drone *= 0.045;

        // wind (stir, dive) and whoosh (shake): band-passed noise
        let wind_level = 0.4 * stir * stir.sqrt() + 0.15 * self.dive.cur;
        let mut wind = [0.0f32; 2];
        for (c, w) in wind.iter_mut().enumerate() {
            let n = self.noise();
            self.wind_lp[c] += 0.12 * (n - self.wind_lp[c]);
            let band = self.wind_band[c].process(self.wind_lp[c] * 2.5, self.wind_f, 0.9);
            let sweep = (self.wind_f * (0.35 + 2.2 * self.whoosh)).min(1.0);
            let whoosh_n = self.noise();
            let whoosh = self.whoosh_band[c].process(whoosh_n, sweep, 0.6);
            *w = band * wind_level + whoosh * 0.6 * self.whoosh * self.whoosh;
        }

        let dry_l = bus_l + drone + wind[0];
        let dry_r = bus_r + drone + wind[1];
        let (wet_l, wet_r) = self.fdn.process(
            0.35 * (bus_l + wind[0]) + 0.6 * drone,
            0.35 * (bus_r + wind[1]) + 0.6 * drone,
        );
        let master = self.master.cur;
        let (mut l, mut r) = (
            master * (dry_l + self.wet * wet_l),
            master * (dry_r + self.wet * wet_r),
        );

        // slow-release limiter, then a soft clip that can never exceed 0.9
        let peak = l.abs().max(r.abs());
        let a = if peak > self.limiter {
            1.0 - (-1.0 / (0.0006 * self.sr)).exp()
        } else {
            1.0 - (-1.0 / (0.25 * self.sr)).exp()
        };
        self.limiter += a * (peak - self.limiter);
        let g = if self.limiter > 0.7 {
            0.7 / self.limiter
        } else {
            1.0
        };
        l = 0.9 * (l * g / 0.9).tanh();
        r = 0.9 * (r * g / 0.9).tanh();
        (l, r)
    }

    /// Render `frames` (≤ 256) interleaved stereo frames into the internal
    /// buffer. Allocation-free.
    pub fn render(&mut self, frames: usize) -> &[f32] {
        let n = frames.min(MAX_FRAMES);
        for i in 0..n {
            if self.control_count == 0 {
                self.control();
            }
            self.control_count = (self.control_count + 1) % CONTROL_EVERY;
            let (l, r) = self.tick();
            self.out[2 * i] = l;
            self.out[2 * i + 1] = r;
        }
        &self.out[..2 * n]
    }

    /// Pointer to the interleaved output buffer (for the C ABI).
    pub fn out_ptr(&self) -> *const f32 {
        self.out.as_ptr()
    }
}
