/**
 * `generative-tone` protocol module (SPECIFICATION.md §9.2, ALD-031).
 *
 * §9.2 table row: "Sequence of quantized `(pitchBin, durationBin)` pairs",
 * bounded at "8 tones", and §9.2's prose: "Tone carriers use eight pitch bins
 * and four duration bins; raw audio upload is prohibited." The prohibition is
 * structural rather than a filter: the only admissible artifact is the
 * `{ tones: { tones: [...] } }` shape `AgentActionProposalSchema` declares, so
 * there is no field a sample buffer, data URL, or file reference could ride
 * in — any such key is rejected by the extra-field check before its contents
 * are looked at.
 */
import type { CarrierModule } from '../carrier-modules.js';
import { extraFieldFailure, fail } from '../carrier-modules.js';
import {
  MAX_TONES,
  TONE_DURATION_BINS,
  TONE_PITCH_BINS,
  isDurationBin,
  isPitchBin,
} from './bounds.js';
import { assertNoStrings, readCarrierArtifact, readNestedField } from './marks.js';
import { isPlainObject } from '../inspect.js';

const TONE_FIELDS = ['pitchBin', 'durationBin'] as const;

interface NormalizedTone {
  pitchBin: number;
  durationBin: number;
}

export const generativeToneModule: CarrierModule = {
  carrier: 'generative-tone',
  allowedKinds: ['emit_tones'],

  validate(proposal) {
    const read = readCarrierArtifact(proposal, 'tones');
    if (!read.ok) {
      return read.failure;
    }

    // SPEC §9.2: quantized numeric pairs only, and "raw audio upload is
    // prohibited" — a data URL, file name, or note name is free text.
    const text = assertNoStrings(read.value, 'publicArtifact.tones');
    if (text !== undefined) {
      return text;
    }

    const nested = readNestedField(read.value, 'tones', 'publicArtifact.tones');
    if (!nested.ok) {
      return nested.failure;
    }

    const tones = nested.value;
    if (!Array.isArray(tones)) {
      return fail(
        'invalid-envelope',
        'publicArtifact.tones.tones is not an array',
      );
    }
    if (tones.length === 0) {
      // SPEC §9.1: a carrier message must contain at least one mark.
      return fail('empty-message', 'publicArtifact.tones.tones is empty');
    }
    if (tones.length > MAX_TONES) {
      return fail(
        'too-many-tones',
        `message carries ${tones.length} tones; the cap is ${MAX_TONES}`,
      );
    }

    const normalized: NormalizedTone[] = [];
    for (let index = 0; index < tones.length; index += 1) {
      const tone: unknown = tones[index];
      if (!isPlainObject(tone)) {
        return fail('invalid-envelope', `tone at index ${index} is not an object`);
      }
      const extraKeys = Object.keys(tone).filter(
        (key) => !(TONE_FIELDS as readonly string[]).includes(key),
      );
      if (extraKeys.length > 0) {
        return extraFieldFailure(tone, extraKeys, `tones[${index}]`);
      }
      if (!isPitchBin(tone.pitchBin)) {
        return fail(
          'tone-out-of-range',
          `tones[${index}].pitchBin is outside the ${TONE_PITCH_BINS} pitch bins`,
        );
      }
      if (!isDurationBin(tone.durationBin)) {
        return fail(
          'tone-out-of-range',
          `tones[${index}].durationBin is outside the ${TONE_DURATION_BINS} duration bins`,
        );
      }
      normalized.push({
        pitchBin: tone.pitchBin,
        durationBin: tone.durationBin,
      });
    }

    return { ok: true, artifact: { tones: { tones: normalized } } };
  },

  /** Uniform sequence length first, then uniform bins per tone. */
  randomArtifact(prng) {
    const count = 1 + prng.nextInt(MAX_TONES);
    const tones = Array.from({ length: count }, () => ({
      pitchBin: prng.nextInt(TONE_PITCH_BINS),
      durationBin: 1 + prng.nextInt(TONE_DURATION_BINS),
    }));
    return { tones: { tones } };
  },

  /**
   * SPEC §9.6 `constant` default: one tone at the lowest pitch bin and the
   * shortest duration bin — the minimal admissible sequence, mirroring the
   * canvas carrier's single dot. Recorded as a BACKLOG §15 decision.
   */
  constantArtifact() {
    return { tones: { tones: [{ pitchBin: 0, durationBin: 1 }] } };
  },
};
