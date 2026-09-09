/**
 * Offline alternate-carrier leakage evaluation (SPEC §9.2, §15.3; ALD-032).
 *
 * The evaluator operates on immutable, already accepted artifacts. It
 * verifies their carrier-qualified mark hashes, derives only pre-declared
 * structural features, and never returns a rewritten artifact.
 */
import {
  AgentActionProposalSchema,
  type AgentActionProposal,
  type CarrierLeakageProbePlan,
  type RunConfig,
  type Sha256Hash,
} from '@ald/types';
import { hashCarrierMark } from '@ald/hashing';

import { AnalysisError } from './errors.js';

export const CARRIER_LEAKAGE_ANALYSIS_VERSION = 'carrier-leakage-v1';

export type CarrierLeakageProbeDecision = 'pass' | 'fail' | 'inconclusive';
export type RecognizableGlyphOutcome =
  | 'recognizable'
  | 'not-recognizable'
  | 'unscored';

export interface CarrierLeakageObservation {
  carrier: RunConfig['carrierMode'];
  markHash: Sha256Hash;
  artifact: AgentActionProposal['publicArtifact'];
  /** Zero-based, opaque task/referent class used only by the offline probe. */
  referentTypeCode: number;
}

export interface CarrierLeakageInput {
  observations: readonly CarrierLeakageObservation[];
  probePlan: CarrierLeakageProbePlan;
  /** External OCR/glyph-probe outcomes, keyed by carrier-qualified mark hash. */
  recognizableGlyphOutcomes: Readonly<Record<string, RecognizableGlyphOutcome>>;
}

export type { CarrierLeakageProbePlan };

export interface CarrierMarkLeakageMetric {
  carrier: RunConfig['carrierMode'];
  markHash: Sha256Hash;
  observations: number;
  referentTypeCodes: number[];
  unintendedFeatureSignature: string;
  recognizableGlyphOutcome: RecognizableGlyphOutcome | 'not-applicable';
}

export interface CarrierLeakageProbeResult {
  decision: CarrierLeakageProbeDecision;
  observations: number;
  assessedMarks: number;
  metric: number;
  bound: number;
  reason: string;
}

export interface CarrierLeakageResult {
  analysisVersion: typeof CARRIER_LEAKAGE_ANALYSIS_VERSION;
  observations: number;
  uniqueMarks: number;
  reuseRate: number;
  markMetrics: CarrierMarkLeakageMetric[];
  recognizableGlyphProbe: CarrierLeakageProbeResult;
  unintendedFeatureProbe: CarrierLeakageProbeResult;
  decision: CarrierLeakageProbeDecision;
  artifactHashesVerified: true;
  claimBoundary: {
    ungroundedLanguageClaim: 'eligible' | 'blocked';
    runValidityImpact: 'none';
    evidenceUse:
      | 'eligible-subject-to-other-gates'
      | 'valid-negative-or-integrity-evidence';
  };
}

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AnalysisError('domain', `${name} must be within [0, 1]`);
  }
}

function proposalFor(observation: CarrierLeakageObservation): AgentActionProposal {
  const kind = {
    'fixed-token': 'emit_symbols',
    'fixed-glyph': 'emit_glyphs',
    'generative-bitmap': 'emit_bitmap',
    'generative-canvas': 'emit_canvas',
    'generative-tone': 'emit_tones',
  }[observation.carrier];
  return AgentActionProposalSchema.parse({ kind, publicArtifact: observation.artifact });
}

function round(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function structuralFeature(
  carrier: RunConfig['carrierMode'],
  artifact: AgentActionProposal['publicArtifact'],
): string {
  if (carrier === 'fixed-token' && 'symbols' in artifact) {
    return `symbol-count:${String(artifact.symbols.length)}`;
  }
  if (carrier === 'fixed-glyph' && 'glyphs' in artifact) {
    return `glyph-count:${String(artifact.glyphs.length)}`;
  }
  if (carrier === 'generative-bitmap' && 'bitmap' in artifact) {
    const ink = artifact.bitmap.bits.filter((bit) => bit === 1).length;
    return `ink-density-decile:${String(Math.min(9, Math.floor((ink / 256) * 10)))}`;
  }
  if (carrier === 'generative-canvas' && 'strokes' in artifact) {
    const strokes = artifact.strokes;
    const widthTotal = strokes.reduce((sum, stroke) => sum + stroke.width, 0);
    const axisAligned = strokes.filter(
      (stroke) => stroke.startX === stroke.endX || stroke.startY === stroke.endY,
    ).length;
    return (
      `stroke-count:${String(strokes.length)}|` +
      `mean-width-quarter:${String(Math.round((widthTotal / strokes.length) * 4))}|` +
      `axis-share-quarter:${String(Math.round((axisAligned / strokes.length) * 4))}`
    );
  }
  if (carrier === 'generative-tone' && 'tones' in artifact) {
    const tones = artifact.tones.tones;
    const pitchRange =
      tones.length === 0
        ? 0
        : Math.max(...tones.map((tone) => tone.pitchBin)) -
          Math.min(...tones.map((tone) => tone.pitchBin));
    const durationTotal = tones.reduce((sum, tone) => sum + tone.durationBin, 0);
    return (
      `tone-count:${String(tones.length)}|pitch-range:${String(pitchRange)}|` +
      `mean-duration-half:${String(tones.length === 0 ? 0 : Math.round((durationTotal / tones.length) * 2))}`
    );
  }
  throw new AnalysisError('domain', `artifact does not match carrier ${carrier}`);
}

function mutualInformationBits(
  observations: readonly { feature: string; referent: number }[],
): number {
  const features = new Map<string, number>();
  const referents = new Map<number, number>();
  const joint = new Map<string, number>();
  for (const observation of observations) {
    features.set(observation.feature, (features.get(observation.feature) ?? 0) + 1);
    referents.set(observation.referent, (referents.get(observation.referent) ?? 0) + 1);
    const key = `${observation.feature}\u0000${String(observation.referent)}`;
    joint.set(key, (joint.get(key) ?? 0) + 1);
  }
  const total = observations.length;
  let information = 0;
  for (const [key, count] of joint) {
    const split = key.lastIndexOf('\u0000');
    const feature = key.slice(0, split);
    const referent = Number(key.slice(split + 1));
    const pxy = count / total;
    const px = (features.get(feature) ?? 0) / total;
    const py = (referents.get(referent) ?? 0) / total;
    information += pxy * Math.log2(pxy / (px * py));
  }
  return round(information);
}

/** Run both pre-registered probes without mutating any input artifact. */
export function evaluateCarrierLeakage(
  input: CarrierLeakageInput,
): CarrierLeakageResult {
  if (input.observations.length === 0) {
    throw new AnalysisError('empty-sample', 'observations must not be empty');
  }
  assertProbability(
    input.probePlan.recognizableGlyph.maximumRecognizableRate,
    'recognizableGlyph.maximumRecognizableRate',
  );
  const featurePlan = input.probePlan.unintendedFeature;
  if (
    !Number.isFinite(featurePlan.maximumMutualInformationBits) ||
    featurePlan.maximumMutualInformationBits < 0
  ) {
    throw new AnalysisError(
      'domain',
      'unintendedFeature.maximumMutualInformationBits must be non-negative',
    );
  }
  if (!Number.isInteger(featurePlan.minimumObservations) || featurePlan.minimumObservations < 1) {
    throw new AnalysisError(
      'domain',
      'unintendedFeature.minimumObservations must be a positive integer',
    );
  }

  const grouped = new Map<string, CarrierMarkLeakageMetric>();
  const featureObservations: Array<{ feature: string; referent: number }> = [];
  for (const [index, observation] of input.observations.entries()) {
    if (!Number.isInteger(observation.referentTypeCode) || observation.referentTypeCode < 0) {
      throw new AnalysisError(
        'domain',
        `observations[${String(index)}].referentTypeCode must be a non-negative integer`,
      );
    }
    const proposal = proposalFor(observation);
    const rebuilt = hashCarrierMark(observation.carrier, proposal.publicArtifact);
    if (rebuilt !== observation.markHash) {
      throw new AnalysisError(
        'domain',
        `observations[${String(index)}].markHash does not match its carrier artifact`,
      );
    }
    const feature = structuralFeature(observation.carrier, proposal.publicArtifact);
    featureObservations.push({ feature: `${observation.carrier}|${feature}`, referent: observation.referentTypeCode });
    const key = `${observation.carrier}|${observation.markHash}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        carrier: observation.carrier,
        markHash: observation.markHash,
        observations: 1,
        referentTypeCodes: [observation.referentTypeCode],
        unintendedFeatureSignature: feature,
        recognizableGlyphOutcome:
          observation.carrier === 'fixed-glyph'
            ? (input.recognizableGlyphOutcomes[observation.markHash] ?? 'unscored')
            : 'not-applicable',
      });
    } else {
      existing.observations += 1;
      if (!existing.referentTypeCodes.includes(observation.referentTypeCode)) {
        existing.referentTypeCodes.push(observation.referentTypeCode);
        existing.referentTypeCodes.sort((a, b) => a - b);
      }
    }
  }

  const markMetrics = [...grouped.values()].sort((left, right) =>
    `${left.carrier}|${left.markHash}`.localeCompare(`${right.carrier}|${right.markHash}`),
  );
  const glyphMarks = markMetrics.filter((metric) => metric.carrier === 'fixed-glyph');
  const assessedGlyphs = glyphMarks.filter(
    (metric) => metric.recognizableGlyphOutcome !== 'unscored',
  );
  const recognizable = assessedGlyphs.filter(
    (metric) => metric.recognizableGlyphOutcome === 'recognizable',
  ).length;
  const recognizableRate =
    assessedGlyphs.length === 0 ? 0 : round(recognizable / assessedGlyphs.length);
  const glyphComplete = glyphMarks.length > 0 && assessedGlyphs.length === glyphMarks.length;
  const glyphDecision: CarrierLeakageProbeDecision =
    !input.probePlan.recognizableGlyph.enabled || !glyphComplete
      ? 'inconclusive'
      : recognizableRate > input.probePlan.recognizableGlyph.maximumRecognizableRate
        ? 'fail'
        : 'pass';
  const recognizableGlyphProbe: CarrierLeakageProbeResult = {
    decision: glyphDecision,
    observations: glyphMarks.reduce((sum, metric) => sum + metric.observations, 0),
    assessedMarks: assessedGlyphs.length,
    metric: recognizableRate,
    bound: input.probePlan.recognizableGlyph.maximumRecognizableRate,
    reason:
      glyphDecision === 'inconclusive'
        ? 'probe disabled, no glyph marks, or at least one glyph mark was unscored'
        : glyphDecision === 'fail'
          ? 'recognizable glyph rate exceeds the pre-registered bound'
          : 'recognizable glyph rate is within the pre-registered bound',
  };

  const featureMi = mutualInformationBits(featureObservations);
  const featureDecision: CarrierLeakageProbeDecision =
    !featurePlan.enabled || input.observations.length < featurePlan.minimumObservations
      ? 'inconclusive'
      : featureMi > featurePlan.maximumMutualInformationBits
        ? 'fail'
        : 'pass';
  const unintendedFeatureProbe: CarrierLeakageProbeResult = {
    decision: featureDecision,
    observations: input.observations.length,
    assessedMarks: markMetrics.length,
    metric: featureMi,
    bound: featurePlan.maximumMutualInformationBits,
    reason:
      featureDecision === 'inconclusive'
        ? 'probe disabled or fewer than the pre-registered minimum observations were supplied'
        : featureDecision === 'fail'
          ? 'feature/referent mutual information exceeds the pre-registered bound'
          : 'feature/referent mutual information is within the pre-registered bound',
  };

  const decisions = [glyphDecision, featureDecision];
  const decision: CarrierLeakageProbeDecision = decisions.includes('fail')
    ? 'fail'
    : decisions.includes('inconclusive')
      ? 'inconclusive'
      : 'pass';
  const eligible = decision === 'pass';
  return {
    analysisVersion: CARRIER_LEAKAGE_ANALYSIS_VERSION,
    observations: input.observations.length,
    uniqueMarks: markMetrics.length,
    reuseRate: round(1 - markMetrics.length / input.observations.length),
    markMetrics,
    recognizableGlyphProbe,
    unintendedFeatureProbe,
    decision,
    artifactHashesVerified: true,
    claimBoundary: {
      ungroundedLanguageClaim: eligible ? 'eligible' : 'blocked',
      runValidityImpact: 'none',
      evidenceUse: eligible
        ? 'eligible-subject-to-other-gates'
        : 'valid-negative-or-integrity-evidence',
    },
  };
}
