/**
 * JS side of the law. Round 1 ships a tiny TS stub with the exact 68-float layout of DESIGN §3.3;
 * round 2 replaces the body of `lawParams` with the wasm export `law_params`.
 */

export const LAW_LEN = 68;
const SLOT = 32;

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Fill `out` with the LawParams block for the bead at (u, v) in the unit disk. */
export function lawParams(
  u: number,
  v: number,
  _seed: number,
  out: Float32Array = new Float32Array(LAW_LEN),
): Float32Array {
  const r = Math.min(1, Math.hypot(u, v));
  out.fill(0);
  out[0] = r;
  out[1] = Math.atan2(v, u);
  out[2] = 0; // kappa
  out[3] = 1.5; // confine radius

  // slot 0: Thomas on its radial route, b: 1.2 (stable fixed point) -> 0.16 (labyrinth)
  const b = mix(1.2, 0.16, r);
  const s0 = 4;
  out[s0] = 0; // kind
  out[s0 + 1] = 1; // weight
  out[s0 + 2] = 2; // tau
  out[s0 + 3] = 4.5; // L
  out[s0 + 7] = 0.866 * 2; // omega: Im of the origin eigenvalue times tau
  out[s0 + 8] = b;
  out[s0 + 16] = 1; // R = identity, three vec4 columns
  out[s0 + 21] = 1;
  out[s0 + 26] = 1;

  // slot 1: empty
  out[4 + SLOT] = -1;
  return out;
}
