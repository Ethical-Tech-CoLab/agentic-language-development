/**
 * `generative-bitmap` protocol module (SPECIFICATION.md §9.2, ALD-031).
 *
 * §9.2 table row: "Monochrome 16x16 bit matrix", bounded at "256 bits", and
 * the §9.2 listing: `bits: Array<0 | 1>` of exactly `gridWidth * gridHeight`.
 * The artifact shape is the one `AgentActionProposalSchema` declares —
 * `{ bitmap: { bits } }` — and nothing else is admissible: §9.2 states that
 * "Bitmap and canvas carriers have no color or text field", so a `color`,
 * `alpha`, `label`, or `caption` key is rejected rather than dropped.
 *
 * The bit count is *exact*, not a maximum. A shorter matrix is
 * `bitmap-size-invalid` rather than `empty-message`, because a bitmap carries
 * one mark whatever its ink is: an all-zero 256-bit matrix is a legitimate
 * (and pre-registered, see `constantArtifact`) mark, while a 200-bit matrix is
 * not a bitmap at all. That is a deliberate departure from the mark-list
 * carriers, where length is what bounds the message, and is recorded as a
 * BACKLOG §15 decision.
 */
import type { CarrierModule } from '../carrier-modules.js';
import { fail } from '../carrier-modules.js';
import { BITMAP_BIT_COUNT, isBit } from './bounds.js';
import { assertNoStrings, readCarrierArtifact, readNestedField } from './marks.js';

/** The §9.6 `constant` default: an all-zero matrix (a blank mark). */
function zeroBits(): (0 | 1)[] {
  return new Array<0 | 1>(BITMAP_BIT_COUNT).fill(0);
}

export const generativeBitmapModule: CarrierModule = {
  carrier: 'generative-bitmap',
  allowedKinds: ['emit_bitmap'],

  validate(proposal) {
    const read = readCarrierArtifact(proposal, 'bitmap');
    if (!read.ok) {
      return read.failure;
    }

    // SPEC §9.2: this grammar is numeric only. A string anywhere inside it —
    // a semantic tag, a color name, a caption smuggled into a cell — is free
    // text, checked before the shape so the reason code names the actual
    // violation rather than the shape mismatch it also causes.
    const text = assertNoStrings(read.value, 'publicArtifact.bitmap');
    if (text !== undefined) {
      return text;
    }

    const nested = readNestedField(read.value, 'bits', 'publicArtifact.bitmap');
    if (!nested.ok) {
      return nested.failure;
    }

    const bits = nested.value;
    if (!Array.isArray(bits)) {
      return fail('invalid-envelope', 'publicArtifact.bitmap.bits is not an array');
    }
    if (bits.length !== BITMAP_BIT_COUNT) {
      return fail(
        'bitmap-size-invalid',
        `bitmap carries ${bits.length} cells; exactly ${BITMAP_BIT_COUNT} are required`,
      );
    }
    for (let index = 0; index < bits.length; index += 1) {
      if (!isBit(bits[index])) {
        return fail(
          'bitmap-value-invalid',
          `cell at index ${index} is not the literal 0 or 1`,
        );
      }
    }

    return { ok: true, artifact: { bitmap: { bits: [...(bits as (0 | 1)[])] } } };
  },

  /** Uniform independent bits: the §9.6 `random` control for this carrier. */
  randomArtifact(prng) {
    const bits = Array.from({ length: BITMAP_BIT_COUNT }, () =>
      prng.nextInt(2) === 1 ? 1 : (0 as 0 | 1),
    );
    return { bitmap: { bits } };
  },

  /**
   * SPEC §9.6 `constant` default: the all-zero 256-bit matrix. Chosen because
   * it is the unique matrix that carries no ink at all, so a `constant` run
   * cannot be confused with a run in which some form happened to recur.
   * Recorded as a BACKLOG §15 decision.
   */
  constantArtifact() {
    return { bitmap: { bits: zeroBits() } };
  },
};
