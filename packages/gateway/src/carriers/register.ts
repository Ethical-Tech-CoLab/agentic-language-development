/**
 * Opting a build into the SPECIFICATION.md §9.2 alternate carriers
 * (ALD-031 criterion 3).
 *
 * §9.2 opens with the constraint this module encodes: "Alternate carriers are
 * **explicit experiment conditions, never the default**." So the four modules
 * are not registered when this package is imported. A process that runs a
 * `fixed-glyph`, `generative-bitmap`, `generative-canvas`, or
 * `generative-tone` condition calls {@link registerAlternateCarriers} once
 * during bootstrap; a process that does not is left with the §9.1 fixed-token
 * default and refuses an alternate-carrier run outright
 * (`UnsupportedCarrierError`), which is the safer failure.
 *
 * Registration is deliberately all-or-nothing across modules *and* their
 * ALD-036 conformance vectors: ALD-031 criterion 3 requires every registered
 * carrier to contribute accept/reject vectors, so registering a module without
 * its vectors would make `assertEveryCarrierHasVectors(registeredCarriers())`
 * fail — and that assertion is the EPIC-06 gate. Doing both in one call means
 * the gate cannot be tripped by a half-registration.
 */
import type { RunConfig } from '@ald/types';

import {
  registerCarrierModule,
  type CarrierModule,
} from '../carrier-modules.js';
import {
  ALTERNATE_CARRIER_VECTORS,
  registerConformanceVectors,
} from '../conformance-vectors.js';
import { generativeBitmapModule } from './bitmap.js';
import { generativeCanvasModule } from './canvas.js';
import { fixedGlyphModule } from './glyph.js';
import { generativeToneModule } from './tone.js';

/** The four §9.2 modules, in `CarrierModeSchema` order. */
export const ALTERNATE_CARRIER_MODULES: readonly CarrierModule[] = [
  fixedGlyphModule,
  generativeBitmapModule,
  generativeCanvasModule,
  generativeToneModule,
];

/** Every §9.2 carrier an alternate module exists for. */
export const ALTERNATE_CARRIERS: readonly RunConfig['carrierMode'][] =
  ALTERNATE_CARRIER_MODULES.map((module) => module.carrier);

/**
 * Register the four §9.2 modules and their ALD-036 vectors. Idempotent:
 * `registerCarrierModule` and `registerConformanceVectors` both replace any
 * previous registration for the same carrier, so calling this twice — or
 * calling it after `resetCarrierModules()` in a test — leaves the same state.
 */
export function registerAlternateCarriers(): void {
  for (const module of ALTERNATE_CARRIER_MODULES) {
    registerCarrierModule(module);
    const vectors = ALTERNATE_CARRIER_VECTORS.get(module.carrier);
    if (vectors === undefined) {
      // Unreachable: `ALTERNATE_CARRIER_VECTORS` is keyed by the same four
      // carriers. Kept explicit so a future fifth module cannot be registered
      // without vectors and quietly break the EPIC-06 gate.
      throw new Error(
        `No ALD-036 conformance vectors are defined for carrier ${module.carrier}`,
      );
    }
    registerConformanceVectors(module.carrier, vectors);
  }
}
