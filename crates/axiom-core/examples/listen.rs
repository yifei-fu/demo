//! Render the scripted listening journey natively and measure it.
//!
//!   cargo run --release --example listen -- [out_dir] [seed]
//!
//! The same journey the browser-side listening analysis uses: the bead glides
//! centre -> Hopf -> rim -> labyrinth (with a stir burst) -> Lorenz (with a
//! shake) -> centre, the law is refreshed at 30 Hz from `write_params`, and
//! λ1 / D come from the live `Spectrum` tracker exactly as the app sends them.
//! Every preset is rendered twice (with and without the stir and shake events)
//! at 48 kHz in 128-frame quanta; the events render is written to
//! `<out_dir>/<name>.wav` (16-bit stereo, TPDF dither) and, low-passed at
//! 15 kHz by a Kaiser-windowed sinc, to `<out_dir>/<name>-32k.wav` (32 kHz).
//! The tables below are printed.
//!
//! Per segment: RMS (dB), the level above 200 Hz, peak, spectral centroid, the
//! shares of energy below 200 Hz and above 4 kHz; then the steepest level rise
//! per 100 ms, when the Hopf tone (or Ink) becomes audible and at which bead
//! radius, the shake, and every preset's loudness relative to the classic one.
//!
//! Environment: `ONLY=<name prefix>` renders one preset; `SERIES=<from>,<to>`
//! prints the level (dB, 50 ms windows) between those seconds; `PLUCKS=1`
//! prints Ink's notes per second.

use axiom_core::law::{write_params, PARAMS_LEN};
use axiom_core::rng::Rng;
use axiom_core::spectrum::Spectrum;
use axiom_core::synth::Synth;
use std::f64::consts::PI;
use std::io::Write;

const SR: usize = 48_000;
const QUANTUM: usize = 128;
const DURATION: f64 = 24.5;
const STIR: (f64, f64) = (13.9, 15.0);
const SHAKE_AT: f64 = 19.3;

/// (name, start s, end s) of the analysed segments.
const SEGS: [(&str, f64, f64); 10] = [
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

/// (file name, preset id, root Hz): the three shipped voices.
const PRESETS: [(&str, u32, f32); 3] = [("prism", 2, 73.4), ("ink", 1, 65.4), ("flame", 0, 55.0)];
/// The voice the others' loudness is compared with.
const REFERENCE: &str = "flame";

fn ease(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// The bead's position on the disk at time `t`.
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
    s: usize,
    block: [f32; PARAMS_LEN],
    l1: Option<f32>,
    dky: Option<f32>,
    stir: Option<f32>,
    shake: bool,
}

fn total() -> usize {
    (DURATION * SR as f64 / QUANTUM as f64).round() as usize * QUANTUM
}

fn schedule(seed: u32, events: bool) -> Vec<Tick> {
    let mut spec = Spectrum::new(seed);
    let mut block = [0.0f32; PARAMS_LEN];
    write_params(0.0, 0.0, seed, &mut block);
    let law = axiom_core::law::Law::from_block(&block);
    for _ in 0..120 {
        spec.step(&law, 0.4);
    }
    let (mut sent_l, mut sent_d, mut sent_s) = (f32::NAN, f32::NAN, 0.0f32);
    let (mut stir_gain, mut shaken) = (0.0f64, false);
    let mut ticks = Vec::new();
    for n in 0.. {
        let s = (n as f64 * 1600.0 / QUANTUM as f64).round() as usize * QUANTUM;
        if s >= total() {
            break;
        }
        let t = s as f64 / SR as f64;
        let (u, v) = bead(t);
        write_params(u as f32, v as f32, seed, &mut block);
        let law = axiom_core::law::Law::from_block(&block);
        spec.step(&law, 0.4);
        spec.step(&law, 0.4);
        let r = spec.read();
        let mut tick = Tick {
            s,
            block,
            l1: None,
            dky: None,
            stir: None,
            shake: false,
        };
        if (r[0] - sent_l).abs() >= 0.004 || sent_l.is_nan() {
            tick.l1 = Some(r[0]);
            sent_l = r[0];
        }
        if (r[3] - sent_d).abs() >= 0.004 || sent_d.is_nan() {
            tick.dky = Some(r[3]);
            sent_d = r[3];
        }
        if events {
            let active = t >= STIR.0 && t < STIR.1;
            let tau: f64 = if active { 0.08 } else { 0.25 };
            stir_gain +=
                (f64::from(u8::from(active)) - stir_gain) * (1.0 - (-(1.0 / 30.0) / tau).exp());
            if stir_gain < 0.002 {
                stir_gain = 0.0;
            }
            let level =
                (stir_gain * 0.85 * (0.85 + 0.15 * (2.0 * PI * 1.3 * t).sin())).min(1.0) as f32;
            if (level - sent_s).abs() >= 0.004 || (level == 0.0 && sent_s != 0.0) {
                tick.stir = Some(level);
                sent_s = level;
            }
            if !shaken && t >= SHAKE_AT {
                tick.shake = true;
                shaken = true;
            }
        }
        ticks.push(tick);
    }
    ticks
}

/// Render one preset along the schedule; returns (left, right).
fn render(preset: u32, root: f32, seed: u32, ticks: &[Tick]) -> (Vec<f32>, Vec<f32>) {
    let mut counts: Vec<u64> = Vec::new();
    let n = total();
    let mut synth = Synth::new(SR as f32, seed);
    synth.set(4, preset as f32);
    synth.set(5, root);
    let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
    let mut ti = 0;
    let mut s = 0;
    while s < n {
        while ti < ticks.len() && ticks[ti].s <= s {
            let t = &ticks[ti];
            synth.set_law(&t.block);
            if let Some(v) = t.l1 {
                synth.set(6, v);
            }
            if let Some(v) = t.dky {
                synth.set(7, v);
            }
            if let Some(v) = t.stir {
                synth.set(1, v);
            }
            if t.shake {
                synth.set(3, 1.0);
            }
            ti += 1;
        }
        let out = synth.render(QUANTUM);
        for i in 0..QUANTUM {
            l[s + i] = out[2 * i];
            r[s + i] = out[2 * i + 1];
        }
        s += QUANTUM;
        counts.push(synth.pluck_count());
    }
    if preset == 1 && std::env::var("PLUCKS").is_ok() && ticks.iter().all(|t| !t.shake) {
        let at = |t: f64| counts[((t * SR as f64) as usize / QUANTUM).min(counts.len() - 1)];
        let per_second: Vec<String> = (0..24)
            .map(|i| (at(i as f64 + 1.0) - at(i as f64)).to_string())
            .collect();
        println!("plucks per second, 0..24 s: {}", per_second.join(" "));
    }
    (l, r)
}

// ------------------------------------------------------------ analysis ----

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
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}

struct Audio {
    l: Vec<f32>,
    r: Vec<f32>,
}

fn range(t0: f64, t1: f64) -> (usize, usize) {
    (
        (t0 * SR as f64).round() as usize,
        (t1 * SR as f64).round() as usize,
    )
}

/// Welch-averaged power over [t0, t1), both channels averaged.
fn welch(a: &Audio, t0: f64, t1: f64) -> Vec<f64> {
    const N: usize = 8192;
    let (s0, s1) = range(t0, t1);
    let window: Vec<f64> = (0..N)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / N as f64).cos())
        .collect();
    let mut acc = vec![0.0; N / 2 + 1];
    let mut frames: f64 = 0.0;
    let mut s = s0;
    while s + N <= s1 {
        for ch in [&a.l, &a.r] {
            let mut re: Vec<f64> = (0..N).map(|i| f64::from(ch[s + i]) * window[i]).collect();
            let mut im = vec![0.0; N];
            fft(&mut re, &mut im);
            for k in 0..=N / 2 {
                acc[k] += re[k] * re[k] + im[k] * im[k];
            }
            frames += 1.0;
        }
        s += N / 2;
    }
    for v in acc.iter_mut() {
        *v /= frames.max(1.0);
    }
    acc
}

struct Row {
    db: f64,
    peak: f64,
    centroid: f64,
    lf: f64,
    hf: f64,
    db200: f64,
}

fn rms_peak(a: &Audio, t0: f64, t1: f64) -> (f64, f64, f64) {
    let (s0, s1) = range(t0, t1);
    let (mut e, mut pk) = (0.0f64, 0.0f64);
    for i in s0..s1 {
        e += f64::from(a.l[i]).powi(2) + f64::from(a.r[i]).powi(2);
        pk = pk.max(f64::from(a.l[i].abs())).max(f64::from(a.r[i].abs()));
    }
    let rms = (e / (2.0 * (s1 - s0) as f64)).sqrt();
    (rms, 20.0 * (rms + 1e-12).log10(), pk)
}

fn row(a: &Audio, t0: f64, t1: f64) -> Row {
    let (_, db, peak) = rms_peak(a, t0, t1);
    let p = welch(a, t0, t1);
    let df = SR as f64 / 8192.0;
    let (mut num, mut den, mut hf, mut lf) = (0.0, 0.0, 0.0, 0.0);
    for (k, v) in p.iter().enumerate().skip(1) {
        let f = k as f64 * df;
        num += f * v;
        den += v;
        if f > 4000.0 {
            hf += v;
        }
        if f < 200.0 {
            lf += v;
        }
    }
    let lf = lf / den;
    Row {
        db,
        peak,
        centroid: num / den,
        lf,
        hf: hf / den,
        db200: db + 10.0 * (1.0 - lf).max(1e-9).log10(),
    }
}

/// Level (dB) inside [f0, f1) Hz over [t0, t1).
fn band_db(a: &Audio, t0: f64, t1: f64, f0: f64, f1: f64) -> f64 {
    let p = welch(a, t0, t1);
    let df = SR as f64 / 8192.0;
    let (mut e, mut tot) = (0.0, 0.0);
    for (k, v) in p.iter().enumerate().skip(1) {
        tot += v;
        let f = k as f64 * df;
        if f >= f0 && f < f1 {
            e += v;
        }
    }
    let (rms, _, _) = rms_peak(a, t0, t1);
    20.0 * (rms * (e / tot).sqrt() + 1e-12).log10()
}

fn short_term(a: &Audio, win: f64) -> Vec<f64> {
    let n = (DURATION / win).floor() as usize;
    (0..n)
        .map(|i| rms_peak(a, i as f64 * win, (i + 1) as f64 * win).1)
        .collect()
}

fn max_jump(series: &[f64], win: f64) -> (f64, f64) {
    let mut best = (0.0, 0.0);
    for i in 1..series.len() {
        if series[i] < -60.0 || series[i - 1] < -60.0 {
            continue;
        }
        let d = (series[i] - series[i - 1]).abs();
        if d > best.0 {
            best = (d, i as f64 * win);
        }
    }
    best
}

/// 16-bit stereo WAV at `rate` Hz, with TPDF dither (deterministic).
fn write_wav(path: &str, l: &[f32], r: &[f32], rate: usize) -> std::io::Result<()> {
    let n = l.len();
    let mut buf = Vec::with_capacity(44 + 4 * n);
    let u32le = |v: u32| v.to_le_bytes();
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&u32le(36 + 4 * n as u32));
    buf.extend_from_slice(b"WAVEfmt ");
    buf.extend_from_slice(&u32le(16));
    buf.extend_from_slice(&[1, 0, 2, 0]);
    buf.extend_from_slice(&u32le(rate as u32));
    buf.extend_from_slice(&u32le(rate as u32 * 4));
    buf.extend_from_slice(&[4, 0, 16, 0]);
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&u32le(4 * n as u32));
    let mut rng = Rng::new(9, 9);
    for i in 0..n {
        for v in [l[i], r[i]] {
            let dither = (rng.f64() - rng.f64()) / 32768.0;
            let s = ((f64::from(v) + dither) * 32767.0)
                .round()
                .clamp(-32768.0, 32767.0) as i16;
            buf.extend_from_slice(&s.to_le_bytes());
        }
    }
    std::fs::File::create(path)?.write_all(&buf)
}

/// Zeroth-order modified Bessel function (Kaiser window).
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term) = (1.0, 1.0);
    for k in 1..40 {
        term *= (x / (2.0 * k as f64)).powi(2);
        sum += term;
    }
    sum
}

/// Rational-ratio sample-rate conversion by a Kaiser-windowed sinc (β = 8,
/// 256 taps at the input rate) low-passed at `cutoff` Hz. Output sample `j`
/// sits at input time `j·from/to`; there are only `to/gcd` distinct
/// fractional offsets, so each kernel is computed once.
fn resample(x: &[f32], from: usize, to: usize, cutoff: f64) -> Vec<f32> {
    const HALF: usize = 128;
    const BETA: f64 = 8.0;
    let gcd = |mut a: usize, mut b: usize| {
        while b != 0 {
            (a, b) = (b, a % b);
        }
        a
    };
    let g = gcd(from, to);
    let (p, q) = (from / g, to / g);
    let fc = cutoff / from as f64;
    let norm = bessel_i0(BETA);
    let kernels: Vec<Vec<f64>> = (0..q)
        .map(|phase| {
            let frac = phase as f64 / q as f64;
            (0..2 * HALF)
                .map(|t| {
                    let d = t as f64 - (HALF as f64 - 1.0) - frac;
                    let u = d / HALF as f64;
                    if u.abs() >= 1.0 {
                        return 0.0;
                    }
                    let sinc = if d == 0.0 {
                        2.0 * fc
                    } else {
                        (2.0 * PI * fc * d).sin() / (PI * d)
                    };
                    sinc * bessel_i0(BETA * (1.0 - u * u).sqrt()) / norm
                })
                .collect()
        })
        .collect();
    let out_len = x.len() * to / from;
    (0..out_len)
        .map(|j| {
            let (base, phase) = ((j * p) / q, (j * p) % q);
            let mut acc = 0.0;
            for (t, k) in kernels[phase].iter().enumerate() {
                let i = base as isize - (HALF as isize - 1) + t as isize;
                if i >= 0 && (i as usize) < x.len() {
                    acc += f64::from(x[i as usize]) * k;
                }
            }
            acc as f32
        })
        .collect()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let out_dir = args.next();
    let seed: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).expect("create output directory");
    }
    let control_ticks = schedule(seed, false);
    let event_ticks = schedule(seed, true);
    let only = std::env::var("ONLY").ok();
    let mut summary: Vec<(&str, Vec<f64>, Vec<f64>)> = Vec::new();
    for (name, preset, root) in PRESETS {
        if only.as_deref().is_some_and(|o| !name.starts_with(o)) {
            continue;
        }
        let started = std::time::Instant::now();
        let (cl, cr) = render(preset, root, seed, &control_ticks);
        let speed = DURATION / started.elapsed().as_secs_f64();
        let (el, er) = render(preset, root, seed, &event_ticks);
        let control = Audio { l: cl, r: cr };
        let events = Audio { l: el, r: er };
        let (_, all_db, all_peak) = rms_peak(&events, 0.0, DURATION);
        println!(
            "\n== {name}  preset {preset} root {root}  peak {all_peak:.3}  rms {all_db:.1} dB  ({speed:.0}x real time natively)"
        );
        println!("seg          rmsdB  >200Hz   peak  centroid <200Hz% HF>4k%");
        let mut rows = Vec::new();
        for (seg, t0, t1) in SEGS {
            let r = row(&control, t0, t1);
            println!(
                "{seg:<12} {:>6.1} {:>7.1} {:>6.3} {:>8.0} {:>7.0} {:>7.1}",
                r.db,
                r.db200,
                r.peak,
                r.centroid,
                r.lf * 100.0,
                r.hf * 100.0
            );
            rows.push(r);
        }
        let st = short_term(&control, 0.1);
        let st25 = short_term(&control, 0.25);
        if let Ok(range) = std::env::var("SERIES") {
            let mut it = range.split(',').filter_map(|v| v.parse::<f64>().ok());
            let (a, b) = (it.next().unwrap_or(0.0), it.next().unwrap_or(DURATION));
            let fine = short_term(&control, 0.05);
            let line: Vec<String> = (0..fine.len())
                .filter(|&i| i as f64 * 0.05 >= a && (i as f64 * 0.05) < b)
                .map(|i| format!("{:.1}", fine[i]))
                .collect();
            println!("series {a}..{b} s (50 ms dB): {}", line.join(" "));
        }
        let (j100, t100) = max_jump(&st, 0.1);
        let (j250, t250) = max_jump(&st25, 0.25);
        println!("level jump: 100 ms max {j100:.1} dB @ {t100:.1} s | 250 ms max {j250:.1} dB @ {t250:.2} s");
        // the steepest 100 ms rise inside the Hopf approach (2..8 s)
        let mut worst = (0.0f64, 0.0f64);
        for i in 21..80 {
            let d = st[i] - st[i - 1];
            if st[i - 1] > -60.0 && d > worst.0 {
                worst = (d, i as f64 * 0.1);
            }
        }
        println!(
            "steepest rise 2..8 s: {:.1} dB / 100 ms @ {:.1} s",
            worst.0, worst.1
        );
        let centre_db = rows[0].db;
        let onset = (16..st.len())
            .find(|&i| st[i] > centre_db + 6.0)
            .map(|i| i as f64 * 0.1);
        let onset_r = onset.map(|t| {
            let (u, v) = bead(t);
            (u * u + v * v).sqrt()
        });
        println!(
            "onset(+6 dB over centre): {} (bead r = {})",
            onset.map_or("none".into(), |t| format!("{t:.1} s")),
            onset_r.map_or("-".into(), |r| format!("{r:.2}"))
        );
        let stir_mid = (
            band_db(&control, STIR.0, STIR.1 + 0.2, 500.0, 4000.0),
            band_db(&events, STIR.0, STIR.1 + 0.2, 500.0, 4000.0),
        );
        println!(
            "stir mid band 0.5-4 kHz: {:.1} -> {:.1} dB",
            stir_mid.0, stir_mid.1
        );
        // shake: events minus control, 100 ms windows from the shake
        let delta: Vec<f64> = (0..40)
            .map(|i| {
                let t = SHAKE_AT + 0.1 * i as f64;
                rms_peak(&events, t, t + 0.1).1 - rms_peak(&control, t, t + 0.1).1
            })
            .collect();
        let peak = delta.iter().cloned().fold(f64::MIN, f64::max);
        let settle = delta
            .iter()
            .rposition(|d| *d > 1.5)
            .map_or(0.0, |i| (i + 1) as f64 * 0.1);
        let win = rms_peak(&events, SHAKE_AT, SHAKE_AT + 0.6).1
            - rms_peak(&control, SHAKE_AT, SHAKE_AT + 0.6).1;
        println!(
            "shake: 0.6 s window +{win:.1} dB, 100 ms peak +{peak:.1} dB, above +1.5 dB for {settle:.1} s"
        );
        let line: Vec<String> = delta.iter().map(|d| format!("{d:.0}")).collect();
        println!("shake delta per 100 ms: {}", line.join(" "));
        if let Some(dir) = &out_dir {
            write_wav(&format!("{dir}/{name}.wav"), &events.l, &events.r, SR).expect("write wav");
            let (l, r) = (
                resample(&events.l, SR, 32_000, 15_000.0),
                resample(&events.r, SR, 32_000, 15_000.0),
            );
            write_wav(&format!("{dir}/{name}-32k.wav"), &l, &r, 32_000).expect("write wav");
        }
        summary.push((
            name,
            rows.iter().map(|r| r.db).collect(),
            rows.iter().map(|r| (1.0 - r.lf) * 100.0).collect(),
        ));
    }
    println!("\n== loudness relative to {REFERENCE} (dB) and share of energy above 200 Hz (%)");
    let reference = summary
        .iter()
        .find(|s| s.0 == REFERENCE)
        .map(|s| s.1.clone());
    for (name, db, hi) in &summary {
        let rel: Vec<String> = (1..9)
            .map(|i| match &reference {
                Some(r) => format!("{:+5.1}", db[i] - r[i]),
                None => format!("{:5.1}", db[i]),
            })
            .collect();
        let mean = (1..9).map(|i| 10f64.powf(db[i] / 10.0)).sum::<f64>() / 8.0;
        let share: Vec<String> = (1..9).map(|i| format!("{:3.0}", hi[i])).collect();
        println!(
            "{name:<20} rel {} | mean {:.1} dB | >200 Hz % {}",
            rel.join(" "),
            10.0 * mean.log10(),
            share.join(" ")
        );
    }
    println!("(columns: out hopf to-rim rim-arc labyrinth rim-lorenz lorenz return)");
}
