//! The sound of the attractor (DESIGN.md §1 "Sound", §4 ids).
//!
//! Six probe trajectories integrate the *same world field* the particles fly
//! through, at audio rate. Probe k advances `h_k = 2π f_k / (ω · sr)` world
//! units per sample, so the law's characteristic angular frequency ω lands on
//! the just-intonation harmonic `f_k = root · n_k`. What you hear is therefore
//! the dynamics themselves: a fixed point is silence, a Hopf bifurcation a tone
//! that swells out of the noise floor, a cycle a pitched timbre, a torus
//! beating, chaos breathing noise.
//!
//! Presets (`synth_set` id 4) are different *voices* on the same probes, law,
//! drone, wind and reverb; switching cross-fades them. 0 · classic tones,
//! 1 · Ink (plucks at every z = 0 crossing), 2 · Prism (FM glass),
//! 3 · Abyss (deep, swept, bubbling).

mod abyss;
mod classic;
mod drone;
mod dsp;
mod ink;
mod prism;
mod wind;

use crate::anchors::{norm, rk4, V3};
use crate::law::Law;
use crate::reverb::Fdn;
use crate::rng::Rng;
use dsp::{lowpass_coeff, smoothing, white, Ramp};
use std::f64::consts::TAU;

pub const MAX_FRAMES: usize = 256;
pub(crate) const PROBES: usize = 6;
/// Harmonics of the root the probes may be tuned to (chosen per seed).
const HARMONICS: [f32; 8] = [2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0];

/// Extra per-sample state kick at full stir (at audio-rate probes).
const STIR_KICK: f32 = 6.0e-4;
/// Probe level above which the slow follower turns the gain down.
pub(crate) const LEVEL_REF: f32 = 0.22;
/// Onset swell: a probe's level may rise no faster than a ceiling that climbs
/// `SWELL_RATE` dB per second toward `SWELL_HEADROOM` times the level and
/// follows it back down after `SWELL_RELEASE`. A Hopf bifurcation grows in
/// milliseconds at audio-rate probes; this turns that pop into a swell.
const SWELL_RATE_DB: f32 = 15.0;
const SWELL_RELEASE: f32 = 0.25;
const SWELL_HEADROOM: f32 = 2.0;
/// Level (in x units) the ceiling never falls below.
const SWELL_FLOOR: f32 = 0.025;
/// The peak detector's hold time.
const SWELL_HOLD: f32 = 0.03;
/// Running-mean time (world units) of the plane Ink cuts its rhythm at.
const SECTION_MEAN: f32 = 10.0;
/// World speed below which a probe counts as resting (for `rest_boost`).
const REST_SPEED: f32 = 0.06;
/// The limiter starts pulling the gain down when the output peaks above this
/// (the soft clip behind it still tops out at 0.9).
const LIMIT: f32 = 1.0;
const CONTROL_EVERY: usize = 16;
/// How fast a preset fades in and out.
const CROSSFADE: f32 = 0.12;

/// Which voice the probes feed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Preset {
    Classic = 0,
    Ink = 1,
    Prism = 2,
    Abyss = 3,
}

const PRESETS: [Preset; 4] = [Preset::Classic, Preset::Ink, Preset::Prism, Preset::Abyss];

/// The room and mix each preset asks for.
struct Look {
    rt60: f32,
    damp: f32,
    wet: f32,
    /// Level of the drone partials [½, 1, 1.5, 2, 3, 4, 6] × root.
    drone: [f32; 7],
    wind: f32,
}

impl Preset {
    fn from_id(id: u32) -> Preset {
        PRESETS.get(id as usize).copied().unwrap_or(Preset::Classic)
    }

    fn look(self) -> Look {
        match self {
            Preset::Classic => Look {
                rt60: 3.6,
                damp: 0.32,
                wet: 0.22,
                drone: [0.0, 0.5, 0.0, 0.6, 0.4, 0.3, 0.15],
                wind: 1.0,
            },
            // Dry and intimate: a small room.
            Preset::Ink => Look {
                rt60: 0.45,
                damp: 0.45,
                wet: 0.11,
                drone: [0.0, 0.2, 0.0, 0.25, 0.12, 0.0, 0.0],
                wind: 0.6,
            },
            // Long and bright.
            Preset::Prism => Look {
                rt60: 5.8,
                damp: 0.05,
                wet: 0.42,
                drone: [0.0, 0.25, 0.0, 0.3, 0.4, 0.5, 0.45],
                wind: 0.7,
            },
            // Very long and dark, with a sub drone.
            Preset::Abyss => Look {
                rt60: 9.5,
                damp: 0.72,
                wet: 0.55,
                drone: [0.7, 0.5, 0.3, 0.2, 0.0, 0.0, 0.0],
                wind: 0.3,
            },
        }
    }

    /// Diffusion of the probe noise, in world units² per world unit: what
    /// seeds a Hopf bifurcation. The kick per sample is √(D·h), so a slow
    /// probe is shaken exactly as hard per world unit as a fast one. Audio-rate
    /// probes need only enough to stay out of denormal range; Ink's slow
    /// probes are seeded a little harder so a cycle can start within a second.
    fn diffusion(self) -> f32 {
        match self {
            Preset::Ink => 4.0e-7,
            _ => 4.0e-10,
        }
    }

    /// How much faster (×1 + this) a probe near rest runs, in world time.
    /// Ink's probes crawl at a few Hz, and a Hopf grows over tens of world
    /// units: without this a cycle would need many seconds to emerge from the
    /// noise. Nothing is heard while a probe rests, so its clock may race.
    fn rest_boost(self) -> f32 {
        match self {
            Preset::Ink => 30.0,
            _ => 0.0,
        }
    }

    /// The rate (Hz) a probe with harmonic `mul` is driven at. Ink runs its
    /// probes at rhythm speed: each z = 0 crossing is then a note, not a cycle
    /// of the waveform.
    fn probe_hz(self, root_hz: f32, mul: f32) -> f32 {
        match self {
            Preset::Classic | Preset::Prism => root_hz * mul,
            Preset::Abyss => 0.5 * root_hz * mul,
            Preset::Ink => 0.25 * mul,
        }
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
    /// Glided drive rate in Hz (see `Preset::probe_hz`).
    hz: f32,
    dc_x: f32,
    dc_y: f32,
    ms: f32,
    speed: f32,
    /// Peak detector on `dc` and the onset-swell ceiling above it.
    peak: f32,
    ceil: f32,
    /// Running mean of z in world time (the Poincaré section Ink cuts at).
    zm: f32,
}

/// What a voice sees of a probe on this sample.
#[derive(Clone, Copy, Default)]
pub(crate) struct ProbeView {
    pub x: V3,
    /// The x coordinate with its DC removed.
    pub dc: f32,
    /// Slow RMS of `dc`.
    pub level: f32,
    /// World units per world-time unit: what a particle there would do.
    pub speed: f32,
    pub mul: f32,
    pub pan: f32,
    pub amp: f32,
    /// Onset gain in (0, 1]: below 1 while the probe's level is still rising.
    pub swell: f32,
    /// z minus its running mean: the height above the probe's own section.
    pub dz: f32,
    /// The ceiling that gain enforces on the probe's peak (x units).
    pub ceil: f32,
}

/// Slowly varying settings shared by all voices for the current block.
pub(crate) struct Ctx {
    pub sr: f32,
    pub root_hz: f32,
    pub stir: f32,
    /// Low-pass coefficient of the classic voice (follows D, dive, chaos).
    pub lp_a: f32,
    pub rms_k: f32,
    /// Per-sample growth factor of the swell ceiling and its release
    /// coefficient (see `SWELL_RATE_DB`).
    pub swell_up: f32,
    pub swell_down: f32,
    /// The peak detector's per-sample decay.
    swell_hold: f32,
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
    /// Rest boost and noise diffusion, gliding to the preset's values.
    boost: f32,
    diffusion: f32,
    preset: Preset,
    levels: [Ramp; 4],
    probes: [Probe; PROBES],
    ctx: Ctx,
    classic: classic::Classic,
    ink: ink::Ink,
    prism: prism::Prism,
    abyss: abyss::Abyss,
    drone: drone::Drone,
    wind: wind::Wind,
    wet: f32,
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
        let root_hz = 55.0;
        let probes = std::array::from_fn(|k| {
            let x = rng.in_ball(0.4);
            Probe {
                x,
                mul: chosen[k],
                pan_bias: (k as f32 / (PROBES - 1) as f32 - 0.5) * 0.9 + rng.signed() as f32 * 0.1,
                pan: 0.0,
                amp: 0.8 / (1.0 + 0.22 * chosen[k]),
                hz: Preset::Classic.probe_hz(root_hz, chosen[k]),
                dc_x: 0.0,
                dc_y: 0.0,
                ms: 0.0,
                speed: 0.0,
                peak: 0.0,
                ceil: SWELL_FLOOR,
                zm: x[2] as f32,
            }
        });
        let look = Preset::Classic.look();
        let mut s = Synth {
            sr,
            law: Law::from_block(&[]),
            omega: 1.5,
            omega_target: 1.5,
            root_hz,
            master: Ramp::new(0.8),
            stir: Ramp::new(0.0),
            dive: Ramp::new(0.0),
            dky: 0.0,
            lam1: 0.0,
            boost: 0.0,
            diffusion: Preset::Classic.diffusion(),
            preset: Preset::Classic,
            levels: [
                Ramp::new(1.0),
                Ramp::new(0.0),
                Ramp::new(0.0),
                Ramp::new(0.0),
            ],
            probes,
            ctx: Ctx {
                sr,
                root_hz,
                stir: 0.0,
                lp_a: 0.1,
                rms_k: smoothing(1.0 / sr, 0.4),
                swell_up: (SWELL_RATE_DB * std::f32::consts::LN_10 / 20.0 / sr).exp(),
                swell_down: smoothing(1.0 / sr, SWELL_RELEASE),
                swell_hold: 1.0 - smoothing(1.0 / sr, SWELL_HOLD),
            },
            classic: classic::Classic::default(),
            ink: ink::Ink::new(sr),
            prism: prism::Prism::default(),
            abyss: abyss::Abyss::new(&mut rng),
            drone: drone::Drone::new(look.drone),
            wind: wind::Wind::default(),
            wet: look.wet,
            fdn: Fdn::new(sr, look.rt60, look.damp),
            limiter: 0.0,
            out: vec![0.0; 2 * MAX_FRAMES],
            bus_ms: 0.0,
            control_count: 0,
            rng,
        };
        s.control();
        s.ctx.lp_a = s.cutoff_coeff();
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
            4 => self.select(Preset::from_id(value.max(0.0) as u32)),
            5 => self.root_hz = value.clamp(20.0, 440.0),
            6 => self.lam1 = value,
            7 => self.dky = value.clamp(0.0, 3.0),
            _ => {}
        }
    }

    fn select(&mut self, preset: Preset) {
        self.preset = preset;
        for (p, level) in PRESETS.iter().zip(self.levels.iter_mut()) {
            level.target = f32::from(*p == preset);
        }
        let look = preset.look();
        self.fdn.set_decay(look.rt60, look.damp);
        self.drone.set_levels(look.drone);
    }

    /// Scatter the probes; they fall back onto the attractor audibly.
    fn shake(&mut self) {
        for p in self.probes.iter_mut() {
            p.x = self.rng.in_ball(1.1);
            // Not an onset: let the scattered probes be heard at once.
            p.ceil = 1.0;
        }
        self.wind.whoosh();
    }

    pub fn preset(&self) -> Preset {
        self.preset
    }

    /// RMS of the probe bus (before drone, wind and reverb), slowly averaged.
    pub fn bus_rms(&self) -> f32 {
        self.bus_ms.sqrt()
    }

    /// Plucks Ink has struck so far (a test hook: the Poincaré rhythm).
    pub fn pluck_count(&self) -> u64 {
        self.ink.plucks()
    }

    fn chaos(&self) -> f32 {
        (self.lam1 * 5.0).clamp(0.0, 1.0)
    }

    fn cutoff_coeff(&self) -> f32 {
        // Chaos is brighter than a cycle; diving opens the filter a little.
        let cut = 600.0
            * (self.dky * 1.15).exp2()
            * (1.0 + 0.7 * self.dive.cur)
            * (1.0 + 0.5 * self.chaos());
        lowpass_coeff(cut.min(7_000.0), self.sr)
    }

    /// Slow updates: smoothing, filter coefficients.
    fn control(&mut self) {
        let dt = CONTROL_EVERY as f32 / self.sr;
        let k = |t: f32| smoothing(dt, t);
        self.master.tick(k(0.03));
        self.stir.tick(k(0.08));
        self.dive.tick(k(0.25));
        for level in self.levels.iter_mut() {
            level.tick(k(CROSSFADE));
        }
        self.omega += (self.omega_target - self.omega) * k(0.3) as f64;
        self.ctx.lp_a = self.cutoff_coeff();
        self.ctx.root_hz = self.root_hz;
        self.ctx.stir = self.stir.cur;
        let look = self.preset.look();
        self.wet += (look.wet + 0.5 * self.dive.cur + 0.1 * self.chaos() - self.wet) * k(0.4);
        self.fdn.glide(k(0.6));
        self.drone.control(dt, self.sr);
        self.wind.control(dt, self.sr, self.dive.cur);
        self.boost += (self.preset.rest_boost() - self.boost) * k(0.25);
        self.diffusion += (self.preset.diffusion() - self.diffusion) * k(0.25);
        for p in self.probes.iter_mut() {
            p.hz += (self.preset.probe_hz(self.root_hz, p.mul) - p.hz) * k(0.25);
        }
    }

    /// Advance every probe one sample and describe it to the voices.
    fn probe_views(&mut self) -> [ProbeView; PROBES] {
        let stir = self.stir.cur;
        let omega = self.omega;
        let sr = self.sr as f64;
        let mut views = [ProbeView::default(); PROBES];
        for (p, view) in self.probes.iter_mut().zip(views.iter_mut()) {
            // Near rest (speed ≪ REST_SPEED) the clock runs 1 + boost times faster.
            let rest = 1.0 + self.boost * (-(p.speed * (1.0 / REST_SPEED)).powi(2)).exp();
            let h = (TAU * p.hz as f64 * rest as f64 / (omega * sr)).clamp(1e-6, 0.12);
            let mut x = rk4(&self.law, p.x, h);
            if !x.iter().all(|v| v.is_finite() && v.abs() < 4.0) {
                // A trajectory that escaped the basin: start it over.
                x = self.rng.in_ball(0.3);
            } else {
                let step = norm([x[0] - p.x[0], x[1] - p.x[1], x[2] - p.x[2]]) / h;
                p.speed += 0.002 * (step as f32 - p.speed);
            }
            // The state kick scales with the drive rate: it is per sample, and
            // a slow probe would otherwise be shaken far harder per world unit.
            let kick = stir * STIR_KICK * (p.hz / (55.0 * p.mul)).min(1.0).sqrt();
            let floor = (self.diffusion * h as f32).sqrt();
            for c in x.iter_mut() {
                *c += ((kick + floor) * white(&mut self.rng)) as f64;
            }
            p.x = x;
            p.zm += (x[2] as f32 - p.zm) * (h as f32 * (1.0 / SECTION_MEAN)).min(1.0);

            let s = x[0] as f32;
            let dc = s - p.dc_x + 0.9975 * p.dc_y;
            p.dc_x = s;
            p.dc_y = dc;
            p.ms += self.ctx.rms_k * (dc * dc - p.ms);
            p.peak = dc.abs().max(p.peak * self.ctx.swell_hold);
            let goal = SWELL_HEADROOM * p.peak + SWELL_FLOOR;
            p.ceil = if goal > p.ceil {
                goal.min(p.ceil * self.ctx.swell_up)
            } else {
                p.ceil + self.ctx.swell_down * (goal - p.ceil)
            };
            let swell = if p.peak > p.ceil { p.ceil / p.peak } else { 1.0 };
            let target = (p.pan_bias + 1.1 * x[1] as f32).clamp(-1.0, 1.0);
            p.pan += 0.002 * (target - p.pan);
            *view = ProbeView {
                x,
                dc,
                level: p.ms.sqrt(),
                speed: p.speed,
                mul: p.mul,
                pan: p.pan,
                amp: p.amp,
                swell,
                dz: x[2] as f32 - p.zm,
                ceil: p.ceil,
            };
        }
        views
    }

    fn tick(&mut self) -> (f32, f32) {
        let views = self.probe_views();
        let (mut bus_l, mut bus_r) = (0.0, 0.0);
        for (i, preset) in PRESETS.iter().enumerate() {
            let level = self.levels[i].cur;
            if level < 1e-4 {
                continue;
            }
            let (l, r) = match preset {
                Preset::Classic => self.classic.tick(&views, &self.ctx),
                Preset::Ink => self.ink.tick(&views, &self.ctx, &mut self.rng),
                Preset::Prism => self.prism.tick(&views, &self.ctx),
                Preset::Abyss => self.abyss.tick(&views, &self.ctx, &mut self.rng),
            };
            bus_l += level * l;
            bus_r += level * r;
        }
        self.bus_ms += self.ctx.rms_k * (0.5 * (bus_l * bus_l + bus_r * bus_r) - self.bus_ms);

        let drone = self.drone.tick(self.root_hz, self.sr);
        let wind_gain = PRESETS
            .iter()
            .zip(&self.levels)
            .map(|(p, l)| p.look().wind * l.cur)
            .sum::<f32>();
        let wind = self
            .wind
            .tick(self.stir.cur, self.dive.cur, wind_gain, &mut self.rng);

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
        let g = if self.limiter > LIMIT {
            LIMIT / self.limiter
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
