//! `synth_render` (and the spectrum step) must never touch the allocator:
//! they run on the audio thread / in the frame loop.

use axiom_core::law::{write_params, Law, PARAMS_LEN};
use axiom_core::spectrum::Spectrum;
use axiom_core::synth::Synth;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

thread_local! {
    static WATCH: Cell<bool> = const { Cell::new(false) };
}
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

struct Counting;

// SAFETY: forwards every call to the system allocator unchanged.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if WATCH.with(Cell::get) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if WATCH.with(Cell::get) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

fn allocations_during(f: impl FnOnce()) -> usize {
    ALLOCATIONS.store(0, Ordering::Relaxed);
    WATCH.with(|w| w.set(true));
    f();
    WATCH.with(|w| w.set(false));
    ALLOCATIONS.load(Ordering::Relaxed)
}

#[test]
fn render_and_control_paths_do_not_allocate() {
    let mut block = [0.0f32; PARAMS_LEN];
    write_params(0.6, 0.3, 4, &mut block);
    let mut synth = Synth::new(48_000.0, 4);
    let n = allocations_during(|| {
        synth.set_law(&block);
        synth.set(1, 1.0);
        synth.set(2, 0.5);
        synth.set(3, 1.0);
        // Every preset, switched between mid-stream.
        for preset in [0.0, 1.0, 2.0, 3.0, 1.0, 0.0] {
            synth.set(4, preset);
            for _ in 0..300 {
                synth.render(128);
            }
        }
    });
    assert_eq!(n, 0, "synth allocated {n} times on the audio path");

    let mut spectrum = Spectrum::new(4);
    let n = allocations_during(|| {
        let law = Law::from_block(&block);
        for _ in 0..50 {
            spectrum.step(&law, 0.4);
            spectrum.read();
        }
    });
    assert_eq!(n, 0, "spectrum allocated {n} times per frame");
}
