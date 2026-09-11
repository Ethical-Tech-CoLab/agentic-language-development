import type { RunConfig } from '@ald/types';

import { AnalysisError } from './errors.js';

const BITMAP_FORMS = 2n ** 256n;
const CANVAS_STROKE_FORMS = 16n ** 4n * 3n;
const TONE_FORMS = 8n * 4n;

export interface CarrierCapacityInput {
  carrier: RunConfig['carrierMode'];
  formCount: number;
  marksPerMessage: number;
  maxStrokes?: number;
}

export interface CarrierCapacity {
  carrier: RunConfig['carrierMode'];
  /** Exact count of artifacts admitted by the declared physical grammar. */
  physicalGrammarForms: string;
  /** log2 of `physicalGrammarForms`, rounded to 12 decimal places. */
  physicalGrammarBits: number;
  /** Fixed learner action-bank capacity; it does not expand after acquisition. */
  effectiveFormCount: number;
  /** Maximum information in one bank-index message under a uniform code. */
  effectiveMessageBits: number;
  marksPerMessage: number;
}

function sumPowers(base: bigint, maximumExponent: number): bigint {
  let total = 0n;
  let term = 1n;
  for (let exponent = 1; exponent <= maximumExponent; exponent += 1) {
    term *= base;
    total += term;
  }
  return total;
}

/** Stable log2 for positive BigInts, including the 64-stroke canvas grammar. */
function log2BigInt(value: bigint): number {
  const bits = value.toString(2);
  const precision = Math.min(53, bits.length);
  const leading = Number.parseInt(bits.slice(0, precision), 2);
  return bits.length - precision + Math.log2(leading);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

/**
 * Capacity accounting for E13.
 *
 * `physicalGrammarBits` describes everything the Gateway grammar could carry;
 * `effectiveMessageBits` describes only the learner's fixed action bank. The
 * two are intentionally separate: acquiring or modifying a form replaces a
 * slot and cannot silently increase model capacity.
 */
export function carrierCapacity(input: CarrierCapacityInput): CarrierCapacity {
  if (!Number.isInteger(input.formCount) || input.formCount < 2) {
    throw new AnalysisError('domain', 'formCount must be an integer of at least 2');
  }
  if (!Number.isInteger(input.marksPerMessage) || input.marksPerMessage < 1) {
    throw new AnalysisError(
      'domain',
      'marksPerMessage must be a positive integer',
    );
  }

  let physicalGrammarForms: bigint;
  let effectiveMarks = input.marksPerMessage;
  switch (input.carrier) {
    case 'fixed-token':
    case 'fixed-glyph':
      physicalGrammarForms = BigInt(input.formCount) **
        BigInt(input.marksPerMessage);
      break;
    case 'generative-bitmap':
      physicalGrammarForms = BITMAP_FORMS;
      effectiveMarks = 1;
      break;
    case 'generative-canvas': {
      const maximum = input.maxStrokes ?? 8;
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64) {
        throw new AnalysisError(
          'domain',
          'maxStrokes must be an integer within [1, 64]',
        );
      }
      physicalGrammarForms = sumPowers(CANVAS_STROKE_FORMS, maximum);
      effectiveMarks = 1;
      break;
    }
    case 'generative-tone':
      physicalGrammarForms = sumPowers(TONE_FORMS, 8);
      effectiveMarks = 1;
      break;
  }

  return {
    carrier: input.carrier,
    physicalGrammarForms: physicalGrammarForms.toString(),
    physicalGrammarBits: rounded(log2BigInt(physicalGrammarForms)),
    effectiveFormCount: input.formCount,
    effectiveMessageBits: rounded(
      effectiveMarks * Math.log2(input.formCount),
    ),
    marksPerMessage: effectiveMarks,
  };
}
