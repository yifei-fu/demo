import type { Variant } from './types';
import gradeWgsl from './origin.grade.wgsl?raw';
import shadeWgsl from './origin.shade.wgsl?raw';

/** The reference variant: a single spectral light on ink, restrained and luminous. */
export const variant: Variant = {
  id: 'origin',
  order: 0,
  name: 'origin',
  tagline: 'one light',
  shadeWgsl,
  gradeWgsl,
  render: {
    exposure: 5,
    trail: 0.85,
    dof: 1,
    bloom: 12,
    grain: 0.011,
    aberration: 0.0045,
    finish: 'agx',
    background: [0.0196, 0.0235, 0.0392],
  },
  sound: { preset: 0, rootHz: 110 },
  hud: { accent: '#9db8ff', theme: 'dark' },
};
