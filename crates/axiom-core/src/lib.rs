//! AXIOM core: the law, its Lyapunov spectrum and the sound of the attractor.
//!
//! The safe Rust API lives in the modules; this file is only the C ABI of
//! DESIGN.md §4. Pointers cross the boundary as `u32` offsets into linear
//! memory, which is why every `unsafe` block is here and nowhere else.

pub mod anchors;
pub mod law;
pub mod reverb;
pub mod rng;
pub mod spectrum;
pub mod synth;
pub mod tables;

use law::{Law, ANCHOR_COUNT, PARAMS_LEN};
use spectrum::Spectrum;
use std::alloc::Layout;
use synth::Synth;

/// Linear-memory address of a Rust value (wasm32 pointers are 32-bit).
fn addr<T>(p: *const T) -> u32 {
    p as usize as u32
}

/// # Safety
/// `ptr` must be the address of `len` initialised, 4-byte-aligned `f32`s.
unsafe fn floats<'a>(ptr: u32, len: usize) -> &'a [f32] {
    std::slice::from_raw_parts(ptr as usize as *const f32, len)
}

/// # Safety
/// `ptr` must be the address of `len` writable, 4-byte-aligned `f32`s.
unsafe fn floats_mut<'a>(ptr: u32, len: usize) -> &'a mut [f32] {
    std::slice::from_raw_parts_mut(ptr as usize as *mut f32, len)
}

/// # Safety
/// `ptr` must come from one of the `*_new` functions and still be alive.
unsafe fn object<'a, T>(ptr: u32) -> &'a mut T {
    &mut *(ptr as usize as *mut T)
}

#[no_mangle]
pub extern "C" fn alloc(bytes: u32) -> u32 {
    match Layout::from_size_align(bytes.max(1) as usize, 16) {
        // SAFETY: the layout has non-zero size.
        Ok(layout) => addr(unsafe { std::alloc::alloc(layout) }),
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: u32, bytes: u32) {
    if let (true, Ok(layout)) = (ptr != 0, Layout::from_size_align(bytes.max(1) as usize, 16)) {
        // SAFETY: JS pairs every `dealloc` with the `alloc` that made `ptr`.
        unsafe { std::alloc::dealloc(ptr as usize as *mut u8, layout) }
    }
}

#[no_mangle]
pub extern "C" fn law_params_len() -> u32 {
    PARAMS_LEN as u32
}

#[no_mangle]
pub extern "C" fn law_anchor_count() -> u32 {
    ANCHOR_COUNT as u32
}

#[no_mangle]
pub extern "C" fn law_params(u: f32, v: f32, seed: u32, out: u32) {
    // SAFETY: the caller allocated `law_params_len()` floats at `out`.
    law::write_params(u, v, seed, unsafe { floats_mut(out, PARAMS_LEN) });
}

#[no_mangle]
pub extern "C" fn spectrum_new(seed: u32) -> u32 {
    addr(Box::into_raw(Box::new(Spectrum::new(seed))))
}

#[no_mangle]
pub extern "C" fn spectrum_step(s: u32, params: u32, world_time: f32) {
    // SAFETY: `s` came from `spectrum_new`; `params` holds a 68-float block.
    let (s, block) = unsafe { (object::<Spectrum>(s), floats(params, PARAMS_LEN)) };
    s.step(&Law::from_block(block), world_time as f64);
}

#[no_mangle]
pub extern "C" fn spectrum_read(s: u32, out: u32) {
    // SAFETY: `s` came from `spectrum_new`; `out` has room for 8 floats.
    let (s, out) = unsafe { (object::<Spectrum>(s), floats_mut(out, 8)) };
    out.copy_from_slice(&s.read());
}

#[no_mangle]
pub extern "C" fn synth_new(sample_rate: f32, seed: u32) -> u32 {
    addr(Box::into_raw(Box::new(Synth::new(sample_rate, seed))))
}

#[no_mangle]
pub extern "C" fn synth_set_law(s: u32, params: u32) {
    // SAFETY: `s` came from `synth_new`; `params` holds a 68-float block.
    let (s, block) = unsafe { (object::<Synth>(s), floats(params, PARAMS_LEN)) };
    s.set_law(block);
}

#[no_mangle]
pub extern "C" fn synth_set(s: u32, id: u32, value: f32) {
    // SAFETY: `s` came from `synth_new`.
    unsafe { object::<Synth>(s) }.set(id, value);
}

#[no_mangle]
pub extern "C" fn synth_render(s: u32, frames: u32) -> u32 {
    // SAFETY: `s` came from `synth_new`.
    let s = unsafe { object::<Synth>(s) };
    s.render(frames as usize);
    addr(s.out_ptr())
}
