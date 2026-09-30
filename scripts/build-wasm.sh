#!/usr/bin/env bash
# Build crates/axiom-core to src/assets/axiom.wasm and verify the ABI.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate="$root/crates/axiom-core"
out_dir="$root/src/assets"
out="$out_dir/axiom.wasm"

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --release --target wasm32-unknown-unknown --manifest-path "$crate/Cargo.toml"

mkdir -p "$out_dir"
cp "$crate/target/wasm32-unknown-unknown/release/axiom_core.wasm" "$out"

bytes=$(wc -c <"$out" | tr -d ' ')
echo "axiom.wasm: $bytes bytes ($((bytes / 1024)) KiB) -> ${out#"$root"/}"

# The module must be instantiable with an empty import object and expose the
# whole ABI of docs/DESIGN.md section 4.
node -e '
const fs = require("fs");
const wanted = [
  "alloc", "dealloc", "law_params_len", "law_anchor_count", "law_params",
  "spectrum_new", "spectrum_step", "spectrum_read",
  "synth_new", "synth_set_law", "synth_set", "synth_render",
];
const mod = new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  console.error("FAIL: module has imports:", JSON.stringify(imports));
  process.exit(1);
}
const exported = WebAssembly.Module.exports(mod);
const names = new Set(exported.map((e) => e.name));
const missing = wanted.filter((n) => !names.has(n) || exported.find((e) => e.name === n).kind !== "function");
if (missing.length) {
  console.error("FAIL: missing exports:", missing.join(", "));
  process.exit(1);
}
if (!names.has("memory")) {
  console.error("FAIL: memory is not exported");
  process.exit(1);
}
console.log("ok: no imports; exports " + exported.map((e) => e.name).sort().join(" "));

// Smoke test: the numbers must agree with the documented layout.
const { exports: x } = new WebAssembly.Instance(mod, {});
if (x.law_params_len() !== 68) throw new Error("law_params_len != 68");
const p = x.alloc(68 * 4);
x.law_params(0.0, 0.0, 1, p);
const block = new Float32Array(x.memory.buffer, p, 68);
const w = block[5] + block[37];
if (Math.abs(w - 1) > 1e-6) throw new Error("weights do not sum to 1: " + w);
x.dealloc(p, 68 * 4);
console.log("ok: law_params smoke test, anchors = " + x.law_anchor_count());
' "$out"
