import type { Variant } from './types';
import gradeWgsl from './prism.grade.wgsl?raw';
import shadeWgsl from './prism.shade.wgsl?raw';

/** Thin-film iridescence on a cool black: light split by glass, pastel spectra that shift along filaments. */
export const variant: Variant = {
  id: 'prism',
  order: 0,
  name: 'Prism',
  tagline: 'light, split by glass',
  shadeWgsl,
  gradeWgsl,
  render: {
    exposure: 6.5,
    trail: 0.8,
    dof: 1.9,
    bloom: 4.5,
    grain: 0.008,
    clarity: 0.4,
    aberration: 0.011,
    finish: 'agx',
    background: [0.0157, 0.0196, 0.0392],
  },
  sound: { preset: 2, rootHz: 73.4 },
  hud: { accent: '#9fe8ff', theme: 'dark' },
};
