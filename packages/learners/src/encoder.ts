/**
 * From-scratch sensory encoders for the `hybrid` track (SPEC §6.1, §6.5, §6.7;
 * BACKLOG ALD-047).
 *
 * SPEC §6.1 defines `hybrid` as "from-scratch sensory encoder + trainable
 * recurrent world model + randomly initialized communication policy; frozen
 * non-text-aligned visual features only after passing §6.5". This module is
 * the first of those three components: it turns one row of the opaque numeric
 * observation (SPEC §10.1, §11.2) into a single discrete code that the world
 * model and the communication policy are indexed by.
 *
 * Two encodings are implemented, both seeded from the Baby's private seed and
 * both entirely free of any text tokenizer, vocabulary table, or pretrained
 * parameter (SPEC §6.5 item 1 therefore holds by construction, which is what
 * `describeProvenance()` reports and what the ALD-057 battery re-checks
 * independently):
 *
 * - `random-projection` (default): `codeBits` random hyperplanes through the
 *   input box. Bit `j` is the side of hyperplane `j` the input falls on, i.e.
 *   `sign(W[j] · (x - C[j]))`, with `W[j]` a random direction and `C[j]` a
 *   random center inside the declared input box. Nearby inputs tend to share
 *   bits, so the code carries some of the metric structure of the observation
 *   — the property a from-scratch encoder is supposed to supply and that the
 *   tabular `scratch-rl` type-code backbone does not have.
 * - `seeded-hash`: a domain-separated hash of the row, reduced modulo
 *   `codeCount`. Tuning-free and balanced in expectation, but it destroys all
 *   metric structure: two observations differing in one attribute get
 *   unrelated codes.
 *
 * Neither encoding is trained. That is deliberate: the `hybrid` track's
 * trainable parts are the world model and the communication policy, and
 * keeping the encoder frozen-after-random-initialization is what makes its
 * hash a stable component record in the exported policy (ALD-047 cb 1).
 *
 * Optional frozen visual features (SPEC §6.1, §6.5 item 3) enter through
 * `FrozenFeatureExtractor`, an injected interface: when one is supplied the
 * encoder projects `extractor.project(row)` instead of the raw row, so a
 * declared frozen component is genuinely in the sensory-to-policy path rather
 * than a cosmetic provenance entry. No real vision encoder ships here — this
 * repository has no model weights and no GPU — so the tests inject a
 * deterministic test double and the adapter records exactly what the double
 * declares about itself. `textAligned` is treated as a claim the ALD-057
 * battery must check, never as proof.
 *
 * Component hashes use `HASH_DOMAINS.policyCheckpoint` over an object whose
 * `component` field names the component, so an encoder hash's pre-image can
 * never collide with a whole exported policy's. A dedicated `learnerComponent`
 * hash domain would be tidier; adding one is a `@ald/types` change and is
 * recorded in this task's integrator notes.
 */
import { HASH_DOMAINS, type Sha256Hash } from '@ald/types';
import { SeededPrng, domainHash, hashCanonical } from '@ald/hashing';
import { z } from 'zod';

import { LearnerConfigurationError, LearnerStateError } from './errors.js';
import { roundAll, roundTo } from './game.js';
import { POLICY_DECIMALS } from './policy.js';

/** Encodings this module implements. */
export const SENSORY_ENCODER_MODES = [
  'random-projection',
  'seeded-hash',
] as const;

export type SensoryEncoderMode = (typeof SENSORY_ENCODER_MODES)[number];

/**
 * Upper bound on `codeBits`. The communication policy allocates dense tables
 * of `codeCount x symbolCount` numbers per message position and the exported
 * policy canonicalizes them, so the code space is deliberately kept small
 * enough to hash, diff and read (12 bits = 4 096 codes).
 */
export const MAX_CODE_BITS = 12;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * What a frozen feature bank declares about itself. Every field is recorded
 * verbatim in `describeProvenance()` and in the exported policy: SPEC §6.5
 * item 3 makes `textAligned` the field that reclassifies a run.
 */
export const FrozenFeatureDescriptorSchema = z
  .object({
    name: z.string().min(1),
    /** Hash of the frozen parameters, `sha256:<64 hex>`. */
    hash: z.string().regex(SHA256_PATTERN),
    /** SPEC §6.5 item 3: a text-aligned encoder weakens the run's claim. */
    textAligned: z.boolean(),
    /** Length of the vector `project()` returns. */
    dimension: z.number().int().positive(),
    /** Upper bound of the box `project()`'s components live in. */
    outputScale: z.number().positive(),
  })
  .strict();

export type FrozenFeatureDescriptor = z.infer<
  typeof FrozenFeatureDescriptorSchema
>;

/**
 * A frozen, non-trainable feature bank in front of the encoder. The adapter
 * never inspects `project`; it validates the shape of what comes back and
 * records the descriptor.
 */
export interface FrozenFeatureExtractor extends FrozenFeatureDescriptor {
  project(row: readonly number[]): number[];
}

export interface SensoryEncoderOptions {
  /** The Baby's private seed (`LearnerInitContext.seed`); never exported. */
  seed: string;
  /** Width of one raw observation row. */
  rowDimension: number;
  /**
   * Upper bound of the box the raw attribute codes live in, i.e.
   * `valuesPerAttribute`. Ignored when a frozen extractor supplies its own
   * `outputScale`.
   */
  inputScale?: number;
  /** Bits per code; `codeCount = 2 ** codeBits`. Default `5`. */
  codeBits?: number;
  mode?: SensoryEncoderMode;
  frozenFeatures?: FrozenFeatureExtractor;
}

export const EXPORTED_SENSORY_ENCODER_VERSION = 1 as const;

export const ExportedSensoryEncoderSchema = z
  .object({
    version: z.literal(EXPORTED_SENSORY_ENCODER_VERSION),
    component: z.literal('sensory-encoder'),
    mode: z.enum(SENSORY_ENCODER_MODES),
    codeBits: z.number().int().min(1).max(MAX_CODE_BITS),
    codeCount: z.number().int().positive(),
    /** Width of one raw observation row. */
    rowDimension: z.number().int().positive(),
    /** Width of the vector actually projected (the frozen dimension if any). */
    inputDimension: z.number().int().positive(),
    inputScale: z.number().positive(),
    /** `[bit][inputDimension]` hyperplane normals; empty in `seeded-hash`. */
    weights: z.array(z.array(z.number())),
    /** `[bit][inputDimension]` hyperplane centers; empty in `seeded-hash`. */
    centers: z.array(z.array(z.number())),
    /**
     * Domain-separated hash of the private seed. `seeded-hash` keys its row
     * hash on this value rather than on the seed itself, so an exported
     * encoder reproduces exactly without carrying private material.
     */
    seedHash: z.string().regex(SHA256_PATTERN),
    frozenFeatures: FrozenFeatureDescriptorSchema.optional(),
  })
  .strict();

export type ExportedSensoryEncoder = z.infer<
  typeof ExportedSensoryEncoderSchema
>;

/** Restore an encoder from a recorded component instead of a seed. */
export interface SensoryEncoderRestore {
  restore: ExportedSensoryEncoder;
  frozenFeatures?: FrozenFeatureExtractor;
}

function isRestore(
  value: SensoryEncoderOptions | SensoryEncoderRestore,
): value is SensoryEncoderRestore {
  return 'restore' in value;
}

/**
 * Seeded, non-trainable encoder from one opaque numeric observation row to one
 * discrete code.
 */
export class SeededSensoryEncoder {
  readonly mode: SensoryEncoderMode;
  readonly codeBits: number;
  readonly codeCount: number;
  readonly rowDimension: number;
  readonly inputDimension: number;
  readonly inputScale: number;

  private readonly weights: number[][];
  private readonly centers: number[][];
  private readonly seedHash: string;
  private readonly frozen: FrozenFeatureExtractor | undefined;

  constructor(options: SensoryEncoderOptions | SensoryEncoderRestore) {
    if (isRestore(options)) {
      const recorded = options.restore;
      this.mode = recorded.mode;
      this.codeBits = recorded.codeBits;
      this.codeCount = recorded.codeCount;
      this.rowDimension = recorded.rowDimension;
      this.inputDimension = recorded.inputDimension;
      this.inputScale = recorded.inputScale;
      this.weights = recorded.weights.map((normal) => [...normal]);
      this.centers = recorded.centers.map((center) => [...center]);
      this.seedHash = recorded.seedHash;
      this.frozen = options.frozenFeatures;
      return;
    }

    this.mode = options.mode ?? 'random-projection';
    this.codeBits = options.codeBits ?? 5;
    this.rowDimension = options.rowDimension;
    this.frozen = options.frozenFeatures;
    this.inputDimension = this.frozen?.dimension ?? options.rowDimension;
    this.inputScale = this.frozen?.outputScale ?? options.inputScale ?? 4;

    if (
      !Number.isInteger(this.codeBits) ||
      this.codeBits < 1 ||
      this.codeBits > MAX_CODE_BITS
    ) {
      throw new LearnerConfigurationError(
        `codeBits must be an integer within [1, ${String(MAX_CODE_BITS)}]`,
      );
    }
    if (!Number.isInteger(this.rowDimension) || this.rowDimension < 1) {
      throw new LearnerConfigurationError(
        'rowDimension must be a positive integer',
      );
    }
    if (!(this.inputScale > 0)) {
      throw new LearnerConfigurationError('inputScale must be positive');
    }
    if (this.frozen !== undefined) {
      FrozenFeatureDescriptorSchema.parse(descriptorOf(this.frozen));
    }

    this.codeCount = 2 ** this.codeBits;
    this.seedHash = domainHash(HASH_DOMAINS.seed, options.seed);

    if (this.mode === 'seeded-hash') {
      this.weights = [];
      this.centers = [];
      return;
    }

    // One random hyperplane per bit: a random direction through a random
    // point of the input box. Rounded on construction so the exported
    // component hash does not depend on an IEEE-754 tail.
    const prng = new SeededPrng(options.seed).derive('hybrid/encoder');
    this.weights = Array.from({ length: this.codeBits }, () =>
      roundAll(
        Array.from(
          { length: this.inputDimension },
          () => prng.nextFloat() * 2 - 1,
        ),
        POLICY_DECIMALS,
      ),
    );
    this.centers = Array.from({ length: this.codeBits }, () =>
      roundAll(
        Array.from(
          { length: this.inputDimension },
          () => prng.nextFloat() * this.inputScale,
        ),
        POLICY_DECIMALS,
      ),
    );
  }

  /** The frozen feature bank in the sensory path, if any (SPEC §6.5 item 3). */
  get frozenFeatures(): FrozenFeatureDescriptor | undefined {
    return this.frozen === undefined ? undefined : descriptorOf(this.frozen);
  }

  /** Encode one observation row into a code in `[0, codeCount)`. */
  encode(row: readonly number[]): number {
    const raw = requireVector(row, this.rowDimension, 'observation row');
    const input =
      this.frozen === undefined
        ? raw
        : requireVector(
            this.frozen.project(raw),
            this.inputDimension,
            'frozen feature vector',
          );

    if (this.mode === 'seeded-hash') {
      const digest = hashCanonical(HASH_DOMAINS.observation, {
        seedHash: this.seedHash,
        input: [...input],
      });
      // 32 digest bits is far more entropy than `codeCount` needs, and the
      // modulo is exactly unbiased because `codeCount` is a power of two.
      const prefix = digest.slice('sha256:'.length, 'sha256:'.length + 8);
      return Number.parseInt(prefix, 16) % this.codeCount;
    }

    let code = 0;
    for (let bit = 0; bit < this.codeBits; bit += 1) {
      const normal = requireRow(this.weights, bit);
      const center = requireRow(this.centers, bit);
      let side = 0;
      for (let index = 0; index < this.inputDimension; index += 1) {
        side += at(normal, index) * (at(input, index) - at(center, index));
      }
      code = code * 2 + (side >= 0 ? 1 : 0);
    }
    return code;
  }

  export(): ExportedSensoryEncoder {
    const frozen = this.frozenFeatures;
    return {
      version: EXPORTED_SENSORY_ENCODER_VERSION,
      component: 'sensory-encoder',
      mode: this.mode,
      codeBits: this.codeBits,
      codeCount: this.codeCount,
      rowDimension: this.rowDimension,
      inputDimension: this.inputDimension,
      inputScale: roundTo(this.inputScale, POLICY_DECIMALS),
      weights: this.weights.map((normal) => [...normal]),
      centers: this.centers.map((center) => [...center]),
      seedHash: this.seedHash,
      ...(frozen === undefined ? {} : { frozenFeatures: frozen }),
    };
  }

  /** Component hash recorded in `LearnerProvenance.components` (ALD-047 cb 1). */
  hash(): Sha256Hash {
    return hashCanonical(HASH_DOMAINS.policyCheckpoint, this.export());
  }

  /**
   * Rebuild an encoder from an exported component, for a derived run (SPEC
   * §7.4) or a §7.3 recovery. The live frozen extractor must be re-injected:
   * its `project` implementation is code, not state, and the checkpoint
   * carries only the descriptor it declared. A mismatch between the injected
   * descriptor and the recorded one is refused rather than reconciled, because
   * the recorded descriptor is what the run's claim classification was
   * computed from.
   */
  static load(
    value: unknown,
    frozenFeatures?: FrozenFeatureExtractor,
  ): SeededSensoryEncoder {
    const recorded = ExportedSensoryEncoderSchema.parse(value);
    const declared = recorded.frozenFeatures;
    if ((declared === undefined) !== (frozenFeatures === undefined)) {
      throw new LearnerConfigurationError(
        declared === undefined
          ? 'the checkpoint records no frozen feature bank but one was injected'
          : 'the checkpoint records a frozen feature bank but none was injected',
      );
    }
    if (declared !== undefined && frozenFeatures !== undefined) {
      for (const [field, left, right] of [
        ['name', declared.name, frozenFeatures.name],
        ['hash', declared.hash, frozenFeatures.hash],
        ['textAligned', declared.textAligned, frozenFeatures.textAligned],
        ['dimension', declared.dimension, frozenFeatures.dimension],
        ['outputScale', declared.outputScale, frozenFeatures.outputScale],
      ] as const) {
        if (left !== right) {
          throw new LearnerConfigurationError(
            `frozen feature ${field} ${String(left)} != ${String(right)}`,
          );
        }
      }
    }

    return new SeededSensoryEncoder({
      restore: recorded,
      ...(frozenFeatures === undefined ? {} : { frozenFeatures }),
    });
  }
}

function descriptorOf(
  extractor: FrozenFeatureExtractor,
): FrozenFeatureDescriptor {
  return {
    name: extractor.name,
    hash: extractor.hash,
    textAligned: extractor.textAligned,
    dimension: extractor.dimension,
    outputScale: extractor.outputScale,
  };
}

function requireVector(
  values: readonly number[],
  length: number,
  what: string,
): readonly number[] {
  if (!Array.isArray(values) || values.length !== length) {
    throw new LearnerStateError(
      `A ${what} must hold exactly ${String(length)} numbers`,
    );
  }
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LearnerStateError(`A ${what} must hold finite numbers only`);
    }
  }
  return values;
}

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new LearnerStateError(`Index ${String(index)} is outside the vector`);
  }
  return value;
}

function requireRow(matrix: readonly number[][], index: number): number[] {
  const row = matrix[index];
  if (row === undefined) {
    throw new LearnerStateError(`Row ${String(index)} is outside the matrix`);
  }
  return row;
}
