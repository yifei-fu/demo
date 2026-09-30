/** Registry of shipped variants. The first entry is the default; `?v=<id>` selects another. */
import { origin } from './origin';
import type { Variant } from './types';

export const VARIANTS: readonly Variant[] = [origin];

export function pickVariant(id: string | null): Variant {
  return VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];
}
