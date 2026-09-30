//! Preview of the parameter disk, coloured by Kaplan–Yorke dimension.
//!
//!   cargo run --release --example map -- <seed> <out.png> [size]
//!
//! Palette: 0 dark · 1 blue · 2 gold · 2–3 spectral · 3 white, with contour
//! lines at integer D. Ticks outside the rim mark where each anchor sits.
//! The PNG is written by hand (stored deflate blocks), no dependencies.

use axiom_core::anchors::NAMES;
use axiom_core::law::{write_params, Law, Placement, PARAMS_LEN};
use axiom_core::spectrum::classify_law;
use std::sync::atomic::{AtomicUsize, Ordering};

const BG: [u8; 3] = [5, 6, 10];
const STOPS: [(f64, [f64; 3]); 6] = [
    (0.0, [8.0, 10.0, 18.0]),
    (1.0, [40.0, 92.0, 255.0]),
    (2.0, [255.0, 190.0, 64.0]),
    (2.45, [255.0, 84.0, 150.0]),
    (2.8, [90.0, 224.0, 255.0]),
    (3.0, [255.0, 255.0, 255.0]),
];
/// Per-kind tick colours (Thomas, Aizawa, Lorenz, Rossler, Halvorsen).
const TICKS: [[u8; 3]; 5] = [
    [255, 255, 255],
    [255, 90, 90],
    [90, 255, 140],
    [200, 120, 255],
    [255, 160, 40],
];

fn palette(d: f64) -> [u8; 3] {
    let d = d.clamp(0.0, 3.0);
    let i = STOPS
        .iter()
        .rposition(|s| s.0 <= d)
        .unwrap()
        .min(STOPS.len() - 2);
    let ((d0, c0), (d1, c1)) = (STOPS[i], STOPS[i + 1]);
    let t = (d - d0) / (d1 - d0);
    std::array::from_fn(|k| (c0[k] + (c1[k] - c0[k]) * t).round() as u8)
}

/// D_KY and regime of the world field at one disk point: 25 world units of
/// transient, then 100 of averaging.
fn probe(u: f64, v: f64, seed: u32) -> (f64, u8) {
    let mut block = [0.0f32; PARAMS_LEN];
    write_params(u as f32, v as f32, seed, &mut block);
    classify_law(&Law::from_block(&block), 25.0, 100.0, 0.025)
}

// ------------------------------------------------------------------ PNG ---

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, t) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *t = c;
    }
    !data.iter().fold(!0u32, |c, &b| {
        table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8)
    })
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    let mut tagged = kind.to_vec();
    tagged.extend_from_slice(body);
    out.extend_from_slice(&tagged);
    out.extend_from_slice(&crc32(&tagged).to_be_bytes());
}

fn png(w: usize, h: usize, rgb: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((w * 3 + 1) * h);
    for row in rgb.chunks(w * 3) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, b) in blocks.iter().enumerate() {
        z.push(u8::from(i + 1 == blocks.len()));
        z.extend_from_slice(&(b.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(b.len() as u16)).to_le_bytes());
        z.extend_from_slice(b);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

// ----------------------------------------------------------------- main ---

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: map <seed> <out.png> [size]");
        std::process::exit(2);
    }
    let seed: u32 = args[0].parse().expect("seed must be an integer");
    let size: usize = args.get(2).map_or(256, |s| s.parse().expect("bad size"));
    let started = std::time::Instant::now();

    // Pixel (i, j) ↔ disk point; v grows upward.
    let to_disk = |i: usize, j: usize| {
        let u = (i as f64 + 0.5) / size as f64 * 2.0 - 1.0;
        let v = 1.0 - (j as f64 + 0.5) / size as f64 * 2.0;
        (u, v)
    };
    let next = AtomicUsize::new(0);
    let cells = std::sync::Mutex::new(vec![(f64::NAN, 0u8); size * size]);
    std::thread::scope(|s| {
        for _ in 0..4 {
            s.spawn(|| loop {
                let j = next.fetch_add(1, Ordering::Relaxed);
                if j >= size {
                    break;
                }
                let row: Vec<(f64, u8)> = (0..size)
                    .map(|i| {
                        let (u, v) = to_disk(i, j);
                        if u * u + v * v <= 1.0 {
                            probe(u, v, seed)
                        } else {
                            (f64::NAN, 0)
                        }
                    })
                    .collect();
                cells.lock().unwrap()[j * size..(j + 1) * size].copy_from_slice(&row);
            });
        }
    });
    let cells = cells.into_inner().unwrap();

    let level = |i: usize, j: usize| cells[j * size + i].0;
    let band = |d: f64| (d + 1e-3).floor();
    let mut rgb = vec![0u8; size * size * 3];
    let mut area = [0usize; 5];
    // Fixed-point share per radial band of width 0.05 (index = floor(r / 0.05)).
    let mut bands = [(0usize, 0usize); 20];
    for j in 0..size {
        for i in 0..size {
            let d = level(i, j);
            if !d.is_nan() {
                let (u, v) = to_disk(i, j);
                let b = (((u * u + v * v).sqrt() / 0.05) as usize).min(19);
                bands[b].0 += 1;
                bands[b].1 += usize::from(cells[j * size + i].1 == 0);
            }
            let mut c = if d.is_nan() { BG } else { palette(d) };
            if !d.is_nan() {
                area[cells[j * size + i].1 as usize] += 1;
                let edge = [(i + 1, j), (i, j + 1)]
                    .into_iter()
                    .filter(|&(a, b)| a < size && b < size)
                    .any(|(a, b)| !level(a, b).is_nan() && band(level(a, b)) != band(d));
                if edge {
                    c = c.map(|v| (v as f64 * 0.35) as u8);
                }
            }
            rgb[(j * size + i) * 3..][..3].copy_from_slice(&c);
        }
    }

    // Anchor ticks just outside the rim.
    let pl = Placement::new(seed);
    for kind in pl.order {
        let th = pl.angle_of(kind).unwrap_or(0.0);
        for step in 0..=6 {
            let r = 1.0 + 0.012 * step as f64;
            let (u, v) = (r * th.cos(), r * th.sin());
            let i = ((u + 1.0) / 2.0 * size as f64) as isize;
            let j = ((1.0 - v) / 2.0 * size as f64) as isize;
            for (di, dj) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (i, j) = (i + di, j + dj);
                if (0..size as isize).contains(&i) && (0..size as isize).contains(&j) {
                    rgb[(j as usize * size + i as usize) * 3..][..3].copy_from_slice(&TICKS[kind]);
                }
            }
        }
        println!(
            "{:9} at {:6.1} deg  tick {:?}",
            NAMES[kind],
            th.to_degrees().rem_euclid(360.0),
            TICKS[kind]
        );
    }

    std::fs::write(&args[1], png(size, size, &rgb)).expect("cannot write png");
    let total: usize = area.iter().sum();
    let pct = |k: usize| 100.0 * area[k] as f64 / total as f64;
    println!(
        "seed {seed}: {size}x{size} in {:.1}s -> {}",
        started.elapsed().as_secs_f64(),
        args[1]
    );
    let share = |lo: usize, hi: usize| {
        let (n, f) = bands[lo..hi]
            .iter()
            .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
        100.0 * f as f64 / n.max(1) as f64
    };
    let worst = (14..20)
        .map(|k| 100.0 * bands[k].1 as f64 / bands[k].0.max(1) as f64)
        .fold(0.0, f64::max);
    println!(
        "fixed share by radius: r<0.35 {:.0}%  0.35-0.6 {:.0}%  0.6-0.7 {:.0}%  r>=0.7 {:.1}% (worst 0.05-band {:.1}%)",
        share(0, 7),
        share(7, 12),
        share(12, 14),
        share(14, 20),
        worst
    );
    println!(
        "disk area  fixed {:.0}%  cycle {:.0}%  torus {:.0}%  strange {:.0}%  labyrinth {:.0}%",
        pct(0),
        pct(1),
        pct(2),
        pct(3),
        pct(4)
    );
}
