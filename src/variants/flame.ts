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
    exposure: 6.2,
    trail: 0.88,
    dof: 1,
    bloom: 7.5,
    grain: 0.012,
    aberration: 0.003,
    finish: 'agx',
    background: [0.0275, 0.0118, 0.0176],
  },
  sound: { preset: 0, rootHz: 55 },
  hud: { accent: '#ffb45a', theme: 'dark' },
};
