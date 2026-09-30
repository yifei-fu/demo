/**
 * Registry of shipped variants, discovered by file: every `src/variants/<id>.ts` that exports
 * `variant: Variant` is registered, ordered by `variant.order` (the lowest is the default).
 * Adding a variant needs no edit here.
 */
import type { Variant } from './types';

const modules = import.meta.glob<{ variant?: Variant }>(['./*.ts', '!./index.ts', '!./types.ts'], {
  eager: true,
});

export const VARIANTS: readonly Variant[] = Object.values(modules)
  .flatMap((m) => (m.variant ? [m.variant] : []))
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

export function pickVariant(id: string | null): Variant {
  return VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];
}
