import type { Variant } from './types';
import gradeWgsl from './flame.grade.wgsl?raw';
import shadeWgsl from './flame.shade.wgsl?raw';

/** The heat of chaos: slow light smoulders in oxblood, speed ignites it to white-gold. */
export const variant: Variant = {
  id: 'flame',
  order: 1,
  name: 'flame',
  tagline: 'the heat of chaos',
  shadeWgsl,
  gradeWgsl,
  render: {
    exposure: 7.5,
    trail: 0.88,
    dof: 1,
    bloom: 7.5,
    bloomTint: [1.0, 0.62, 0.34], // the halo of white-gold light burns orange-red, like film halation
    clarity: 0.6,
    grain: 0.012,
    aberration: 0.003,
    finish: 'direct',
    background: [0.0275, 0.0157, 0.0196], // #070405; grade() adds the same black itself (direct finish)
  },
  sound: { preset: 0, rootHz: 55 },
  hud: { accent: '#ffb45a', theme: 'dark' },
};
