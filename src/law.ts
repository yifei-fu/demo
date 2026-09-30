/** Layout of the LawParams block (DESIGN §3.3). Rust computes every number; this only reads them. */

export const LAW_LEN = 68;
const HEADER = 4;
const SLOT = 32;

export interface LawSlot {
  /** Anchor kind id, or -1 for an empty slot. */
  kind: number;
  weight: number;
  tau: number;
  scale: number;
  /** Characteristic angular frequency in world time. */
  omega: number;
  p: Float32Array;
}

export interface LawView {
  r: number;
  theta: number;
  kappa: number;
  confine: number;
  slots: [LawSlot, LawSlot];
}

/** Decode a params block for display. */
export function readLaw(b: Float32Array): LawView {
  const slot = (i: number): LawSlot => {
    const o = HEADER + SLOT * i;
    return {
      kind: Math.round(b[o]),
      weight: b[o + 1],
      tau: b[o + 2],
      scale: b[o + 3],
      omega: b[o + 7],
      p: b.subarray(o + 8, o + 16),
    };
  };
  return { r: b[0], theta: b[1], kappa: b[2], confine: b[3], slots: [slot(0), slot(1)] };
}
