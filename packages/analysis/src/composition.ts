/**
 * E15 composition and held-out generalization readout
 * (EXPERIMENT-NOTEBOOK.md E15; SPECIFICATION.md §15.2, §15.3; BACKLOG
 * ALD-072, ALD-074 acceptance criterion 3).
 *
 * E15's procedure names exactly what this module computes, and nothing more:
 *
 * - "Hold out pre-registered combinations from training" — {@link
 *   checkHeldOutSplitIntegrity} is the mechanical check that no held-out type
 *   code appears in a training episode (E15 result checkbox "Held-out split
 *   integrity verified"). A violation is reported, never repaired.
 * - "Compare task success, topographic measures, and behavioral composition" —
 *   seen versus held-out success with intervals and Cohen's h, a Mantel-style
 *   topographic similarity with a seeded permutation null, symbol-reuse
 *   counts, and order sensitivity from the E16 reorder probes.
 * - "Run the confirmatory 32-symbol/4-token and 128-symbol/8-token conditions
 *   … Use at least 75 independent seeds per condition … Treat any additional
 *   bandwidth or model-capacity levels as exploratory" — the bandwidth
 *   contrast carries an `inferenceClass` of `confirmatory` only when both
 *   conditions reach the pre-registered seed floor, and `exploratory`
 *   otherwise, with a reason code.
 * - "Avoid declaring compositionality from one metric" — every metric is a
 *   separate field and none of them is combined into a verdict. This module
 *   returns numbers; the E15 checkboxes are the researcher's to tick
 *   (ALD-072 acceptance criterion 3).
 *
 * All randomness comes from `SeededPrng`, so a readout replays exactly from
 * its recorded seed (SPEC §14.3).
 */
import { SeededPrng } from '@ald/hashing';

import {
  bootstrapPairedDifferenceCi,
  type BootstrapCi,
} from './bootstrap.js';
import {
  proportion,
  wilsonInterval,
  type ProportionSummary,
  type WilsonInterval,
} from './descriptive.js';
import { cohensH } from './effects.js';
import {
  AnalysisError,
  assertCount,
  assertLevel,
} from './errors.js';
import { welchTTest, type WelchTTestResult } from './hierarchical.js';

/** Analysis version stamped on the E15 readout. */
export const COMPOSITION_ANALYSIS_VERSION = 'composition/v1';

/**
 * E15: "Use at least 75 independent seeds per condition"; anything below that
 * is exploratory by pre-registration, not by judgement.
 */
export const E15_CONFIRMATORY_MINIMUM_SEEDS = 75;

/** Episodes are subsampled to this many before the O(n^2) Mantel test. */
export const TOPOGRAPHIC_MAX_EPISODES = 100;

const DEFAULT_PERMUTATIONS = 1_000;

/**
 * One evaluation episode as the analysis sees it. `attributes` and `typeCode`
 * are researcher-only ground truth (SPEC §9.6, §10.1) and never reach a Baby;
 * `message` is the delivered form sequence — token ids for `fixed-token`,
 * `markHash` values for a generative carrier — so this module is
 * carrier-agnostic.
 */
export interface CompositionEpisode {
  readonly split: 'train' | 'held-out';
  readonly typeCode: number;
  readonly attributes: readonly number[];
  readonly message: readonly string[];
  readonly success: boolean;
  /** Seed of the run the episode came from; required for the seed-level views. */
  readonly seed?: string;
}

export interface SeedProportionInput {
  readonly seed: string;
  readonly successes: number;
  readonly n: number;
}

export interface BandwidthConditionInput {
  /** Pre-registered label, e.g. `32-symbols-4-tokens`. */
  readonly label: string;
  readonly symbolInventorySize: number;
  readonly maxSymbolsPerMessage: number;
  /** Per-seed held-out success, one entry per valid seed. */
  readonly perSeedHeldOutSuccess: readonly SeedProportionInput[];
}

export interface OrderProbeOutcome {
  /** Success on the unprobed delivery of the same episode. */
  readonly baselineSuccess: boolean;
  /** Success when the same message was delivered with its marks reordered. */
  readonly reorderedSuccess: boolean;
}

export interface CompositionInput {
  readonly episodes: readonly CompositionEpisode[];
  /** `RunConfig.interventionPlan.heldOutTypeCodes` (SPEC §18, E15). */
  readonly heldOutTypeCodes?: readonly number[];
  /** Seed for the permutation null and the paired bootstrap. */
  readonly seed: string;
  readonly permutations?: number;
  readonly confidence?: number;
  readonly alpha?: number;
  readonly orderProbes?: readonly OrderProbeOutcome[];
  readonly bandwidthConditions?: readonly BandwidthConditionInput[];
  readonly minimumSeedsForConfirmatory?: number;
}

export type SplitIntegrityViolationCode =
  | 'held-out-type-code-in-training'
  | 'held-out-type-code-absent-from-evaluation'
  | 'unknown-split-label';

export interface SplitIntegrityResult {
  readonly heldOutTypeCodes: readonly number[];
  readonly trainingTypeCodes: readonly number[];
  readonly evaluatedTypeCodes: readonly number[];
  readonly violations: readonly {
    readonly code: SplitIntegrityViolationCode;
    readonly typeCode: number;
    readonly episodes: number;
  }[];
  readonly intact: boolean;
}

export interface ProportionWithInterval {
  readonly summary: ProportionSummary;
  readonly wilson: WilsonInterval;
}

export interface TopographicResult {
  /** Spearman rank correlation between attribute and message distances. */
  readonly spearman: number;
  readonly pairs: number;
  readonly episodesUsed: number;
  readonly episodesAvailable: number;
  readonly permutations: number;
  /** Share of permuted correlations at or above the observed one. */
  readonly permutationP: number;
  /** Central `confidence` interval of the permuted (null) correlations. */
  readonly nullInterval: { readonly lower: number; readonly upper: number };
  readonly seed: string;
  readonly degenerate: boolean;
}

export interface SymbolReuseResult {
  readonly episodes: number;
  readonly distinctForms: number;
  readonly distinctMessages: number;
  readonly meanMessageLength: number;
  /** Distinct messages per distinct referent type code. */
  readonly messagesPerTypeCode: number;
  /** `1 - distinctMessages / episodes`: how often a message repeats at all. */
  readonly messageRepeatRate: number;
  /** Mean uses per distinct form; 1.0 means every form was used once. */
  readonly formUsesPerDistinctForm: number;
  /** Forms that occur in more than one distinct message (shared parts). */
  readonly formsSharedAcrossMessages: number;
}

export interface OrderSensitivityResult {
  readonly probes: number;
  readonly baseline: ProportionWithInterval;
  readonly reordered: ProportionWithInterval;
  readonly difference: number;
  readonly cohensH: number;
}

export type BandwidthInferenceClass = 'confirmatory' | 'exploratory';

export interface BandwidthContrastResult {
  readonly conditions: readonly {
    readonly label: string;
    readonly symbolInventorySize: number;
    readonly maxSymbolsPerMessage: number;
    readonly seeds: number;
    readonly seedMean: number;
    readonly pooledDescriptive: ProportionSummary;
  }[];
  readonly seedLevelTest: WelchTTestResult;
  /** §15.3 mandatory effect size on the pooled proportions. */
  readonly cohensH: number;
  readonly alpha: number;
  readonly minimumSeedsForConfirmatory: number;
  readonly inferenceClass: BandwidthInferenceClass;
  readonly exploratoryReasonCodes: readonly (
    | 'below-seed-minimum'
    | 'more-than-two-conditions'
    | 'single-condition'
  )[];
}

export interface CompositionResult {
  readonly analysisVersion: string;
  readonly splitIntegrity: SplitIntegrityResult;
  readonly seen: ProportionWithInterval;
  readonly heldOut: ProportionWithInterval;
  readonly seenMinusHeldOut: number;
  readonly cohensHSeenVersusHeldOut: number;
  /** Paired seed-level bootstrap of seen minus held-out; `null` without seeds. */
  readonly seedLevelDifference: BootstrapCi | null;
  readonly topographic: TopographicResult;
  readonly symbolReuse: SymbolReuseResult;
  readonly orderSensitivity: OrderSensitivityResult | null;
  readonly bandwidthContrast: BandwidthContrastResult | null;
  readonly confidence: number;
  readonly alpha: number;
  readonly seed: string;
}

function assertEpisodes(episodes: readonly CompositionEpisode[]): void {
  if (episodes.length === 0) {
    throw new AnalysisError('empty-sample', 'episodes must not be empty');
  }
  episodes.forEach((episode, index) => {
    if (episode.split !== 'train' && episode.split !== 'held-out') {
      throw new AnalysisError(
        'domain',
        `episodes[${index}].split must be "train" or "held-out"`,
      );
    }
    assertCount(episode.typeCode, `episodes[${index}].typeCode`);
    if (episode.attributes.length === 0) {
      throw new AnalysisError(
        'domain',
        `episodes[${index}].attributes must not be empty`,
      );
    }
  });
}

/**
 * E15 "Held-out split integrity verified": every pre-registered held-out type
 * code must be absent from every training episode and present in at least one
 * evaluation episode. Both directions are reported as violation codes; the
 * analysis never rewrites the split.
 */
export function checkHeldOutSplitIntegrity(input: {
  readonly episodes: readonly CompositionEpisode[];
  readonly heldOutTypeCodes?: readonly number[];
}): SplitIntegrityResult {
  assertEpisodes(input.episodes);
  const heldOutTypeCodes = [...(input.heldOutTypeCodes ?? [])].sort(
    (left, right) => left - right,
  );
  const trainingCounts = new Map<number, number>();
  const evaluatedCounts = new Map<number, number>();
  for (const episode of input.episodes) {
    const target = episode.split === 'train' ? trainingCounts : evaluatedCounts;
    target.set(episode.typeCode, (target.get(episode.typeCode) ?? 0) + 1);
  }
  const violations: SplitIntegrityResult['violations'] = heldOutTypeCodes
    .flatMap((typeCode) => {
      const inTraining = trainingCounts.get(typeCode) ?? 0;
      const inEvaluation = evaluatedCounts.get(typeCode) ?? 0;
      const found: SplitIntegrityResult['violations'][number][] = [];
      if (inTraining > 0) {
        found.push({
          code: 'held-out-type-code-in-training',
          typeCode,
          episodes: inTraining,
        });
      }
      if (inEvaluation === 0) {
        found.push({
          code: 'held-out-type-code-absent-from-evaluation',
          typeCode,
          episodes: 0,
        });
      }
      return found;
    });
  return {
    heldOutTypeCodes,
    trainingTypeCodes: [...trainingCounts.keys()].sort(
      (left, right) => left - right,
    ),
    evaluatedTypeCodes: [...evaluatedCounts.keys()].sort(
      (left, right) => left - right,
    ),
    violations,
    intact: violations.length === 0,
  };
}

/** Hamming distance over two equal-length attribute vectors. */
export function attributeHammingDistance(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length) {
    throw new AnalysisError(
      'length-mismatch',
      'attribute vectors must have equal length',
    );
  }
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
}

/** Levenshtein distance over two form sequences (insert/delete/substitute). */
export function messageEditDistance(
  left: readonly string[],
  right: readonly string[],
): number {
  const rows = left.length;
  const columns = right.length;
  let previous = Array.from({ length: columns + 1 }, (_unused, index) => index);
  for (let row = 1; row <= rows; row += 1) {
    const current = new Array<number>(columns + 1);
    current[0] = row;
    for (let column = 1; column <= columns; column += 1) {
      const substitution =
        (previous[column - 1] as number) +
        (left[row - 1] === right[column - 1] ? 0 : 1);
      const deletion = (previous[column] as number) + 1;
      const insertion = (current[column - 1] as number) + 1;
      current[column] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[columns] as number;
}

/** Average (mid) ranks of `values`, ties sharing their mean rank. */
function midRanks(values: readonly number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) =>
      left.value === right.value
        ? left.index - right.index
        : left.value - right.value,
    );
  const ranks = new Array<number>(values.length).fill(0);
  let position = 0;
  while (position < order.length) {
    let end = position + 1;
    while (
      end < order.length &&
      (order[end] as { value: number }).value ===
        (order[position] as { value: number }).value
    ) {
      end += 1;
    }
    const rank = (position + end - 1) / 2 + 1;
    for (let index = position; index < end; index += 1) {
      ranks[(order[index] as { index: number }).index] = rank;
    }
    position = end;
  }
  return ranks;
}

/** Pearson correlation; `NaN` when either input has zero variance. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let index = 0; index < n; index += 1) {
    sumA += a[index] as number;
    sumB += b[index] as number;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < n; index += 1) {
    const deltaA = (a[index] as number) - meanA;
    const deltaB = (b[index] as number) - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }
  if (varianceA === 0 || varianceB === 0) {
    return NaN;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * Spearman rank correlation between two equal-length samples, with ties
 * handled by mid-ranks (Pearson on the ranks).
 */
export function spearmanCorrelation(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new AnalysisError('length-mismatch', 'samples must have equal length');
  }
  if (a.length < 2) {
    return NaN;
  }
  return pearson(midRanks(a), midRanks(b));
}

/**
 * Topographic similarity: the Spearman correlation between pairwise
 * attribute distance and pairwise message edit distance, with a Mantel
 * permutation null (episode labels of the message side are permuted, which
 * preserves both distance distributions and destroys only their pairing).
 *
 * `permutationP` is the one-sided share of permuted correlations at or above
 * the observed one, computed with the usual `(hits + 1) / (permutations + 1)`
 * correction so it is never exactly zero.
 */
export function topographicSimilarity(input: {
  readonly episodes: readonly CompositionEpisode[];
  readonly seed: string;
  readonly permutations?: number;
  readonly confidence?: number;
  readonly maxEpisodes?: number;
}): TopographicResult {
  assertEpisodes(input.episodes);
  const permutations = input.permutations ?? DEFAULT_PERMUTATIONS;
  if (!Number.isInteger(permutations) || permutations < 1) {
    throw new AnalysisError('domain', 'permutations must be a positive integer');
  }
  const confidence = input.confidence ?? 0.95;
  assertLevel(confidence, 'confidence');
  const maxEpisodes = input.maxEpisodes ?? TOPOGRAPHIC_MAX_EPISODES;
  assertCount(maxEpisodes, 'maxEpisodes');

  const prng = new SeededPrng(`${input.seed}/topographic`);
  const available = input.episodes.length;
  const episodes =
    available <= maxEpisodes
      ? [...input.episodes]
      : prng.shuffle(input.episodes).slice(0, maxEpisodes);
  const n = episodes.length;

  if (n < 3) {
    return {
      spearman: NaN,
      pairs: (n * (n - 1)) / 2,
      episodesUsed: n,
      episodesAvailable: available,
      permutations,
      permutationP: NaN,
      nullInterval: { lower: NaN, upper: NaN },
      seed: input.seed,
      degenerate: true,
    };
  }

  const attributeMatrix: number[][] = episodes.map((left) =>
    episodes.map((right) =>
      attributeHammingDistance(left.attributes, right.attributes),
    ),
  );
  const messageMatrix: number[][] = episodes.map((left) =>
    episodes.map((right) => messageEditDistance(left.message, right.message)),
  );

  const pairsI: number[] = [];
  const pairsJ: number[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      pairsI.push(i);
      pairsJ.push(j);
    }
  }
  const attributeDistances = pairsI.map(
    (i, index) =>
      (attributeMatrix[i] as number[])[pairsJ[index] as number] as number,
  );
  const messageDistances = pairsI.map(
    (i, index) =>
      (messageMatrix[i] as number[])[pairsJ[index] as number] as number,
  );
  const observed = spearmanCorrelation(attributeDistances, messageDistances);

  if (Number.isNaN(observed)) {
    return {
      spearman: NaN,
      pairs: attributeDistances.length,
      episodesUsed: n,
      episodesAvailable: available,
      permutations,
      permutationP: NaN,
      nullInterval: { lower: NaN, upper: NaN },
      seed: input.seed,
      degenerate: true,
    };
  }

  const attributeRanks = midRanks(attributeDistances);
  const nullCorrelations = new Array<number>(permutations);
  let hits = 0;
  const identity = Array.from({ length: n }, (_unused, index) => index);
  for (let replicate = 0; replicate < permutations; replicate += 1) {
    const permuted = prng.shuffle(identity);
    const permutedDistances = pairsI.map(
      (i, index) =>
        (messageMatrix[permuted[i] as number] as number[])[
          permuted[pairsJ[index] as number] as number
        ] as number,
    );
    const correlation = pearson(attributeRanks, midRanks(permutedDistances));
    nullCorrelations[replicate] = correlation;
    if (!Number.isNaN(correlation) && correlation >= observed) {
      hits += 1;
    }
  }
  const sortedNull = nullCorrelations
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  const quantileAt = (probability: number): number => {
    if (sortedNull.length === 0) {
      return NaN;
    }
    const position = (sortedNull.length - 1) * probability;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    const lowValue = sortedNull[low] as number;
    if (low === high) {
      return lowValue;
    }
    return (
      lowValue + (position - low) * ((sortedNull[high] as number) - lowValue)
    );
  };

  return {
    spearman: observed,
    pairs: attributeDistances.length,
    episodesUsed: n,
    episodesAvailable: available,
    permutations,
    permutationP: (hits + 1) / (permutations + 1),
    nullInterval: { lower: quantileAt(tail), upper: quantileAt(1 - tail) },
    seed: input.seed,
    degenerate: false,
  };
}

/** Descriptive form/message reuse counts (E15 "Symbol reuse" column). */
export function symbolReuse(
  episodes: readonly CompositionEpisode[],
): SymbolReuseResult {
  assertEpisodes(episodes);
  const formCounts = new Map<string, number>();
  const messageCounts = new Map<string, number>();
  const formMessages = new Map<string, Set<string>>();
  const typeCodes = new Set<number>();
  let totalLength = 0;
  for (const episode of episodes) {
    const key = episode.message.join('\u0000');
    messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
    typeCodes.add(episode.typeCode);
    totalLength += episode.message.length;
    for (const form of episode.message) {
      formCounts.set(form, (formCounts.get(form) ?? 0) + 1);
      const messages = formMessages.get(form) ?? new Set<string>();
      messages.add(key);
      formMessages.set(form, messages);
    }
  }
  const distinctForms = formCounts.size;
  const totalFormUses = [...formCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  return {
    episodes: episodes.length,
    distinctForms,
    distinctMessages: messageCounts.size,
    meanMessageLength: totalLength / episodes.length,
    messagesPerTypeCode:
      typeCodes.size === 0 ? NaN : messageCounts.size / typeCodes.size,
    messageRepeatRate: 1 - messageCounts.size / episodes.length,
    formUsesPerDistinctForm:
      distinctForms === 0 ? NaN : totalFormUses / distinctForms,
    formsSharedAcrossMessages: [...formMessages.values()].filter(
      (messages) => messages.size > 1,
    ).length,
  };
}

function withInterval(
  successes: number,
  n: number,
  confidence: number,
): ProportionWithInterval {
  const summary = proportion(successes, n);
  return { summary, wilson: wilsonInterval(successes, n, confidence) };
}

function emptyInterval(confidence: number): ProportionWithInterval {
  return {
    summary: { successes: 0, n: 0, proportion: NaN },
    wilson: {
      lower: NaN,
      upper: NaN,
      center: NaN,
      level: confidence,
      successes: 0,
      n: 0,
      proportion: NaN,
    },
  };
}

function orderSensitivity(
  probes: readonly OrderProbeOutcome[],
  confidence: number,
): OrderSensitivityResult {
  const baselineSuccesses = probes.filter((probe) => probe.baselineSuccess)
    .length;
  const reorderedSuccesses = probes.filter((probe) => probe.reorderedSuccess)
    .length;
  const baseline = withInterval(baselineSuccesses, probes.length, confidence);
  const reordered = withInterval(reorderedSuccesses, probes.length, confidence);
  return {
    probes: probes.length,
    baseline,
    reordered,
    difference:
      baseline.summary.proportion - reordered.summary.proportion,
    cohensH: cohensH(
      baseline.summary.proportion,
      reordered.summary.proportion,
    ),
  };
}

function bandwidthContrast(
  conditions: readonly BandwidthConditionInput[],
  alpha: number,
  minimumSeeds: number,
): BandwidthContrastResult {
  const summaries = conditions.map((condition) => {
    if (condition.perSeedHeldOutSuccess.length === 0) {
      throw new AnalysisError(
        'empty-sample',
        `bandwidth condition ${condition.label} has no seeds`,
      );
    }
    const seedProportions = condition.perSeedHeldOutSuccess.map((entry) => {
      const summary = proportion(entry.successes, entry.n);
      return summary.proportion;
    });
    const pooled = proportion(
      condition.perSeedHeldOutSuccess.reduce(
        (total, entry) => total + entry.successes,
        0,
      ),
      condition.perSeedHeldOutSuccess.reduce(
        (total, entry) => total + entry.n,
        0,
      ),
    );
    return {
      label: condition.label,
      symbolInventorySize: condition.symbolInventorySize,
      maxSymbolsPerMessage: condition.maxSymbolsPerMessage,
      seeds: seedProportions.length,
      seedMean:
        seedProportions.reduce((total, value) => total + value, 0) /
        seedProportions.length,
      pooledDescriptive: pooled,
      seedProportions,
    };
  });

  const reasons: BandwidthContrastResult['exploratoryReasonCodes'][number][] =
    [];
  if (conditions.length === 1) {
    reasons.push('single-condition');
  }
  if (conditions.length > 2) {
    reasons.push('more-than-two-conditions');
  }
  if (summaries.some((summary) => summary.seeds < minimumSeeds)) {
    reasons.push('below-seed-minimum');
  }

  const first = summaries[0];
  const second = summaries[1];
  const test =
    first !== undefined && second !== undefined
      ? welchTTest(first.seedProportions, second.seedProportions, 'two-sided')
      : welchTTest([NaN], [NaN], 'two-sided');
  const h =
    first !== undefined && second !== undefined
      ? cohensH(
          first.pooledDescriptive.proportion,
          second.pooledDescriptive.proportion,
        )
      : NaN;

  return {
    conditions: summaries.map((summary) => ({
      label: summary.label,
      symbolInventorySize: summary.symbolInventorySize,
      maxSymbolsPerMessage: summary.maxSymbolsPerMessage,
      seeds: summary.seeds,
      seedMean: summary.seedMean,
      pooledDescriptive: summary.pooledDescriptive,
    })),
    seedLevelTest: test,
    cohensH: h,
    alpha,
    minimumSeedsForConfirmatory: minimumSeeds,
    inferenceClass: reasons.length === 0 ? 'confirmatory' : 'exploratory',
    exploratoryReasonCodes: reasons,
  };
}

/**
 * The whole E15 readout. Every field is a measurement; the module draws no
 * compositionality conclusion from any of them, and E15's own procedure says
 * not to ("Avoid declaring compositionality from one metric").
 */
export function evaluateComposition(
  input: CompositionInput,
): CompositionResult {
  assertEpisodes(input.episodes);
  const confidence = input.confidence ?? 0.95;
  const alpha = input.alpha ?? 0.05;
  assertLevel(confidence, 'confidence');
  assertLevel(alpha, 'alpha');
  if (typeof input.seed !== 'string' || input.seed.length === 0) {
    throw new AnalysisError('domain', 'seed must be a non-empty string');
  }

  const seenEpisodes = input.episodes.filter(
    (episode) => episode.split === 'train',
  );
  const heldOutEpisodes = input.episodes.filter(
    (episode) => episode.split === 'held-out',
  );
  const seen =
    seenEpisodes.length === 0
      ? emptyInterval(confidence)
      : withInterval(
          seenEpisodes.filter((episode) => episode.success).length,
          seenEpisodes.length,
          confidence,
        );
  const heldOut =
    heldOutEpisodes.length === 0
      ? emptyInterval(confidence)
      : withInterval(
          heldOutEpisodes.filter((episode) => episode.success).length,
          heldOutEpisodes.length,
          confidence,
        );

  // Seed-level paired difference: the §15.3 unit of analysis is the run/seed,
  // and seen/held-out come from the same run, so the pairs are seed slots.
  const seeds = [
    ...new Set(
      input.episodes
        .map((episode) => episode.seed)
        .filter((seed): seed is string => seed !== undefined),
    ),
  ].sort();
  const pairedSeen: number[] = [];
  const pairedHeldOut: number[] = [];
  for (const seed of seeds) {
    const seenForSeed = seenEpisodes.filter(
      (episode) => episode.seed === seed,
    );
    const heldOutForSeed = heldOutEpisodes.filter(
      (episode) => episode.seed === seed,
    );
    if (seenForSeed.length === 0 || heldOutForSeed.length === 0) {
      continue;
    }
    pairedSeen.push(
      seenForSeed.filter((episode) => episode.success).length /
        seenForSeed.length,
    );
    pairedHeldOut.push(
      heldOutForSeed.filter((episode) => episode.success).length /
        heldOutForSeed.length,
    );
  }
  const seedLevelDifference =
    pairedSeen.length >= 2
      ? bootstrapPairedDifferenceCi(pairedSeen, pairedHeldOut, {
          seed: `${input.seed}/seen-vs-held-out`,
          iterations: 2_000,
          confidence,
        })
      : null;

  return {
    analysisVersion: COMPOSITION_ANALYSIS_VERSION,
    splitIntegrity: checkHeldOutSplitIntegrity({
      episodes: input.episodes,
      ...(input.heldOutTypeCodes === undefined
        ? {}
        : { heldOutTypeCodes: input.heldOutTypeCodes }),
    }),
    seen,
    heldOut,
    seenMinusHeldOut: seen.summary.proportion - heldOut.summary.proportion,
    cohensHSeenVersusHeldOut:
      Number.isNaN(seen.summary.proportion) ||
      Number.isNaN(heldOut.summary.proportion)
        ? NaN
        : cohensH(seen.summary.proportion, heldOut.summary.proportion),
    seedLevelDifference,
    topographic: topographicSimilarity({
      episodes: input.episodes,
      seed: input.seed,
      ...(input.permutations === undefined
        ? {}
        : { permutations: input.permutations }),
      confidence,
    }),
    symbolReuse: symbolReuse(input.episodes),
    orderSensitivity:
      input.orderProbes === undefined || input.orderProbes.length === 0
        ? null
        : orderSensitivity(input.orderProbes, confidence),
    bandwidthContrast:
      input.bandwidthConditions === undefined ||
      input.bandwidthConditions.length === 0
        ? null
        : bandwidthContrast(
            input.bandwidthConditions,
            alpha,
            input.minimumSeedsForConfirmatory ??
              E15_CONFIRMATORY_MINIMUM_SEEDS,
          ),
    confidence,
    alpha,
    seed: input.seed,
  };
}
