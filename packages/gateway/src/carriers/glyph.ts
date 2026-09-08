/**
 * `fixed-glyph` protocol module (SPECIFICATION.md §9.2, ALD-031).
 *
 * §9.2 table row: "IDs `G01`-`G32` rendered from a pre-generated
 * unfamiliar-glyph set", bounded at "32 glyphs, 4 per message". A proposal is
 * `{ "glyphs": string[] }` and the discipline is the fixed-token discipline
 * of §9.1 — allowlist, length cap, consecutive-repeat cap — over a different
 * inventory, so `marks.ts` runs the identical ordered checks and only the
 * allowlist reason code differs (`glyph-not-in-inventory`).
 *
 * The glyph *images* never travel on this channel: a delivered artifact
 * carries inventory identifiers, and the identifiers are rendered from the
 * frozen bundle by the presentation layer that builds a Baby's observation.
 * That is why this module requires `RunConfig.glyphBundleHash` — a glyph
 * condition whose stimuli are not pinned cannot support any claim about what
 * the Babies actually saw (§9.2 "generated and frozen before
 * pre-registration").
 */
import type { RunConfig } from '@ald/types';

import type { CarrierContext, CarrierModule } from '../carrier-modules.js';
import { MissingGlyphBundleHashError } from './errors.js';
import { glyphInventory } from './inventory.js';
import { randomMarkList, readCarrierArtifact, validateMarkList } from './marks.js';
import { DEFAULT_SYMBOL_INVENTORY_SIZE } from './bounds.js';

/**
 * SPEC §9.2: a `fixed-glyph` run must pin its frozen bundle. Raised while the
 * Gateway is being constructed — `SymbolGatewayImpl`'s constructor resolves
 * the §9.6 constant artifact, which reaches this check — so a run configured
 * without `glyphBundleHash` can never take a turn.
 */
export function assertGlyphRunConfig(
  config: Pick<RunConfig, 'carrierMode' | 'glyphBundleHash'>,
): void {
  if (config.carrierMode === 'fixed-glyph' && config.glyphBundleHash === undefined) {
    throw new MissingGlyphBundleHashError();
  }
}

/**
 * The glyph inventory this run declares.
 *
 * Derived from `symbolInventorySize` rather than read from
 * `GatewayRunContext.symbolInventory`, because the Nursery Controller
 * currently fills that field with `fixedTokenInventory` for every carrier.
 * Deriving it keeps a glyph run correct today and identical once the runtime
 * switches to `carrierInventory` (see `inventory.ts`).
 */
export function glyphInventoryFor(context: CarrierContext): string[] {
  return glyphInventory(
    context.runContext.config.symbolInventorySize ?? DEFAULT_SYMBOL_INVENTORY_SIZE,
  );
}

export const fixedGlyphModule: CarrierModule = {
  carrier: 'fixed-glyph',
  allowedKinds: ['emit_glyphs'],

  validate(proposal, context) {
    // Unreachable at turn time: the Gateway constructor already ran this
    // check through `constantArtifact`/`validate`, so a run whose config
    // lacks the bundle hash never reaches a submission. Kept so the module is
    // safe to call directly (conformance vectors, control artifacts).
    assertGlyphRunConfig(context.runContext.config);

    const read = readCarrierArtifact(proposal, 'glyphs');
    if (!read.ok) {
      return read.failure;
    }

    const marks = validateMarkList(read.value, context, {
      notInInventory: 'glyph-not-in-inventory',
      inventory: glyphInventoryFor(context),
      noun: 'glyphs',
    });
    if (!marks.ok) {
      return marks.failure;
    }

    return { ok: true, artifact: { glyphs: marks.marks } };
  },

  randomArtifact(prng, context) {
    assertGlyphRunConfig(context.runContext.config);
    return {
      glyphs: randomMarkList(prng, context, glyphInventoryFor(context)),
    };
  },

  /**
   * SPEC §9.6 `constant` default: the first glyph of the declared inventory,
   * mirroring the fixed-token module's "first inventory symbol". Recorded as a
   * BACKLOG §15 decision.
   */
  constantArtifact(context) {
    assertGlyphRunConfig(context.runContext.config);
    const inventory = glyphInventoryFor(context);
    const first = inventory[0];
    if (first === undefined) {
      // `glyphInventory` refuses a size below 2, so this is unreachable.
      throw new Error('the fixed-glyph inventory is empty');
    }
    return { glyphs: [first] };
  },
};
