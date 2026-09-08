/**
 * Per-carrier mark inventories (SPECIFICATION.md §9.1, §9.2; ALD-031).
 *
 * Only the two *symbolic* carriers have an inventory at all: `fixed-token`
 * declares `S01`-`S<n>` (§9.1) and `fixed-glyph` declares `G01`-`G<n>`
 * rendered from the frozen unfamiliar-glyph bundle (§9.2). The three
 * generative carriers have no inventory by construction — their grammar
 * bounds what can be drawn or sounded, and every artifact a Baby produces is
 * a new mark identified only by its `markHash` (§9.2 "so that a repeated form
 * can be recognized without assigning it a meaning").
 *
 * The glyph *identifiers* carry no semantics: `G07` is an opaque index into a
 * seeded bundle of 16x16 bitmaps, and the bundle itself is generated from
 * random bounded strokes rather than from any font or Unicode code point
 * (`glyph-bundle.ts`).
 */
import { fixedTokenInventory, type RunConfig } from '@ald/types';

import { DEFAULT_SYMBOL_INVENTORY_SIZE } from './bounds.js';

/** Shape of a glyph identifier: `G` plus a zero-padded ordinal. */
export const GLYPH_ID_PATTERN = /^G[0-9]{2,3}$/u;

/**
 * Default `fixed-glyph` inventory `G01`..`G<size>`, padded exactly as
 * `fixedTokenInventory` pads `S01`..`S<size>` so the two symbolic carriers
 * stay index-comparable at the same inventory size.
 */
export function glyphInventory(size: number): string[] {
  if (!Number.isInteger(size) || size < 2 || size > 256) {
    throw new Error('symbolInventorySize must be an integer between 2 and 256');
  }
  const width = size >= 100 ? 3 : 2;
  return Array.from(
    { length: size },
    (_, index) => `G${String(index + 1).padStart(width, '0')}`,
  );
}

/**
 * Whether a carrier declares a mark inventory at all. The generative carriers
 * do not: SPEC §9.2 gives them a grammar, not a vocabulary.
 */
export function isSymbolicCarrier(
  carrier: RunConfig['carrierMode'],
): carrier is 'fixed-token' | 'fixed-glyph' {
  return carrier === 'fixed-token' || carrier === 'fixed-glyph';
}

/**
 * The declared inventory for a run's carrier, or an empty list for a
 * generative carrier.
 *
 * The Nursery Controller currently builds `GatewayRunContext.symbolInventory`
 * with `fixedTokenInventory` unconditionally; this is the carrier-aware form
 * it should use instead (see this package's README and the integrator notes),
 * and it is what the `fixed-glyph` module validates against so a run is
 * correct either way.
 */
export function carrierInventory(
  config: Pick<RunConfig, 'carrierMode' | 'symbolInventorySize'>,
): string[] {
  const size = config.symbolInventorySize ?? DEFAULT_SYMBOL_INVENTORY_SIZE;
  switch (config.carrierMode) {
    case 'fixed-token':
      return fixedTokenInventory(size);
    case 'fixed-glyph':
      return glyphInventory(size);
    case 'generative-bitmap':
    case 'generative-canvas':
    case 'generative-tone':
      return [];
  }
}
