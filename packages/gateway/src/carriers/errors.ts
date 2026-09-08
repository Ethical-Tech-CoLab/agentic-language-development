/**
 * Configuration faults specific to the SPECIFICATION.md §9.2 alternate
 * carriers (ALD-031).
 *
 * None of these is a Baby channel violation: a Baby cannot cause one, and
 * none is ever committed as `channel.rejected`. They are raised while a run
 * context is being built, so a misconfigured run cannot start (SPEC §9.2:
 * "The unfamiliar glyph bundle MUST be generated and frozen before
 * pre-registration").
 */
import type { RunConfig } from '@ald/types';

import { GatewayError } from '../errors.js';

/**
 * SPEC §9.2: a `fixed-glyph` run must name the frozen glyph bundle it renders
 * its inventory from. Without `RunConfig.glyphBundleHash` there is nothing to
 * bind the Baby-visible glyph images to, and the §9.2 requirement that the
 * bundle be frozen before pre-registration cannot be checked at all — so the
 * Gateway refuses to be constructed rather than running a glyph condition
 * whose stimuli are unpinned.
 */
export class MissingGlyphBundleHashError extends GatewayError {
  constructor() {
    super(
      'INVALID_REQUEST',
      'A fixed-glyph run requires RunConfig.glyphBundleHash: the unfamiliar-glyph bundle must be generated and frozen before pre-registration (SPEC §9.2)',
      { carrier: 'fixed-glyph', field: 'glyphBundleHash' },
    );
  }
}

/**
 * The glyph bundle handed to `verifyGlyphBundle` does not hash to the value
 * the run configuration pins. Raised by the verification helper, never during
 * a turn.
 */
export class GlyphBundleMismatchError extends GatewayError {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(
      'INVALID_REQUEST',
      'The glyph bundle does not match the pinned glyphBundleHash (SPEC §9.2)',
      { expectedHash, actualHash },
    );
  }
}

/**
 * A glyph bundle could not be generated whose every glyph passes the leakage
 * audit within the attempt budget. Generation is deterministic, so this is a
 * parameter fault (too few strokes, too small a grid), not a flake.
 */
export class GlyphBundleAuditFailedError extends GatewayError {
  constructor(
    readonly glyphIndex: number,
    readonly attempts: number,
    readonly reasonCodes: readonly string[],
  ) {
    super(
      'INVALID_REQUEST',
      `Glyph ${glyphIndex} still fails the §9.2 glyph leakage audit after ${attempts} seeded attempts`,
      { glyphIndex, attempts, reasonCodes: [...reasonCodes] },
    );
  }
}

/**
 * The run's carrier is one this build does not have a grammar for. Distinct
 * from `UnsupportedCarrierError`, which reports an unregistered *module*.
 */
export class UnknownCarrierGrammarError extends GatewayError {
  constructor(readonly carrier: RunConfig['carrierMode']) {
    super('INVALID_REQUEST', `No §9.2 grammar is defined for carrier ${carrier}`, {
      carrier,
    });
  }
}
