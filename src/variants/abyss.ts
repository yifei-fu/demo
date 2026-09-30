import type { Variant } from './types';
import gradeWgsl from './abyss.grade.wgsl?raw';
import shadeWgsl from './abyss.shade.wgsl?raw';

/** Bioluminescence in the deep: plankton light on a blue-black sea, a lone organism at the centre. */
export const variant: Variant = {
  id: 'abyss',
  order: 4,
  name: 'abyss',
  tagline: 'lit from within',
  shadeWgsl,
  gradeWgsl,
  render: {
    exposure: 10,
    trail: 0.9,
    dof: 1.2,
    bloom: 17,
    grain: 0.013,
    aberration: 0.005,
    finish: 'agx',
    background: [0.0039, 0.0196, 0.0353],
  },
  sound: { preset: 3, rootHz: 41.2 },
  hud: { accent: '#4fe3c1', theme: 'dark' },
};
