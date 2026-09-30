# AXIOM

_One law, every world between stillness and chaos._

[![CI](https://github.com/yifei-fu/demo/actions/workflows/ci.yml/badge.svg)](https://github.com/yifei-fu/demo/actions/workflows/ci.yml)

**Live: <https://yifei-fu.github.io/demo/>** (best on a phone)

A single 3D dynamical system `ẋ = F(x; μ)` lives in your hand. About a million particles flow
through it continuously. The parameter `μ` lives on a unit disk, and you roll a bead across that
disk by tilting the phone. Every point of the disk is a different law of motion, and neighbouring
laws blend continuously. What you see is the attractor, and its dimension is what you navigate:

- **centre**: every law has a stable fixed point, so the cloud collapses to one point (D = 0). The
  piece opens here: the axiom.
- **outward**: a Hopf bifurcation gives a loop (D = 1), then a torus (D = 2), then strange
  attractors (D ≈ 2 to 2.3), and at the rim near-volume-filling labyrinth chaos (D → 3).
- **around the circle**: the character of the law changes. Thomas, Aizawa, Lorenz, Rössler and
  Halvorsen anchors sit on the rim and are blended as a homotopy of vector fields.

There is no timeline. Changing the law makes the cloud flow into the new attractor, so the
transitions are the dynamics. You also hear the attractor: the same law is integrated at audio
rate and tuned to just-intonation harmonics. After about 20 s without input an idle autopilot
drifts the bead, and any touch takes over instantly.

## Controls

| Gesture                      | Phone                             | Desktop             |
| ---------------------------- | --------------------------------- | ------------------- |
| Move through the parameter   | tilt (relative to the Begin pose) | `WASD` / arrow keys |
| Orbit the attractor          | turn your body (yaw)              | drag                |
| Dive into the cloud          | hold                              | mouse wheel         |
| Stir                         | drag                              | (none)              |
| Scatter every particle       | shake                             | `Space`             |
| Parameter map, drag the bead | pinch, or tap the lens            | `M`                 |

## Browser support

AXIOM needs WebGPU: Safari on iOS / iPadOS 26+, Chrome or Edge on desktop and Android. Without
WebGPU it shows a static poster instead. On displays that support it, the canvas uses an HDR
(`rgba16float`, extended tone mapping) surface.

## Tech

- **WebGPU compute**: RK2 particle integration and **atomic splatting** into a fixed-point
  RGB + count buffer, resolved with **fractal-flame log-density** tone mapping
- **Stochastic depth of field** (each particle deposits inside its circle of confusion),
  dual-Kawase bloom, AgX tone mapping, **HDR canvas**, film grain
- **Rust → wasm** (zero dependencies, SIMD) computes the law's parameters, the **Lyapunov
  spectrum** (Benettin's method) and the **Kaplan–Yorke dimension**, and runs the synthesiser
  inside an **AudioWorklet**
- TypeScript (strict), Vite, no runtime dependencies

## Architecture

```
index.html  vite.config.ts  package.json
src/
  main.ts          boot, WebGPU check, start gate, frame loop, adaptive quality, test hooks
  gpu.ts           device, canvas, HDR configuration
  sensors.ts       tilt, touch, keyboard → one smoothed input
  navigator.ts     bead physics, autopilot, camera rig
  law.ts           bridge to the wasm law
  particles.ts     integrate + splat pipelines
  shaders/*.wgsl   law, particles, splat, post
  post.ts          trails, bloom, tone mapping, grain
  map.ts           Lyapunov / D_KY parameter map
  audio.ts, audio-worklet.ts
  hud.ts, style.css  start gate, fallback poster, lens, readout
crates/axiom-core/ the law, spectrum and synth (Rust, cdylib → axiom.wasm)
scripts/           build-wasm.sh, shots.mjs (visual QA)
docs/DESIGN.md     the design contract
```

## Development

```sh
npm ci            # install
npm run wasm      # build src/assets/axiom.wasm (needed once, and after Rust changes)
npm run dev       # dev server on :5171
npm run build     # wasm + typecheck + production build into dist/
npm test          # cargo test for the Rust crate
npm run shots     # visual QA, see below
```

Requires Node 22 and a Rust toolchain with the `wasm32-unknown-unknown` target.

### Visual QA

`npm run shots` starts Vite on port 5172, drives the app headlessly through `window.__axiom`
(WebGPU via SwiftShader) and writes screenshots and contact sheets to `shots/<timestamp>/`. It
exits non-zero on any console error, page error, failed request or failed check.

```sh
npm run shots -- --mode grid --n 32768 --frames 60   # 3×3 bead positions × 2 cameras
npm run shots -- --mode sweep                        # continuity: Δ between neighbouring frames
npm run shots -- --mode sensors                      # deviceorientation, devicemotion, touch
npm run shots -- --mode gate                         # start gate and no-WebGPU fallback
# options: --desktop  --v <ids>  --seed  --out  --url <already-running server>
```

URL flags for manual testing: `?seed=` `?v=` `?n=` `?debug` `?skipintro` `?capture`.

## Deploy

CI (`.github/workflows/ci.yml`) runs `cargo fmt`, `clippy`, `cargo test`, Prettier and the
production build on every push and pull request, and fails if the gzipped bundle exceeds 150 KB.
On the default branch it publishes `dist/` to GitHub Pages.

One-time setup: **Settings → Pages → Source: GitHub Actions**. Deploys run from the default
branch only.

## References

- E. N. Lorenz, "Deterministic nonperiodic flow", _J. Atmos. Sci._ 20, 1963.
- O. E. Rössler, "An equation for continuous chaos", _Phys. Lett. A_ 57, 1976.
- R. Thomas, "Deterministic chaos seen in terms of feedback circuits: analysis, synthesis,
  'labyrinth chaos'", _Int. J. Bifurcation Chaos_ 9, 1999.
- W. F. Langford, "Numerical studies of torus bifurcations", 1984. The system usually called the
  Aizawa attractor is a variant of it.
- Halvorsen's cyclically symmetric attractor, as catalogued by J. C. Sprott.
- G. Benettin, L. Galgani, A. Giorgilli, J.-M. Strelcyn, "Lyapunov characteristic exponents for
  smooth dynamical systems…", _Meccanica_ 15, 1980.
- J. L. Kaplan and J. A. Yorke, "Chaotic behavior of multidimensional difference equations", 1979.
- S. Draves and E. Reckase, "The Fractal Flame Algorithm", 2003.
