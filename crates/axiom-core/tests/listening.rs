//! What the listening analysis found, encoded, for the three shipped voices:
//! Flame (preset 0, root 55 Hz), Ink (1, 65.4 Hz) and Prism (2, 73.4 Hz).
//!
//! An offline render of the real synth along the app's own path (law refreshed
//! at 30 Hz from `write_params`, λ1 and D from the live spectrum tracker) was
//! measured, and six things were wrong. Each has a test here:
//!
//!   1. a Hopf onset was a pop, not a swell;
//!   2. Ink stayed silent through the Hopf region at navigation speed;
//!   3. Ink was bright and ten decibels quieter than Flame;
//!   4. phone speakers (nothing below ~200 Hz) got almost none of it;
//!   5. the shake was barely audible;
//!   6. the presets differed in loudness by several decibels.

use axiom_core::law::{write_params, PARAMS_LEN};
use axiom_core::spectrum::Spectrum;
use axiom_core::synth::Synth;
use std::f64::consts::PI;
use std::sync::OnceLock;

const SR: f32 = 48_000.0;
const QUANTUM: usize = 128;

const FLAME: u32 = 0;
const INK: u32 = 1;
const PRISM: u32 = 2;

/// (name, preset id, root Hz). Flame is the reference the others are matched to.
const VOICES: [(&str, u32, f32); 3] = [
    ("flame", FLAME, 55.0),
    ("ink", INK, 65.4),
    ("prism", PRISM, 73.4),
];

fn block(u: f64, v: f64, seed: u32) -> [f32; PARAMS_LEN] {
    let mut b = [0.0; PARAMS_LEN];
    write_params(u as f32, v as f32, seed, &mut b);
    b
}

fn synth_for(preset: u32, root: f32, seed: u32, sr: f32) -> Synth {
    let mut s = Synth::new(sr, seed);
    s.set(4, preset as f32);
    s.set(5, root);
    s
}

/// The same number of blocks the browser would render for `secs` seconds.
fn blocks(secs: f64, sr: f32) -> usize {
    (secs * f64::from(sr) / QUANTUM as f64) as usize
}

fn db(x: f64) -> f64 {
    20.0 * (x + 1e-12).log10()
}

/// RMS (dB) of consecutive `win`-second windows of interleaved stereo audio.
fn window_levels(audio: &[f32], win: f64, sr: f32) -> Vec<f64> {
    let n = (win * f64::from(sr)) as usize * 2;
    audio
        .chunks_exact(n)
        .map(|c| db((c.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / c.len() as f64).sqrt()))
        .collect()
}

// ------------------------------------------------------------ spectrum ----

fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        for i in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (i + k, i + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

/// Welch-averaged power spectrum (8192-point Hann frames, both channels).
fn power_spectrum(audio: &[f32]) -> Vec<f64> {
    const N: usize = 8192;
    let window: Vec<f64> = (0..N)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / N as f64).cos())
        .collect();
    let frames = audio.len() / 2;
    let mut acc = vec![0.0; N / 2 + 1];
    let mut count = 0.0;
    let mut start = 0;
    while start + N <= frames {
        for ch in 0..2 {
            let mut re: Vec<f64> = (0..N)
                .map(|i| f64::from(audio[2 * (start + i) + ch]) * window[i])
                .collect();
            let mut im = vec![0.0; N];
            fft(&mut re, &mut im);
            for k in 0..=N / 2 {
                acc[k] += re[k] * re[k] + im[k] * im[k];
            }
            count += 1.0;
        }
        start += N / 2;
    }
    acc.iter().map(|v| v / f64::max(count, 1.0)).collect()
}

/// (spectral centroid in Hz, share of the energy above 200 Hz).
fn centroid_and_high_share(audio: &[f32], sr: f32) -> (f64, f64) {
    let p = power_spectrum(audio);
    let df = f64::from(sr) / 8192.0;
    let (mut num, mut den, mut high) = (0.0, 0.0, 0.0);
    for (k, v) in p.iter().enumerate().skip(1) {
        let f = k as f64 * df;
        num += f * v;
        den += v;
        if f > 200.0 {
            high += v;
        }
    }
    (num / den, high / den)
}

// ----------------------------------------------------------- the journey ----

/// The listening analysis's scripted journey (24.5 s): centre, out to the
/// Hopf, on to the rim, a labyrinth (with a stir burst), the Lorenz region
/// (with a shake), back to the centre. Segments: (name, start s, end s).
const SEGMENTS: [(&str, f64, f64); 10] = [
    ("centre", 0.5, 2.0),
    ("out", 2.0, 6.5),
    ("hopf", 6.5, 8.5),
    ("to-rim", 8.5, 10.5),
    ("rim-arc", 10.5, 13.5),
    ("labyrinth", 13.5, 15.5),
    ("rim-lorenz", 15.5, 17.5),
    ("lorenz", 17.5, 19.0),
    ("return", 19.0, 23.0),
    ("tail", 23.0, 24.5),
];
/// The segments where something is playing (everything after the Hopf).
const ACTIVE: std::ops::Range<usize> = 2..9;
const STIR: (f64, f64) = (13.9, 15.0);
const SHAKE_AT: f64 = 19.3;
const JOURNEY_SECS: f64 = 24.5;

fn ease(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Where the bead is on the parameter disk at time `t`.
fn bead(t: f64) -> (f64, f64) {
    let seg = |a: f64, b: f64| ease((t - a) / (b - a));
    let lerp = |a: f64, b: f64, k: f64| a + (b - a) * k;
    let polar = |r: f64, th: f64| (r * th.cos(), r * th.sin());
    let deg = PI / 180.0;
    if t < 2.0 {
        (0.0, 0.0)
    } else if t < 6.5 {
        polar(lerp(0.0, 0.46, seg(2.0, 6.5)), PI)
    } else if t < 8.5 {
        (-0.46, 0.0)
    } else if t < 10.5 {
        polar(lerp(0.46, 0.9, seg(8.5, 10.5)), PI)
    } else if t < 13.5 {
        polar(
            lerp(0.9, 0.9051, seg(10.5, 13.5)),
            lerp(180.0 * deg, 315.0 * deg, seg(10.5, 13.5)),
        )
    } else if t < 15.5 {
        (0.64, -0.64)
    } else if t < 17.5 {
        polar(0.9051, lerp(315.0 * deg, 405.0 * deg, seg(15.5, 17.5)))
    } else if t < 19.0 {
        (0.64, 0.64)
    } else if t < 23.0 {
        polar(lerp(0.9051, 0.0, seg(19.0, 23.0)), 45.0 * deg)
    } else {
        (0.0, 0.0)
    }
}

/// What the app sends on one 30 Hz tick.
struct Tick {
    at: usize,
    law: [f32; PARAMS_LEN],
    l1: f32,
    dky: f32,
    stir: f32,
    shake: bool,
}

fn schedule(seed: u32, events: bool) -> Vec<Tick> {
    let mut spectrum = Spectrum::new(seed);
    let law0 = axiom_core::law::Law::from_block(&block(0.0, 0.0, seed));
    for _ in 0..120 {
        spectrum.step(&law0, 0.4);
    }
    let (mut stir_gain, mut shaken) = (0.0f64, false);
    let total = blocks(JOURNEY_SECS, SR) * QUANTUM;
    let mut ticks = Vec::new();
    for n in 0.. {
        let at = (n as f64 * 1600.0 / QUANTUM as f64).round() as usize * QUANTUM;
        if at >= total {
            break;
        }
        let t = at as f64 / f64::from(SR);
        let (u, v) = bead(t);
        let law = block(u, v, seed);
        let world = axiom_core::law::Law::from_block(&law);
        spectrum.step(&world, 0.4);
        spectrum.step(&world, 0.4);
        let r = spectrum.read();
        let mut stir = 0.0;
        let mut shake = false;
        if events {
            let active = (STIR.0..STIR.1).contains(&t);
            let tau: f64 = if active { 0.08 } else { 0.25 };
            stir_gain +=
                (f64::from(u8::from(active)) - stir_gain) * (1.0 - (-(1.0 / 30.0) / tau).exp());
            if stir_gain < 0.002 {
                stir_gain = 0.0;
            }
            stir = (stir_gain * 0.85 * (0.85 + 0.15 * (2.0 * PI * 1.3 * t).sin())).min(1.0);
            if !shaken && t >= SHAKE_AT {
                shake = true;
                shaken = true;
            }
        }
        ticks.push(Tick {
            at,
            law,
            l1: r[0],
            dky: r[3],
            stir: stir as f32,
            shake,
        });
    }
    ticks
}

fn render_journey(preset: u32, root: f32, seed: u32, ticks: &[Tick]) -> Vec<f32> {
    let mut s = synth_for(preset, root, seed, SR);
    let total = blocks(JOURNEY_SECS, SR) * QUANTUM;
    let mut audio = Vec::with_capacity(2 * total);
    let mut next = 0;
    let (mut sent_l1, mut sent_d, mut sent_stir) = (f32::NAN, f32::NAN, 0.0f32);
    for b in 0..total / QUANTUM {
        while next < ticks.len() && ticks[next].at <= b * QUANTUM {
            let t = &ticks[next];
            s.set_law(&t.law);
            if sent_l1.is_nan() || (t.l1 - sent_l1).abs() >= 0.004 {
                s.set(6, t.l1);
                sent_l1 = t.l1;
            }
            if sent_d.is_nan() || (t.dky - sent_d).abs() >= 0.004 {
                s.set(7, t.dky);
                sent_d = t.dky;
            }
            if (t.stir - sent_stir).abs() >= 0.004 || (t.stir == 0.0 && sent_stir != 0.0) {
                s.set(1, t.stir);
                sent_stir = t.stir;
            }
            if t.shake {
                s.set(3, 1.0);
            }
            next += 1;
        }
        audio.extend_from_slice(s.render(QUANTUM));
    }
    audio
}

/// One voice on the journey: without and with the stir and shake events.
struct Rendered {
    control: Vec<f32>,
    events: Vec<f32>,
}

/// Every voice rendered once (in parallel) and shared by the tests.
fn journeys() -> &'static Vec<Rendered> {
    static JOURNEYS: OnceLock<Vec<Rendered>> = OnceLock::new();
    JOURNEYS.get_or_init(|| {
        let seed = 1;
        let (calm, eventful) = (schedule(seed, false), schedule(seed, true));
        std::thread::scope(|scope| {
            let jobs: Vec<_> = VOICES
                .iter()
                .map(|&(_, preset, root)| {
                    let (calm, eventful) = (&calm, &eventful);
                    scope.spawn(move || Rendered {
                        control: render_journey(preset, root, seed, calm),
                        events: render_journey(preset, root, seed, eventful),
                    })
                })
                .collect();
            jobs.into_iter()
                .map(|j| j.join().expect("render"))
                .collect()
        })
    })
}

/// The interleaved samples of `[t0, t1)` seconds.
fn slice(audio: &[f32], t0: f64, t1: f64) -> &[f32] {
    let at = |t: f64| (t * f64::from(SR)).round() as usize * 2;
    &audio[at(t0)..at(t1)]
}

fn level(audio: &[f32]) -> f64 {
    db((audio.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / audio.len() as f64).sqrt())
}

/// Level of each active segment of a voice's calm journey.
fn active_levels(voice: usize) -> Vec<f64> {
    let control = &journeys()[voice].control;
    SEGMENTS[ACTIVE]
        .iter()
        .map(|&(_, t0, t1)| level(slice(control, t0, t1)))
        .collect()
}

fn energy_mean_db(levels: &[f64]) -> f64 {
    10.0 * (levels.iter().map(|l| 10f64.powf(l / 10.0)).sum::<f64>() / levels.len() as f64).log10()
}

#[test]
fn every_preset_has_energy_above_the_phone_speaker_cutoff() {
    // Phone speakers give nothing below ~200 Hz. Before: Flame on the Thomas
    // labyrinth put 93% of its energy under 200 Hz.
    for (vi, (name, _, _)) in VOICES.iter().enumerate() {
        for &(seg, t0, t1) in &SEGMENTS[ACTIVE] {
            let (_, high) = centroid_and_high_share(slice(&journeys()[vi].control, t0, t1), SR);
            assert!(
                high >= 0.35,
                "{name} in {seg}: only {:.0}% of the energy is above 200 Hz",
                100.0 * high
            );
        }
    }
}

#[test]
fn presets_are_level_matched_to_flame() {
    let reference = active_levels(0);
    let mean = energy_mean_db(&reference);
    for (vi, (name, _, _)) in VOICES.iter().enumerate().skip(1) {
        let levels = active_levels(vi);
        let m = energy_mean_db(&levels);
        assert!(
            (m - mean).abs() <= 1.5,
            "{name}: {m:.1} dB against Flame's {mean:.1} dB"
        );
        // Segment by segment the voices differ more: the labyrinth, whose
        // near-conservative Thomas flow wanders slowly, is where the
        // continuous voices are quietest (Flame −24 dB), while Ink's notes are
        // rate-compensated to stay present (−20 dB).
        for (i, (l, r)) in levels.iter().zip(&reference).enumerate() {
            assert!(
                (l - r).abs() <= 4.5,
                "{name} in {}: {l:.1} dB against {r:.1} dB",
                SEGMENTS[ACTIVE][i].0
            );
        }
    }
}

#[test]
fn ink_is_soft_and_as_loud_as_flame() {
    // Before: centroid 2.2–3.8 kHz in the chaotic segments and 10 dB down.
    for &(seg, t0, t1) in &SEGMENTS[3..9] {
        let (centroid, _) = centroid_and_high_share(slice(&journeys()[1].control, t0, t1), SR);
        assert!(
            (700.0..=1_600.0).contains(&centroid),
            "ink in {seg}: centroid {centroid:.0} Hz"
        );
    }
    let (ink, flame) = (
        energy_mean_db(&active_levels(1)),
        energy_mean_db(&active_levels(0)),
    );
    assert!(
        (ink - flame).abs() <= 2.0,
        "ink {ink:.1} dB, flame {flame:.1} dB"
    );
}

// ------------------------------------------------------------ the swell ----

/// The bead leaves the centre along `angle` at `speed` (disk radii per second)
/// after 4 s of rest; the law is refreshed at 30 Hz. Returns the output and
/// the radius at the end of each 100 ms window.
fn ramp(preset: u32, root: f32, seed: u32, angle: f64, speed: f64, secs: f64) -> Vec<f32> {
    let mut s = synth_for(preset, root, seed, SR);
    s.set(6, 0.1);
    s.set(7, 1.5);
    let mut audio = Vec::new();
    let lead = 4.0;
    let th = angle.to_radians();
    for b in 0..blocks(lead + secs, SR) {
        if b % 12 == 0 {
            let t = (b * QUANTUM) as f64 / f64::from(SR) - lead;
            let r = if t <= 0.0 { 0.0 } else { speed * t };
            s.set_law(&block(r * th.cos(), r * th.sin(), seed));
        }
        audio.extend_from_slice(s.render(QUANTUM));
    }
    audio
}

/// The largest rise (dB) between consecutive windows that are both audible.
fn worst_rise(levels: &[f64]) -> f64 {
    levels
        .windows(2)
        .filter(|w| w[0] > -60.0 && w[1] > -60.0)
        .map(|w| w[1] - w[0])
        .fold(f64::MIN, f64::max)
}

#[test]
fn a_hopf_onset_swells_instead_of_popping_on_the_journey() {
    // Before: +10 dB per 100 ms on Flame and Prism at r ≈ 0.35.
    for (vi, (name, _, _)) in VOICES.iter().enumerate() {
        if vi == 1 {
            continue; // Ink's notes are struck, not swelled: see below
        }
        // Windows 2–6 s are the crossing (r = 0.44 at 6 s); what follows is the
        // tone's own beating, not its onset.
        let levels = window_levels(slice(&journeys()[vi].control, 0.0, 8.0), 0.1, SR);
        let centre = levels[10..20].iter().cloned().fold(f64::MIN, f64::max);
        let worst = worst_rise(&levels[20..60]);
        eprintln!("JOURNEY {name}: worst {worst:.2}");
        assert!(
            worst <= 3.0,
            "{name}: level rose {worst:.1} dB in 100 ms on the way to the Hopf"
        );
        let loudest = levels.iter().cloned().fold(f64::MIN, f64::max);
        assert!(
            loudest > centre + 8.0,
            "{name}: the Hopf tone never emerged ({centre:.1} -> {loudest:.1} dB)"
        );
    }
}

#[test]
fn a_hopf_onset_swells_instead_of_popping_on_a_ramp() {
    // The bead leaves the centre at 0.15 r/s, the fastest of the app's easing,
    // on three seeds.
    let mut failures = Vec::new();
    for (name, preset, root) in [VOICES[0], VOICES[2]] {
        for seed in [1, 7, 42] {
            let audio = ramp(preset, root, seed, 180.0, 0.15, 4.0);
            let levels = window_levels(&audio, 0.1, SR);
            let centre = levels[10..35].iter().cloned().fold(f64::MIN, f64::max);
            let loudest = levels.iter().cloned().fold(f64::MIN, f64::max);
            // the crossing only: up to r = 0.5 (4 s of rest, then 3.3 s)
            let worst = worst_rise(&levels[..73]);
            eprintln!(
                "RAMP {name} seed {seed}: worst {worst:.2} tone {:.1}",
                loudest - centre
            );
            if worst > 3.0 {
                let line: Vec<String> = levels[30..].iter().map(|l| format!("{l:.0}")).collect();
                eprintln!("   {}", line.join(" "));
            }
            if loudest <= centre + 8.0 {
                failures.push(format!("{name} seed {seed}: no tone emerged"));
            }
            if worst > 3.0 {
                failures.push(format!(
                    "{name} seed {seed}: level rose {worst:.1} dB in 100 ms"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

// ------------------------------------------------------------------ ink ----

/// How many plucks Ink has struck once the bead is at radius `r_end`, having
/// left the centre at 0.15 r/s; and the radius of the first one. The 4 s of
/// rest before the ramp are not counted.
fn ink_ramp(seed: u32, angle: f64, r_end: f64) -> (Option<f64>, u64) {
    let mut s = synth_for(INK, 65.4, seed, SR);
    s.set(6, 0.1);
    s.set(7, 1.5);
    let th = angle.to_radians();
    let (lead, speed) = (6.0, 0.15);
    let mut base = None;
    let mut first = None;
    let mut count = 0;
    for b in 0..blocks(lead + r_end / speed, SR) {
        let t = (b * QUANTUM) as f64 / f64::from(SR) - lead;
        let r = if t <= 0.0 { 0.0 } else { speed * t };
        if b % 12 == 0 {
            s.set_law(&block(r * th.cos(), r * th.sin(), seed));
        }
        s.render(QUANTUM);
        if t >= 0.0 {
            let start = *base.get_or_insert(s.pluck_count());
            count = s.pluck_count() - start;
            if count > 0 && first.is_none() {
                first = Some(r);
            }
        }
    }
    (first, count)
}

#[test]
fn ink_starts_playing_as_the_bead_leaves_the_centre() {
    // Before: silent through the Hopf region, first note at r ≈ 0.6–0.75 (or
    // never). The bead moves at 0.15 r/s; the Hopf sits at r ≈ 0.26–0.37.
    // (In the directions listed the Hopf comes early; along the others every
    // voice, Flame too, only wakes at r ≈ 0.5.)
    for (seed, angle) in [
        (1, 90.0),
        (1, 180.0),
        (1, 270.0),
        (7, 90.0),
        (7, 180.0),
        (7, 270.0),
        (42, 180.0),
        (42, 270.0),
        (90_210, 180.0),
        (90_210, 270.0),
    ] {
        let (first, count) = ink_ramp(seed, angle, 0.5);
        let first = first.unwrap_or(9.0);
        assert!(
            first <= 0.45,
            "seed {seed} angle {angle}: first pluck at r = {first:.2}"
        );
        assert!(
            count >= 3,
            "seed {seed} angle {angle}: only {count} plucks by r = 0.5"
        );
    }
}

#[test]
fn ink_is_audible_before_the_bead_reaches_the_hopf_hold() {
    // On the journey the notes must be there (+6 dB over the drone-only centre)
    // by r = 0.45 (5.9 s) rather than at 9.3 s as before.
    let levels = window_levels(slice(&journeys()[1].control, 0.0, 12.0), 0.1, SR);
    let centre = levels[10..20].iter().cloned().fold(f64::MIN, f64::max);
    let onset = (20..levels.len())
        .find(|&i| levels[i] > centre + 6.0)
        .map(|i| i as f64 * 0.1)
        .expect("ink never started");
    let (u, v) = bead(onset);
    let r = (u * u + v * v).sqrt();
    assert!(r <= 0.45, "ink starts at {onset:.1} s, r = {r:.2}");
}

#[test]
fn ink_is_silent_at_a_true_fixed_point() {
    // The probes rest with a little noise; the section hysteresis must keep
    // that from ever striking a note. (The bead is nowhere near a bifurcation.)
    for seed in [1, 42] {
        for (r, angle) in [(0.0, 0.0), (0.1, 90.0), (0.2, 180.0), (0.2, 270.0)] {
            let th = f64::to_radians(angle);
            let mut s = synth_for(INK, 65.4, seed, 24_000.0);
            s.set(6, -1.0);
            s.set(7, 0.0);
            s.set_law(&block(r * th.cos(), r * th.sin(), seed));
            for _ in 0..blocks(3.0, 24_000.0) {
                s.render(QUANTUM);
            }
            let settled = s.pluck_count();
            for _ in 0..blocks(15.0, 24_000.0) {
                s.render(QUANTUM);
            }
            assert_eq!(
                s.pluck_count() - settled,
                0,
                "seed {seed} r {r} angle {angle}: stray plucks at a fixed point"
            );
        }
    }
}

// ---------------------------------------------------------------- shake ----

#[test]
fn a_shake_is_an_unmistakable_but_soft_event() {
    // Before: +1.2 dB (Flame) and +1.1 (Prism) over the first 0.6 s. Now +6 to +8 dB, and back within 2.5 dB a second and a half on.
    for (vi, (name, _, _)) in VOICES.iter().enumerate() {
        if vi == 1 {
            continue; // Ink's notes reshuffle after a shake; the level alone says little
        }
        let Rendered { control, events } = &journeys()[vi];
        let delta = |from: f64, to: f64| {
            level(slice(events, SHAKE_AT + from, SHAKE_AT + to))
                - level(slice(control, SHAKE_AT + from, SHAKE_AT + to))
        };
        let heard = delta(0.0, 0.6);
        assert!(
            (5.0..=9.0).contains(&heard),
            "{name}: the shake is {heard:+.1} dB over the first 0.6 s"
        );
        let settled = delta(1.5, 2.5);
        assert!(
            settled.abs() <= 2.5,
            "{name}: still {settled:+.1} dB after 1.5 s"
        );
        let peak = events.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak <= 0.9 + 1e-6, "{name}: peak {peak}");
    }
    // Ink hears it too (its notes are random, so only roughly).
    let Rendered { control, events } = &journeys()[1];
    let heard = level(slice(events, SHAKE_AT, SHAKE_AT + 0.6))
        - level(slice(control, SHAKE_AT, SHAKE_AT + 0.6));
    assert!(heard >= 1.0, "ink: the shake is {heard:+.1} dB");
}
