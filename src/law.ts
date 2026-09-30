/**
 * JS side of the law. Round 1 ships a tiny TS stub with the exact 68-float layout of DESIGN §3.3;
 * round 2 replaces the body of `lawParams` with the wasm export `law_params`.
 */

export const LAW_LEN = 68;
const SLOT = 32;

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

type Vec3 = [number, number, number];

/** Rotation taking unit vector `from` to unit vector `to`, as three column vectors. */
function rotationBetween(from: Vec3, to: Vec3): [Vec3, Vec3, Vec3] {
  const [x, y, z] = [
    from[1] * to[2] - from[2] * to[1],
    from[2] * to[0] - from[0] * to[2],
    from[0] * to[1] - from[1] * to[0],
  ];
  const c = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  const k = 1 / (1 + c);
  // Rodrigues in the form R = c I + [v]x + k v v^T
  return [
    [c + k * x * x, z + k * x * y, -y + k * x * z],
    [-z + k * x * y, c + k * y * y, x + k * y * z],
    [y + k * x * z, -x + k * y * z, c + k * z * z],
  ];
}

// Thomas' slow axis is (1,1,1). Turn it toward the default camera so the point at r = 0 is seen
// end-on and stays round; the world stays a rotated copy of the system.
const CAMERA_AXIS: Vec3 = [Math.sin(0.16), Math.sin(0.2), Math.cos(0.2)];
const R_STUB = rotationBetween(CAMERA_AXIS.map((v) => v / Math.hypot(...CAMERA_AXIS)) as Vec3, [
  1 / Math.sqrt(3),
  1 / Math.sqrt(3),
  1 / Math.sqrt(3),
]);

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
  // kappa: extra damping only around the centre, so r = 0 collapses to a true point rather
  // than onto Thomas' slow diagonal; it is gone by r = 0.3
  out[2] = 0.6 * Math.max(0, 1 - r / 0.3) ** 2;
  out[3] = 1.5; // confine radius

  // slot 0: Thomas on its radial route, b: 1.2 (stable fixed point) -> 0.16 (labyrinth)
  const b = mix(1.2, 0.16, r);
  const s0 = 4;
  out[s0] = 0; // kind
  out[s0 + 1] = 1; // weight
  out[s0 + 2] = 3.5; // tau
  out[s0 + 3] = 4.5; // L
  out[s0 + 7] = 0.866 * 3.5; // omega: Im of the origin eigenvalue times tau
  out[s0 + 8] = b;
  for (let col = 0; col < 3; col++) out.set(R_STUB[col], s0 + 16 + col * 4);

  // slot 1: empty
  out[4 + SLOT] = -1;
  return out;
}
