/**
 * Carrier-qualified content addressing (SPECIFICATION.md §9.2, ALD-031
 * criterion 1).
 *
 * §9.2, verbatim: "A produced alternate-carrier artifact is content-addressed:
 * `markHash = SHA-256("dtsf-carrier-mark-v1" || 0x00 || carrierMode || 0x00 ||
 * canonicalArtifact)` (RFC 8785 canonicalization ...) so that a repeated form
 * can be recognized without assigning it a meaning."
 *
 * `hashCarrierMark` in `@ald/hashing` is that construction, and the Evidence
 * Writer already uses it for `ChannelEvent.publicArtifactHash` — so a
 * delivered artifact's `markHash` *is* its channel-event artifact hash, with
 * no second hashing scheme to keep in step. This module exists to make that
 * identity explicit and to give the learner adapters and the ALD-032 leakage
 * evaluator one named entry point:
 *
 * - the same artifact under the same carrier always yields the same hash, in
 *   any process, because RFC 8785 canonicalization fixes key order and number
 *   formatting;
 * - the same artifact under a *different* carrier yields a different hash,
 *   because `carrierMode` is inside the preimage — a bitmap and a canvas
 *   drawing that happened to canonicalize identically could never be
 *   confused for the same form.
 *
 * Normalization is the carrier module's job, not this function's: `validate`
 * returns the artifact with exactly the declared fields and the submitted
 * order preserved, and that normalized value is what gets hashed. Hashing an
 * unvalidated artifact would content-address a payload the Gateway never
 * accepted, so `carrierMarkHash` is documented for use on validated
 * artifacts only.
 */
import { hashCarrierMark } from '@ald/hashing';
import type { RunConfig } from '@ald/types';

import type { PublicArtifact } from '../carrier-modules.js';

/**
 * The §9.2 `markHash` of one **validated** artifact under `carrier`.
 *
 * Identical to `ChannelEvent.publicArtifactHash` for the same delivery, and
 * identical to `hashCarrierMark(carrier, artifact)` — the wrapper exists so
 * call sites read as "content-address this mark" rather than "hash this
 * object", and so a future change to the construction has one place to land.
 */
export function carrierMarkHash(
  carrier: RunConfig['carrierMode'],
  artifact: PublicArtifact,
): string {
  return hashCarrierMark(carrier, artifact);
}
