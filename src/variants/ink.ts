import type { Variant } from './types';
import gradeWgsl from './ink.grade.wgsl?raw';
import shadeWgsl from './ink.shade.wgsl?raw';

/** Sumi ink on warm washi: the one light variant. Filaments absorb; the only colour is the seal. */
export const variant: Variant = {
  id: 'ink',
  order: 2,
  name: 'Ink',
  tagline: 'one breath of ink',
  shadeWgsl,
  gradeWgsl,
  render: {
    exposure: 9.5,
    trail: 0.9,
    dof: 2,
    bloom: 8,
    grain: 0.003,
    aberration: 0,
    finish: 'direct',
    // #efe9df, sRGB: the page, the gate and the canvas edge are all the same paper
    background: [0.937, 0.914, 0.875],
  },
  sound: { preset: 1, rootHz: 65.4 },
  hud: { accent: '#c8372d', theme: 'light' },
};
