/** What the lens needs from Rust and from CSS, kept apart from the GPU and DOM code. */
import { LAW_LEN } from './law';
import type { Core } from './wasm';

/** Any CSS colour to sRGB 0..1, by letting a 2D canvas parse it. */
export function cssRgb(css: string): [number, number, number] {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return [0.62, 0.72, 1];
  ctx.fillStyle = '#9db8ff';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const p = ctx.getImageData(0, 0, 1, 1).data;
  return [p[0] / 255, p[1] / 255, p[2] / 255];
}

/** Rust's law block for every cell of the grid (and a rim of cells beyond the circle). */
export function lawGrid(core: Core, seed: number, n: number, rim: number): Float32Array {
  const laws = new Float32Array(n * n * LAW_LEN);
  const lim = (1 + rim) * (1 + rim);
  for (let j = 0; j < n; j++) {
    const v = 1 - ((j + 0.5) / n) * 2;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * 2 - 1;
      if (u * u + v * v > lim) continue;
      const o = (j * n + i) * LAW_LEN;
      core.lawParams(u, v, seed, laws.subarray(o, o + LAW_LEN));
    }
  }
  return laws;
}

/**
 * Where the law's anchors sit on the rim, as angles in the disk's own convention (u right, v up):
 * the centre of each run of rim points that are one pure anchor. Rust owns the placement, so it
 * is read back from the law blocks instead of being derived here.
 */
export function anchorAngles(core: Core, seed: number): number[] {
  const samples = 720;
  const block = new Float32Array(LAW_LEN);
  const pure = Array.from({ length: samples }, (_, i) => {
    const a = (i / samples) * 2 * Math.PI;
    core.lawParams(Math.cos(a), Math.sin(a), seed, block);
    return block[5] > 0.999 ? block[4] : block[37] > 0.999 ? block[36] : -1;
  });
  const angles: number[] = [];
  for (let i = 0; i < samples; i++) {
    if (pure[i] < 0 || pure[i] === pure[(i - 1 + samples) % samples]) continue;
    let len = 1;
    while (len < samples && pure[(i + len) % samples] === pure[i]) len++;
    angles.push(((i + (len - 1) / 2) / samples) * 2 * Math.PI);
  }
  return angles.slice(0, 8);
}
