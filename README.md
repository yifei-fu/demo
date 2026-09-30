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

## Variants

The same law, navigation and gestures in different art directions. They differ in light, colour,
finish and sound. Pick one on the start screen, or with the `?v=<id>` switch, for example
`https://yifei-fu.github.io/demo/?v=flame`.

- `origin` (default): one light
- `flame`: the heat of chaos
- `ink`: one breath of ink
- `prism`: light, split by glass
- `abyss`: lit from within

To add one, create `src/variants/<id>.ts` exporting `variant` (see `src/variants/types.ts`); the
registry finds it by file. Then add a line to this list.

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
  main.ts          boot: WebGPU + core, start gate, frame loop, adaptive quality, test hooks
  engine.ts        the simulation-and-render pipeline, one `advance` per frame
  gpu.ts           device, canvas, HDR configuration
  particles.ts     one fused compute pass: integrate, respawn, splat
  post.ts          resolve, trails, dual-Kawase bloom, composite
  shaders/*.wgsl   law, particles, post, map
  sensors.ts       tilt, motion, touch, keys → one smoothed input (input.ts, pointers.ts)
  navigator.ts     bead physics, autopilot, camera rig
  wasm.ts, law.ts  the Rust core and its LawParams layout
  map.ts, map-dom.ts   Lyapunov / D_KY parameter map and the lens
  audio.ts, audio-worklet.ts, sound.ts   the attractor as sound
  hud.ts, readout.ts, style.css   start gate, readout, fallback poster
  variants/        one file (+ two WGSL functions) per art direction
crates/axiom-core/ the law, Lyapunov spectrum and synth (Rust, cdylib → axiom.wasm)
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
npm run shots -- --mode variants --v origin,flame    # matrix: variants × 7 spots on the disk
npm run shots -- --mode hero --v origin              # 430×932 @2x stills and a triptych (slow)
# options: --desktop  --v <ids>  --n  --seed  --frames  --out  --port
#          --query "k=v&k=v" (extra URL params, e.g. mapn=32)  --url <already-running server>
```

URL flags for manual testing: `?seed=` `?v=` `?n=` `?debug` `?skipintro` `?capture` (plus `?mapn=`
and `?mapsteps=` for the parameter map's resolution and speed).

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
