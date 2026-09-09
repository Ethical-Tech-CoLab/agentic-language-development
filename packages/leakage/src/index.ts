/** Deterministic semantic-leakage qualification (SPEC §6.5, ALD-057). */
import { quantileSorted } from '@ald/analysis';
import { SeededPrng } from '@ald/hashing';
import type { LearnerProvenance, LearnerTrackId } from '@ald/types';

export const SEMANTIC_LEAKAGE_ANALYSIS_VERSION = 'semantic-leakage-v1';
export const SEMANTIC_LEAKAGE_CONFIDENCE = 0.95;

export interface SemanticFeatureRow {
  readonly features: readonly number[];
  /** Human-language label, available only to the offline analysis. */
  readonly label: string;
}

export interface SemanticLeakagePreRegistration {
  readonly seed: string;
  readonly confidence: 0.95;
  readonly permutations: number;
}

export interface SemanticLeakageInput {
  readonly provenance: LearnerProvenance;
  readonly frozenFeatures: readonly SemanticFeatureRow[];
  readonly preRegistration: SemanticLeakagePreRegistration;
}

export interface LinearProbeResult {
  readonly observedAccuracy: number;
  readonly shuffledControl: {
    readonly confidence: 0.95;
    readonly lower: number;
    readonly upper: number;
    readonly permutations: number;
  };
  readonly withinShuffledInterval: boolean;
  readonly trainRows: number;
  readonly testRows: number;
  readonly classes: number;
}

export type SemanticClaimClassification =
  | 'strict-ungrounded-eligible'
  | 'strict-ungrounded-blocked'
  | 'weakened-text-aligned-features'
  | 'pretrained-exempt'
  | 'no-learning-control';

export interface SemanticLeakageResult {
  readonly analysisVersion: typeof SEMANTIC_LEAKAGE_ANALYSIS_VERSION;
  readonly track: LearnerTrackId;
  readonly modelRef: string;
  readonly componentHashes: string[];
  readonly tokenizerVocabularyAudit: {
    readonly passed: boolean;
    readonly textTokenizerPresent: boolean;
    readonly languageComponents: string[];
  };
  readonly linearProbe: LinearProbeResult | null;
  readonly visionLanguageEncoderAudit: {
    readonly passed: boolean;
    readonly textAlignedComponents: string[];
  };
  readonly classification: SemanticClaimClassification;
  readonly claimEligible: boolean;
}

interface Split {
  train: number[];
  test: number[];
}

function assertInput(input: SemanticLeakageInput): void {
  if (input.preRegistration.seed.length === 0) {
    throw new Error('semantic-leakage seed must not be empty');
  }
  if (input.preRegistration.confidence !== SEMANTIC_LEAKAGE_CONFIDENCE) {
    throw new Error('semantic-leakage confidence must be pre-registered at 0.95');
  }
  if (
    !Number.isInteger(input.preRegistration.permutations) ||
    input.preRegistration.permutations < 20
  ) {
    throw new Error('semantic-leakage permutations must be an integer of at least 20');
  }
  if (input.frozenFeatures.length < 8) {
    throw new Error('semantic-leakage probe requires at least 8 feature rows');
  }
  const dimension = input.frozenFeatures[0]?.features.length ?? 0;
  if (dimension === 0) {
    throw new Error('semantic-leakage feature vectors must not be empty');
  }
  for (const [index, row] of input.frozenFeatures.entries()) {
    if (row.label.length === 0 || row.features.length !== dimension) {
      throw new Error(`semantic-leakage row ${String(index)} has an invalid shape`);
    }
    if (row.features.some((value) => !Number.isFinite(value))) {
      throw new Error(`semantic-leakage row ${String(index)} contains a non-finite feature`);
    }
  }
}

/** Stratification prevents a chance result from being a split imbalance. */
function stratifiedSplit(labels: readonly number[], seed: string): Split {
  const byClass = new Map<number, number[]>();
  labels.forEach((label, index) => {
    const rows = byClass.get(label) ?? [];
    rows.push(index);
    byClass.set(label, rows);
  });
  const train: number[] = [];
  const test: number[] = [];
  for (const [label, rows] of [...byClass].sort(([a], [b]) => a - b)) {
    if (rows.length < 4) {
      throw new Error(`semantic-leakage label ${String(label)} requires at least 4 rows`);
    }
    const shuffled = new SeededPrng(`${seed}/split/${String(label)}`).shuffle(rows);
    const testCount = Math.max(1, Math.floor(shuffled.length / 4));
    test.push(...shuffled.slice(0, testCount));
    train.push(...shuffled.slice(testCount));
  }
  return { train, test };
}

function trainLinearProbe(
  rows: readonly SemanticFeatureRow[],
  labels: readonly number[],
  train: readonly number[],
  classes: number,
): number[][] {
  const dimensions = rows[0]?.features.length ?? 0;
  const weights = Array.from({ length: classes }, () =>
    Array.from({ length: dimensions + 1 }, () => 0),
  );
  for (let epoch = 0; epoch < 400; epoch += 1) {
    const gradients = weights.map((row) => row.map(() => 0));
    for (const rowIndex of train) {
      const vector = [...(rows[rowIndex]?.features ?? []), 1];
      const logits = weights.map((classWeights) =>
        classWeights.reduce(
          (sum, weight, dimension) => sum + weight * (vector[dimension] ?? 0),
          0,
        ),
      );
      const maximum = Math.max(...logits);
      const exponentials = logits.map((value) => Math.exp(value - maximum));
      const denominator = exponentials.reduce((sum, value) => sum + value, 0);
      for (let classIndex = 0; classIndex < classes; classIndex += 1) {
        const error =
          (exponentials[classIndex] ?? 0) / denominator -
          (labels[rowIndex] === classIndex ? 1 : 0);
        for (let dimension = 0; dimension < vector.length; dimension += 1) {
          const gradient = gradients[classIndex];
          if (gradient !== undefined) {
            gradient[dimension] =
              (gradient[dimension] ?? 0) + error * (vector[dimension] ?? 0);
          }
        }
      }
    }
    const rate = 0.2 / Math.sqrt(epoch + 1);
    for (let classIndex = 0; classIndex < classes; classIndex += 1) {
      for (let dimension = 0; dimension <= dimensions; dimension += 1) {
        const classWeights = weights[classIndex];
        const gradient = gradients[classIndex];
        if (classWeights !== undefined && gradient !== undefined) {
          classWeights[dimension] =
            (classWeights[dimension] ?? 0) -
            (rate * (gradient[dimension] ?? 0)) / train.length;
        }
      }
    }
  }
  return weights;
}

function accuracy(
  weights: readonly (readonly number[])[],
  rows: readonly SemanticFeatureRow[],
  labels: readonly number[],
  indices: readonly number[],
): number {
  let correct = 0;
  for (const index of indices) {
    const vector = [...(rows[index]?.features ?? []), 1];
    const logits = weights.map((classWeights) =>
      classWeights.reduce(
        (sum, weight, dimension) => sum + weight * (vector[dimension] ?? 0),
        0,
      ),
    );
    let predicted = 0;
    for (let classIndex = 1; classIndex < logits.length; classIndex += 1) {
      if ((logits[classIndex] ?? -Infinity) > (logits[predicted] ?? -Infinity)) {
        predicted = classIndex;
      }
    }
    if (predicted === labels[index]) {
      correct += 1;
    }
  }
  return correct / indices.length;
}

function evaluateLinearProbe(input: SemanticLeakageInput): LinearProbeResult {
  const names = [...new Set(input.frozenFeatures.map((row) => row.label))].sort();
  if (names.length < 2) {
    throw new Error('semantic-leakage probe requires at least two labels');
  }
  const labelIndex = new Map(names.map((name, index) => [name, index]));
  const labels = input.frozenFeatures.map((row) => labelIndex.get(row.label) ?? -1);
  const split = stratifiedSplit(labels, input.preRegistration.seed);
  const observed = accuracy(
    trainLinearProbe(input.frozenFeatures, labels, split.train, names.length),
    input.frozenFeatures,
    labels,
    split.test,
  );
  const prng = new SeededPrng(`${input.preRegistration.seed}/label-shuffled`);
  const shuffledAccuracies: number[] = [];
  const trainLabels = split.train.map((index) => labels[index] ?? -1);
  for (let permutation = 0; permutation < input.preRegistration.permutations; permutation += 1) {
    const shuffled = prng.shuffle(trainLabels);
    const controlLabels = [...labels];
    split.train.forEach((rowIndex, position) => {
      controlLabels[rowIndex] = shuffled[position] ?? -1;
    });
    shuffledAccuracies.push(
      accuracy(
        trainLinearProbe(input.frozenFeatures, controlLabels, split.train, names.length),
        input.frozenFeatures,
        labels,
        split.test,
      ),
    );
  }
  shuffledAccuracies.sort((a, b) => a - b);
  const alpha = (1 - SEMANTIC_LEAKAGE_CONFIDENCE) / 2;
  const lower = quantileSorted(shuffledAccuracies, alpha);
  const upper = quantileSorted(shuffledAccuracies, 1 - alpha);
  return {
    observedAccuracy: observed,
    shuffledControl: {
      confidence: SEMANTIC_LEAKAGE_CONFIDENCE,
      lower,
      upper,
      permutations: input.preRegistration.permutations,
    },
    withinShuffledInterval: observed >= lower && observed <= upper,
    trainRows: split.train.length,
    testRows: split.test.length,
    classes: names.length,
  };
}

export function evaluateSemanticLeakage(
  input: SemanticLeakageInput,
): SemanticLeakageResult {
  assertInput(input);
  const provenance = input.provenance;
  const languageComponents = provenance.components
    .filter(
      (component) =>
        component.kind === 'language-model' ||
        component.provenance === 'frozen-open-weight',
    )
    .map((component) => component.name);
  const textAlignedComponents = provenance.components
    .filter((component) => component.textAligned)
    .map((component) => component.name);
  const tokenizerPassed =
    !provenance.textTokenizerPresent && languageComponents.length === 0;
  const encoderPassed =
    !provenance.textAlignedEncoderPresent && textAlignedComponents.length === 0;

  let linearProbe: LinearProbeResult | null = null;
  let classification: SemanticClaimClassification;
  if (provenance.track === 'frozen-llm') {
    classification = 'pretrained-exempt';
  } else if (provenance.track === 'no-learning') {
    classification = 'no-learning-control';
  } else {
    linearProbe = evaluateLinearProbe(input);
    if (!encoderPassed && provenance.track === 'hybrid') {
      classification = 'weakened-text-aligned-features';
    } else if (tokenizerPassed && encoderPassed && linearProbe.withinShuffledInterval) {
      classification = 'strict-ungrounded-eligible';
    } else {
      classification = 'strict-ungrounded-blocked';
    }
  }

  return {
    analysisVersion: SEMANTIC_LEAKAGE_ANALYSIS_VERSION,
    track: provenance.track,
    modelRef: provenance.modelRef,
    componentHashes: provenance.components.map((component) => component.hash),
    tokenizerVocabularyAudit: {
      passed: tokenizerPassed,
      textTokenizerPresent: provenance.textTokenizerPresent,
      languageComponents,
    },
    linearProbe,
    visionLanguageEncoderAudit: {
      passed: encoderPassed,
      textAlignedComponents,
    },
    classification,
    claimEligible: classification === 'strict-ungrounded-eligible',
  };
}
