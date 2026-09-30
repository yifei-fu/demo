# AXIOM — design contract

*One law, every world between stillness and chaos.*

This document is the single source of truth for everyone building AXIOM. If code and this
document disagree, raise it — don't silently diverge.

---

## 1. The piece

A single 3D dynamical system `ẋ = F(x; μ)` lives in your hand. ~1M particles (256k on phones,
adaptive) flow through it continuously. The parameter `μ` lives on a **unit disk**; you roll a
**bead** across that disk by **tilting** the phone. Every point of the disk is a different law of
motion and neighbouring laws blend continuously. What you see is the **attractor**, and its
**dimension is what you navigate**:

- **centre (r = 0)** – every law has a stable fixed point at the origin → particles fall into
  **one point** (D = 0). The piece opens here: the axiom.
- **outward** – Hopf bifurcation → a **loop** (D = 1) → **torus** (D = 2, via the Aizawa/Langford
  anchor) → **strange attractors** (D ≈ 2.0–2.3) → at the rim, near-volume-filling **labyrinth
  chaos** (D → 3, via Thomas with b → small).
- **around the circle** – the *character* of the law changes: canonical anchors are placed around
  the rim and blended (a homotopy of vector fields).

There is **no timeline**. Changing the law makes the cloud *flow* into the new attractor — the
transitions are the dynamics. After ~20 s without input an **idle autopilot** drifts the bead
slowly; any input takes over instantly.

### Senses → navigation

| Gesture | Effect |
|---|---|
| **Tilt** (relative to the pose held when tapping Begin) | bead velocity on the disk (joystick with dead zone + inertia; level = stay) |
| **Turn body** (yaw) | orbit around the attractor; small attitude change adds holographic parallax |
| **Hold** | dive into the cloud (near particles become bokeh); release drifts back |
| **Drag** | stir — a vortex around the touch ray injects energy |
| **Shake** | scatter every particle; the attractor pulls them back |
| **Pinch / tap lens** | the 2D parameter **map** expands full-screen; drag the bead directly |
| Desktop | drag = orbit, WASD/arrows = bead, wheel = dive, space = shake, M = map |

### Look — "one light"
Ink-black (`#05060a`). Compute-shader **atomic splatting** of particles into a fixed-point RGB +
count buffer, **fractal-flame log-density** tonemapping, one spectral palette driven by
speed/phase, **stochastic depth of field** (each particle deposits at a random point inside its
circle of confusion), regime-dependent **trail persistence**, dual-Kawase bloom, AgX tonemap,
**HDR canvas** (`rgba16float` + `toneMapping: {mode: 'extended'}`, feature-detected), fine
animated grain, vignette. Type: tracked uppercase sans + mono for maths. Restraint over effects.

### Sound — you hear the attractor
The AudioWorklet (Rust → wasm) integrates **the same law at audio rate** for ~6 probe
trajectories; each probe's time-scale is tuned so the law's characteristic frequency lands on a
just-intonation harmonic. Fixed point → silence (DC-blocked); Hopf → a tone *swells into
existence*; cycle → pitched timbre; torus → quasi-periodic beating; chaos → breathing structured
noise. Plus quiet harmonic drone, stir/dive "wind", shake whoosh, 8-line FDN reverb (Hadamard),
soft limiter. Never harsh; always musical.

### Procedural
A `seed` (random per visit, or `?seed=`) sets anchor placement/rotation, palette phase, initial
cloud, probe tunings.

---

## 2. Repository layout and ownership

```
index.html  package.json  package-lock.json  tsconfig.json  vite.config.ts
src/
  main.ts            boot, WebGPU check, start gate, rAF loop, adaptive quality, test hooks
  gpu.ts             device/context/HDR config/resize/helpers
  sensors.ts         all input → one smoothed Input
  navigator.ts       bead physics, autopilot, camera rig
  law.ts             JS side of the law (wasm bridge; round-1 TS stub)
  shaders/*.wgsl     law.wgsl, particles.wgsl, splat.wgsl, post.wgsl, … (imported with ?raw)
  particles.ts       integrate + splat pipelines
  post.ts            resolve/trails/bloom/tonemap/grain
  map.ts             (round 2) Lyapunov / D_KY map + lens
  audio.ts, audio-worklet.ts   (round 2)
  hud.ts, style.css  start/fallback screens, lens, readout
  variants/          (round 2+) one file pair per art direction
  assets/axiom.wasm  BUILD OUTPUT (gitignored), produced by scripts/build-wasm.sh
crates/axiom-core/   zero-dependency Rust crate (cdylib + rlib)
scripts/build-wasm.sh  scripts/shots.mjs
.github/workflows/ci.yml
docs/DESIGN.md       this file (owned by the orchestrator)
```

**Rules for implementers**
- Only edit the paths you own (your task prompt lists them). Need something elsewhere? Say so in
  your final report — don't edit it.
- **Never run git commands that change state** (no commit, stash, checkout, reset, add). The
  orchestrator commits.
- Only the engine owner runs `npm install` / edits `package.json`.
- Use the dev-server port / outDir given in your prompt (parallel agents share the checkout).
- No runtime npm dependencies. Dev deps: `vite`, `typescript`, `prettier`, `playwright@1.56.1`
  (matches the preinstalled Chromium in `/opt/pw-browsers`).
- TypeScript `strict`, no `any`, ES2022 modules, small focused modules (< ~300 lines). WGSL lives
  in `.wgsl` files imported via `?raw`. Comments explain *why*, sparingly.
- Rust: edition 2021, zero dependencies, `cargo fmt` + `cargo clippy -- -D warnings` clean,
  no allocation in the audio render path.

### package.json scripts (engine owner writes these)
```
"dev":          "vite --port 5171",
"wasm":         "bash scripts/build-wasm.sh",
"build":        "npm run wasm && tsc --noEmit && vite build",
"typecheck":    "tsc --noEmit",
"test":         "cargo test --manifest-path crates/axiom-core/Cargo.toml",
"format":       "prettier --write .",
"format:check": "prettier --check .",
"shots":        "node scripts/shots.mjs"
```

---

## 3. The law (maths)

### 3.1 Anchors (system coordinates)
Kind ids are fixed:

| id | name | equations | params (p0…) |
|---|---|---|---|
| 0 | Thomas | ẋ = sin y − b x; ẏ = sin z − b y; ż = sin x − b z | b |
| 1 | Aizawa (Langford) | ẋ = (z−β)x − δy; ẏ = δx + (z−β)y; ż = γ + αz − z³/3 − (x²+y²)(1+εz) + ζ z x³ | α β γ δ ε ζ |
| 2 | Lorenz | ẋ = σ(y−x); ẏ = x(ρ−z) − y; ż = xy − βz | σ ρ β |
| 3 | Rössler | ẋ = −y − z; ẏ = x + a y; ż = b + z(x − c) | a b c |
| 4 | Halvorsen | ẋ = −a x − 4y − 4z − y²; ẏ = −a y − 4z − 4x − z²; ż = −a z − 4x − 4y − x² | a |

Classic chaotic values: Thomas b=0.208186 (chaos below ≈0.208, labyrinth as b→0); Aizawa
α=0.95 β=0.7 γ=0.6 δ=3.5 ε=0.25 ζ=0.1; Lorenz σ=10 ρ=28 β=8/3; Rössler a=b=0.2 c=5.7;
Halvorsen a=1.89.

**As built (round 1):** Halvorsen (kind 4) is implemented but has no route, so 4 anchors sit on the rim at 90°.
`confine_radius` = 1.2. κ(r) = 1.0·(1 − r/0.4)² for r < 0.4, else 0. Blend happens over the middle 40 %
of each arc. World time ≈ real seconds; a loop takes about 4 s. Respawn particles with |x| > 1.6. Keep the
RK2 substep dt ≤ 0.03.

**As built (round 2):** the rim order is a fixed cycle (Thomas, Lorenz, Aizawa, Rössler) so
Lorenz and Rössler never blend. The seed picks the starting anchor, the direction, θ_seed and
the rotations. Blend width is 0.25. `omega` varies (≈ 5.5 on Thomas's labyrinth). A regime is
labelled "fixed" only when the tracer has actually stopped. Disk shares: ≈ 15 % fixed, 23 % cycle,
10 % torus, 45 % strange and 8 % labyrinth, with < 4 % fixed at r ≥ 0.7. Chaotic particle speed
is 0.4–1.4 world units per second. Sound presets 0–3 are implemented. The release profile no
longer sets `panic="abort"`; `scripts/build-wasm.sh` passes it via RUSTFLAGS.

Each anchor has a **radial route**: its parameters (and its normalisation `c`, `L`, `τ`, `ω`) are
smooth functions of `r ∈ [0,1]`, calibrated so that **r = 0 is a stable fixed point mapped to the
world origin**, then Hopf → cycle → (torus for Aizawa) → chaos, with the attractor kept roughly
inside the world unit ball. Calibration lives in Rust as piecewise-linear tables (≥ 9 samples of r)
produced by a calibration routine and checked in. An anchor that cannot be made well-behaved may
be dropped; keep ≥ 4.

### 3.2 World field (what particles, probes and the spectrum all integrate)
Per anchor slot `s`: system coords `x_sys = c_s + L_s · R_s · x`, and

```
F(x) = Σ_s  w_s · (τ_s / L_s) · R_sᵀ · F_kind_s(c_s + L_s R_s x ; p_s)
       − κ · x                                   // header[2]; extra centre damping, ≥ 0
       − K · max(0, |x| − R_c)² · x/|x|          // confinement, K = 8, R_c = header[3]
```

Blend: anchors sit at angles `θ_i = 2πi/N + θ_seed`; weights are a smooth partition of unity
between the **two** nearest anchors (so at most two slots are active). Particles live in world
space; the attractor should fit roughly inside |x| ≤ 1.

### 3.3 `LawParams` block — 68 × f32 (also the GPU uniform, 17 × vec4)
```
[0..4)    header: r, theta, kappa, confine_radius
[4..36)   slot 0
[36..68)  slot 1
slot (32 floats):
   0 kind (int as float; −1 = empty)   1 weight   2 tau   3 L
   4 cx  5 cy  6 cz  7 omega            // omega = characteristic angular freq in WORLD time (audio)
   8..15  p0..p7
  16..27  R as 3 columns, each padded to vec4: (c0.xyz,0) (c1.xyz,0) (c2.xyz,0)
  28..31  reserved (0)
```
WGSL mirror:
```wgsl
struct Slot { a: vec4f, c: vec4f, p0: vec4f, p1: vec4f, r0: vec4f, r1: vec4f, r2: vec4f, pad: vec4f }
struct Law  { header: vec4f, s0: Slot, s1: Slot }
// a = (kind, weight, tau, L); c = (cx, cy, cz, omega); R = mat3x3f(r0.xyz, r1.xyz, r2.xyz)
```
**Rust owns every number.** JS calls `law_params(u, v, seed, out)` each frame and uploads the
block; WGSL only evaluates the formulas. (Round 1 engine uses a tiny TS stub with the same layout —
Thomas only, `b = mix(1.2, 0.16, r)` — deleted in round 2.)

### 3.4 Spectrum and regime
Benettin's method on the world field: 3 tangent vectors, Gram–Schmidt re-orthonormalisation,
exponential forgetting (time constant ≈ 10 world-time units) so values track navigation.
Kaplan–Yorke: `j` = largest k with Σ_{i≤k} λ_i ≥ 0; `D = j + Σ_{i≤j} λ_i / |λ_{j+1}|` (all
negative → D = 0). Regime codes, with ε ≈ 0.01:

| code | name | rule |
|---|---|---|
| 0 | fixed point | λ1 < −ε |
| 1 | cycle | \|λ1\| ≤ ε, λ2 < −ε |
| 2 | torus | \|λ1\| ≤ ε, \|λ2\| ≤ ε |
| 3 | strange | λ1 > ε, D < 2.7 |
| 4 | labyrinth | λ1 > ε, D ≥ 2.7 |

---

## 4. wasm ABI (`crates/axiom-core` → `src/assets/axiom.wasm`)
Plain `extern "C"` exports, no wasm-bindgen, **no imports**. Pointers are u32 offsets into the
module's memory. Build: `cargo build --release --target wasm32-unknown-unknown` with
`RUSTFLAGS="-C target-feature=+simd128"`, release profile `opt-level=3, lto=true,
codegen-units=1, panic="abort"`. Target size < 80 KB.

```
alloc(bytes: u32) -> u32                      dealloc(ptr: u32, bytes: u32)
law_params_len() -> u32                        // 68
law_anchor_count() -> u32
law_params(u: f32, v: f32, seed: u32, out: u32)   // writes 68 f32
spectrum_new(seed: u32) -> u32
spectrum_step(s: u32, params: u32, world_time: f32)   // integrate & update exponents
spectrum_read(s: u32, out: u32)                // 8 f32: λ1 λ2 λ3 D regime x y z
synth_new(sample_rate: f32, seed: u32) -> u32
synth_set_law(s: u32, params: u32)             // 68-float block
synth_set(s: u32, id: u32, value: f32)
synth_render(s: u32, frames: u32) -> u32       // ptr to interleaved stereo f32, frames ≤ 256
```
`synth_set` ids: 0 master (0..1) · 1 stir (0..1) · 2 dive (0..1) · 3 shake (write 1 = trigger) ·
4 preset (int) · 5 root_hz · 6 λ1 · 7 D.

JS: views into wasm memory must be re-created if `memory.buffer` changes (growth). In the
AudioWorklet the module is instantiated **synchronously** from bytes posted by the main thread:
`new WebAssembly.Instance(new WebAssembly.Module(bytes), {})`.

Worklet messages: `{type:'init', bytes, seed}` · `{type:'law', params: Float32Array}` (≤ 30 Hz) ·
`{type:'set', id, value}`.

---

## 5. Engine contract

- **World**: attractor ≈ unit ball at origin. Camera orbits at distance ≈ 3.2; dive to ≈ 0.25.
- **Particles**: storage buffer `vec4f` (xyz, phase). Integrate RK2 with substeps; forces: stir
  vortex around the touch ray, shake kick. Respawn escaped/NaN particles and a trickle (~0.2 % /
  frame) uniformly in a radius-1.2 ball, so faint streams keep flowing *into* the attractor.
  Budget: 1,048,576 desktop / 262,144 phone, `?n=` override, adaptive reduction.
- **Splat**: compute pass projects each particle, stochastic-DOF jitter inside its CoC, `atomicAdd`
  fixed-point RGB + count into a per-pixel `array<atomic<u32>>` buffer (cleared each frame).
- **Resolve**: log-density tonemap → HDR, blended with the previous frame (`trail`), bloom, AgX,
  optional HDR headroom, grain, vignette.
- **Resolution**: DPR capped at 2 × adaptive scale 0.5–1.0 (EMA of frame time with hysteresis).
- **Errors**: `device.onuncapturederror` → `console.error`. Device lost → friendly reload message.
- **Fallback**: no WebGPU → a CSS-only poster: "AXIOM needs WebGPU — Safari on iOS 26+, or Chrome."

### URL flags
`?seed=<u32>` `?v=<variant>` `?n=<particles>` `?debug` (fps/scale overlay) `?skipintro` (bypass
the start gate; no audio) `?capture` (deterministic: fixed dt, rAF loop paused, frames advance only
via `__axiom.step`).

### Test hooks (`window.__axiom`, always present)
```ts
interface AxiomHooks {
  ready: boolean;                                   // true after the first frame is presented
  setBead(u: number, v: number): void;              // teleport; cancels autopilot
  setCamera(c: { yaw?: number; pitch?: number; dive?: number }): void;
  step(frames?: number, dt?: number): Promise<void>; // advance + render, awaits GPU completion
  shake(): void;
  stir(x: number, y: number, strength: number): void; // x,y in NDC
  stats(): { fps: number; scale: number; particles: number; bead: [number, number];
             regime: number | null; dky: number | null; variant: string };
}
```
Sensor simulation uses real DOM events: `deviceorientation` (alpha/beta/gamma) and
`devicemotion` (`accelerationIncludingGravity`, `acceleration`) dispatched on `window`.

---

## 6. Variants (round 2+)
Variants are art directions of the **same** piece: same law, same navigation. They differ in
light, colour, finish and sound. `src/variants/<id>.ts` (+ `<id>.wgsl`) export a `Variant`:
```ts
interface Variant {
  id: string; name: string; tagline: string;
  shadeWgsl: string;   // fn shade(speed: f32, phase: f32, depth: f32, seed: f32) -> vec3f  (particle colour)
  gradeWgsl: string;   // fn grade(hdr: vec3f, uv: vec2f, time: f32) -> vec3f          (pre-tonemap finish)
  render: { exposure: number; trail: number; dof: number; bloom: number; grain: number;
            aberration: number; background: [number, number, number] };
  sound: { preset: number; rootHz: number };   // preset ids: 0 default · 1 ink · 2 prism · 3 abyss
  hud: { accent: string };                     // CSS colour for HUD/lens accents
}
```
Registry in `src/variants/index.ts`; selected via `?v=<id>` (default = first entry); the start
screen lists shipped variants as a quiet row of names.

**Round 3 additions** (engine implements; variants consume):
- Variants are **auto-discovered**: `index.ts` uses `import.meta.glob('./*.ts', { eager: true })`
  and registers every module that exports `variant: Variant`; sorted by `order` (origin = 0).
  A variant is exactly three files, `<id>.ts`, `<id>.shade.wgsl` and `<id>.grade.wgsl`, and it
  touches nothing else.
- `render.finish: 'agx' | 'direct'`. `'agx'` is the default: the engine adds the background and
  applies AgX. `'direct'` means `grade()` returns the **final display-linear colour including
  the background** (for example paper × exp(−k·hdr) for absorptive ink). The engine then applies
  only grain, dither and output encoding. `background` still themes the page and gate.
- `hud.theme: 'dark' | 'light'` switches HUD, gate and lens text/ink colours via CSS variables;
  `hud.accent` stays the accent colour.
- `createParamMap(gpu, core, seed, host, accent, theme)` receives the theme too.

**Round 4 additions** (engine implements, variants may use; all optional with neutral defaults):
- `render.clarity: number` (default 0): local contrast. The engine adds
  `clarity · (hdr − blurred(hdr))` from a bloom-pyramid level before `grade()`, so filaments in
  dense, volume-filling chaos stay legible.
- `render.bloomTint: [r, g, b]` (default `[1, 1, 1]`): a linear multiplier on the bloom term only.
- `axiom_headroom() -> f32` can be called inside `grade()`. It returns the display headroom
  (1.0 in SDR).
- The `shade()` contract documents `REFERENCE_SPEED` (the speed newcomers are shaded with) as a
  stable constant.
- URL flags: `?clean` hides all HUD and the lens, for hero captures. `?perf` shows a frame-time
  overlay (GPU timestamps where supported) for real-device testing.

**Round 5: selection and final contract.** After four rounds of critique, three art directions
ship: **Prism** (order 0, the default), **Ink** (1) and **Flame** (2). Origin and Abyss were cut.
They remain in git history (commit `4122ba8`, `src/variants/{origin,abyss}.*`), and Abyss's sound
preset 3 is removed from the crate. The engine also exposes two smoothed readings to both
`shade()` and `grade()`:
- `axiom_dky() -> f32`, the live Kaplan–Yorke dimension (0–3)
- `axiom_still() -> f32`, which is 1 when the regime is a fixed point and 0 otherwise

Variants can use these to gate regime-specific touches, for example a centre glint only on the
still point, or clarity only in volume-filling chaos.

---

## 8. Round-2 module interfaces
Implementers code against these signatures exactly; owners create a compiling skeleton first.

```ts
// src/wasm.ts — engine owner. One main-thread instance of axiom.wasm.
export interface SpectrumReading { l1: number; l2: number; l3: number; dky: number;
                                   regime: number; tracer: [number, number, number] }
export interface Core {
  readonly bytes: ArrayBuffer;        // raw module bytes (posted to the AudioWorklet)
  readonly anchorCount: number;
  lawParams(u: number, v: number, seed: number, out?: Float32Array): Float32Array; // 68 f32, copied
  spectrumStep(params: Float32Array, worldTime: number): void;
  spectrumRead(): SpectrumReading;
}
export function loadCore(seed: number): Promise<Core>;

// src/audio.ts — audio owner (worklet in src/audio-worklet.ts).
export const enum SynthParam { Master = 0, Stir = 1, Dive = 2, Shake = 3, Preset = 4,
                               RootHz = 5, Lambda1 = 6, Dky = 7 }
export interface AudioEngine {
  setLaw(params: Float32Array): void;          // call every frame; throttled internally to ≤ 30 Hz
  set(id: SynthParam, value: number): void;    // smoothed internally where it matters
  setMuted(muted: boolean): void;              // fades, never clicks
  readonly muted: boolean;
}
export function unlockAudio(): AudioContext;   // call SYNCHRONOUSLY inside the Begin tap (iOS)
export function startAudio(ctx: AudioContext, wasmBytes: ArrayBuffer, seed: number,
                           sound: { preset: number; rootHz: number }): Promise<AudioEngine>;

// src/map.ts — map owner (+ src/shaders/map.wgsl, src/map.css).
export interface ParamMap {
  frame(encoder: GPUCommandEncoder, bead: [number, number], time: number): void; // progressive compute + lens draw
  setOpen(open: boolean): void;                // animated lens ↔ full-screen transition
  readonly open: boolean;
  onPick: ((u: number, v: number) => void) | null;   // engine sets; fired while dragging on the open map
  onToggle: ((open: boolean) => void) | null;        // fired when the user taps the lens / closes the map
  dispose(): void;
}
export function createParamMap(gpu: Gpu, core: Core, seed: number, host: HTMLElement,
                               accent: string): ParamMap;
```
Parallel-work rule: while other agents edit `src/`, a Vite **dev** server hot-reloads under you.
Verify against a **production build** in your own outDir served by `vite preview`
(`npx vite build --outDir /tmp/<you>/dist && npx vite preview --outDir /tmp/<you>/dist --port <yours>`),
then `node scripts/shots.mjs --url http://localhost:<yours>/ …`.

---

## 7. Validation rubric (orchestrator gate, every round)
1. **Correctness** — cargo test/clippy/fmt, tsc, prettier, build green; no console or WebGPU
   validation errors; no black/NaN frames.
2. **Continuity** — small bead moves → small image change (no jumps).
3. **Regime coverage** — point, cycle, torus, strange, labyrinth all reachable.
4. **Aesthetics** — composition, light, colour, depth, type, restraint.
5. **Mobile** — 393×852 portrait, safe areas, legible HUD, touch works.
6. **Performance** — sized for a phone GPU; adaptive quality works.
7. **Code quality** — small modules, strict types, no dead code, no over-engineering.
