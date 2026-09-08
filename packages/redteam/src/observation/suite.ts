/**
 * Observation-text and quarantine-bypass red-team suite (ALD-068;
 * SPECIFICATION.md §10.1, §10.2; EXPERIMENT-NOTEBOOK.md E02).
 *
 * The suite runs every pre-registered fixture bundle through the real
 * `registerScenarioBundle` filter and then, for any bundle the filter
 * approves, actually **delivers** the resulting observations into an
 * instrumented sink that stands in for a learner adapter. Both halves matter:
 * a filter that quarantines correctly but is not on the delivery path proves
 * nothing, so the suite exercises the same `buildObservation` gate the
 * runtime uses (ALD-037/ALD-038) and reports what the sink saw.
 *
 * What this suite is: **software readiness** for E02, in Prototype Mode. It
 * shows that the implemented filter quarantines the implemented attack set
 * and that nothing prohibited reaches the adapter boundary in these runs.
 *
 * What it is NOT: the E02 result, an OCR guarantee, or evidence about any
 * attack not in the fixture set. E02's acceptance criteria also require a
 * metadata-only leakage probe over real run data and an encoder-provenance
 * review, neither of which lives here. The result object is an *attachment*
 * (`kind: 'red-team-observation'`) that an Experiment Record links; it is
 * never the Experiment Record (ALD-068 criterion 3).
 *
 * Filenames and captions are deliberately *permitted* while the suite runs
 * (`allowFileNames`/`allowCaptions`). The filter's own default is
 * fail-closed — carrying either is a finding by itself — but that default
 * would decide the filename and caption fixtures without ever consulting the
 * §10.1 language scan. Permitting them makes those fixtures test what they
 * were written to test: that the scan catches semantic, homoglyph, and
 * zero-width strings, while an opaque filename still loads.
 */
import type { Observation } from '@ald/types';
import {
  buildObservation,
  decodePng,
  hygieneErrors,
  registerScenarioBundle,
  type OcrDetector,
  type ScenarioBundleRegistration,
} from '@ald/scenario';
import { canonicalJson } from '@ald/hashing';

import { RedTeamError } from '../errors.js';
import type { LoadedFixture } from '../fixtures/load.js';
import { FIXTURE_SET_VERSION } from '../fixtures/catalogue.js';
import { hashUtf8 } from '../fixtures/manifest.js';

/** Version of this suite; recorded in the attachment. */
export const OBSERVATION_SUITE_VERSION = 'red-team-observation-suite-v1';

/**
 * The honest scope sentence carried in every result object, so a reader of
 * the attachment cannot mistake readiness for a finding.
 */
export const OBSERVATION_SUITE_CLAIM =
  'Software readiness for E02 in Prototype Mode: the implemented observation ' +
  'hygiene filter quarantined the pre-registered fixture set recorded here, ' +
  'and no observation was delivered for any quarantined bundle. This is not ' +
  'the E02 Experiment Record, not an OCR guarantee, and says nothing about ' +
  'attacks outside this fixture set.';

/** Opaque run id used for the delivered observations (§10.1-clean). */
const SUITE_RUN_ID = 'rtsuite-0001';

/** Bounded payload edge: every asset is block-averaged to at most this size. */
const PAYLOAD_EDGE = 24;

export interface DeliveryRecord {
  fixtureId: string;
  observation: Observation;
}

/**
 * Instrumented stand-in for a learner adapter's observation input. It records
 * everything handed to it, so the suite can assert on what an adapter *would*
 * have seen rather than on what the filter intended.
 */
export class InstrumentedAdapterSink {
  private readonly entries: DeliveryRecord[] = [];

  observe(fixtureId: string, observation: Observation): void {
    this.entries.push({ fixtureId, observation });
  }

  get records(): readonly DeliveryRecord[] {
    return this.entries;
  }

  for(fixtureId: string): DeliveryRecord[] {
    return this.entries.filter((entry) => entry.fixtureId === fixtureId);
  }

  /** Canonical JSON of everything delivered; what a leak scan searches. */
  canonicalRecords(): string[] {
    return this.entries.map((entry) => canonicalJson(entry.observation));
  }
}

/**
 * Block-average an asset's luminance down to at most `PAYLOAD_EDGE` per side.
 * A `pixel`-encoding run delivers pixels; this keeps the payload bounded and
 * integral so the delivered observation canonicalizes byte-identically.
 */
function payloadFromLuminance(
  luminance: Uint8Array,
  width: number,
  height: number,
): number[][] {
  const rows = Math.min(PAYLOAD_EDGE, height);
  const columns = Math.min(PAYLOAD_EDGE, width);
  const payload: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const fromRow = Math.floor((row * height) / rows);
    const toRow = Math.max(fromRow + 1, Math.floor(((row + 1) * height) / rows));
    const line: number[] = [];
    for (let column = 0; column < columns; column += 1) {
      const fromColumn = Math.floor((column * width) / columns);
      const toColumn = Math.max(
        fromColumn + 1,
        Math.floor(((column + 1) * width) / columns),
      );
      let total = 0;
      let count = 0;
      for (let y = fromRow; y < toRow; y += 1) {
        for (let x = fromColumn; x < toColumn; x += 1) {
          total += luminance[y * width + x] ?? 0;
          count += 1;
        }
      }
      line.push(count === 0 ? 0 : Math.round(total / count));
    }
    payload.push(line);
  }
  return payload;
}

export interface ObservationRedTeamFixtureResult {
  fixtureId: string;
  category: string;
  expected: 'quarantined' | 'approved';
  observed: 'quarantined' | 'approved';
  agreesWithExpectation: boolean;
  /** Quarantine reason codes; codes only, never the offending content. */
  reasonCodes: string[];
  /** Plain SHA-256 of every asset in the bundle. */
  assetHashes: string[];
  bundleHash: string;
  /** SHA-256 of the planted string, when the fixture planted one. */
  plantedTextHash?: string;
  deliveredObservationCount: number;
  /**
   * True only if something prohibited actually reached the sink: a delivered
   * observation that fails the §10.1 filter, or a string field outside the
   * §11.2 allowlist.
   */
  rawTextReachedAdapter: boolean;
  /** Detector score, when the pixel detector was the deciding cue. */
  detectorScore?: number;
}

export interface ObservationRedTeamSummary {
  total: number;
  positives: number;
  negatives: number;
  quarantined: number;
  approved: number;
  truePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  falsePositives: number;
  /** Fixtures expected to be quarantined that were not. Reported, not hidden. */
  falseNegativeFixtureIds: string[];
  /** Text-free controls that were quarantined. MUST be empty (ALD-039 cb 2). */
  falsePositiveFixtureIds: string[];
  deliveredObservations: number;
  /** Observations delivered for a *positive* fixture. MUST be 0. */
  deliveredObservationsFromPositives: number;
  /** Fixtures where prohibited content reached the sink. MUST be 0. */
  rawTextLeaks: number;
}

export interface ObservationRedTeamResult {
  suiteVersion: string;
  attachmentKind: 'red-team-observation';
  analysisVersion: string;
  claim: string;
  fixtureSetVersion: string;
  filterVersion: string;
  detectorVersion: string;
  fixtures: ObservationRedTeamFixtureResult[];
  summary: ObservationRedTeamSummary;
}

export interface RunObservationSuiteOptions {
  fixtures: readonly LoadedFixture[];
  detector?: OcrDetector;
  sink?: InstrumentedAdapterSink;
  /** Extra banned vocabulary forwarded to the §10.1 scan. */
  extraTokens?: string[];
}

/**
 * Deliver the observations an approved bundle would produce, into the sink.
 * Returns whether anything prohibited got through.
 */
function deliverApprovedBundle(
  fixture: LoadedFixture,
  sink: InstrumentedAdapterSink,
): { delivered: number; leaked: boolean } {
  let delivered = 0;
  let leaked = false;
  for (const asset of fixture.bundle.assets) {
    let image;
    try {
      image = decodePng(asset.bytes);
    } catch {
      // An approved bundle whose asset does not decode would be a filter bug:
      // the filter quarantines undecodable assets. Surface it as a leak-shaped
      // failure rather than swallowing it.
      leaked = true;
      continue;
    }
    const payload = payloadFromLuminance(image.luminance, image.width, image.height);
    const scenarioRef = `scn:${fixture.assetHash.slice('sha256:'.length, 'sha256:'.length + 16)}`;
    for (const recipient of ['baby-a', 'baby-b'] as const) {
      let observation: Observation;
      try {
        observation = buildObservation({
          runId: SUITE_RUN_ID,
          turn: 0,
          recipient,
          encoding: 'pixel',
          payload,
          scenarioRef,
        });
      } catch {
        // The §10.1 gate refused to build it: nothing was delivered, which is
        // the correct outcome, but it means the bundle should not have been
        // approved. Recorded as a leak-shaped failure for triage.
        leaked = true;
        continue;
      }
      sink.observe(fixture.definition.fixtureId, observation);
      delivered += 1;
      if (hygieneErrors(observation).length > 0) {
        leaked = true;
      }
      for (const [key, value] of Object.entries(observation)) {
        if (
          typeof value === 'string' &&
          !['runId', 'recipient', 'encoding', 'scenarioRef'].includes(key)
        ) {
          leaked = true;
        }
      }
    }
  }
  return { delivered, leaked };
}

/**
 * Run the complete suite. Pure apart from the injected sink: the same
 * fixtures and detector always produce byte-identical canonical JSON, so the
 * attachment hash is reproducible.
 */
export function runObservationRedTeamSuite(
  options: RunObservationSuiteOptions,
): ObservationRedTeamResult {
  if (options.fixtures.length === 0) {
    throw new RedTeamError('empty-suite', 'the observation suite needs at least one fixture');
  }
  const sink = options.sink ?? new InstrumentedAdapterSink();
  const results: ObservationRedTeamFixtureResult[] = [];
  let filterVersion = '';
  let detectorVersion = '';

  for (const fixture of options.fixtures) {
    const registration: ScenarioBundleRegistration = registerScenarioBundle(fixture.bundle, {
      ...(options.detector === undefined ? {} : { detector: options.detector }),
      ...(options.extraTokens === undefined ? {} : { extraTokens: options.extraTokens }),
      // See the module doc comment: the language scan, not the presence rule,
      // must be what decides the filename and caption fixtures.
      allowFileNames: true,
      allowCaptions: true,
    });
    filterVersion = registration.filterVersion;
    detectorVersion = registration.detectorVersion;

    const delivery =
      registration.status === 'approved'
        ? deliverApprovedBundle(fixture, sink)
        : { delivered: 0, leaked: false };

    const detectorFinding = registration.findings.find(
      (finding) => finding.reason === 'ocr-text-detected',
    );
    const result: ObservationRedTeamFixtureResult = {
      fixtureId: fixture.definition.fixtureId,
      category: fixture.definition.category,
      expected: fixture.definition.expected,
      observed: registration.status,
      agreesWithExpectation: registration.status === fixture.definition.expected,
      reasonCodes: [...registration.reasonCodes],
      assetHashes: registration.assets.map((asset) => asset.assetHash),
      bundleHash: registration.bundleHash,
      deliveredObservationCount: delivery.delivered,
      rawTextReachedAdapter: delivery.leaked,
    };
    if (fixture.definition.plantedText !== undefined) {
      result.plantedTextHash = hashUtf8(fixture.definition.plantedText);
    }
    if (detectorFinding?.score !== undefined) {
      result.detectorScore = detectorFinding.score;
    }
    results.push(result);
  }

  const positives = results.filter((entry) => entry.expected === 'quarantined');
  const negatives = results.filter((entry) => entry.expected === 'approved');
  const falseNegatives = positives.filter((entry) => entry.observed === 'approved');
  const falsePositives = negatives.filter((entry) => entry.observed === 'quarantined');

  const summary: ObservationRedTeamSummary = {
    total: results.length,
    positives: positives.length,
    negatives: negatives.length,
    quarantined: results.filter((entry) => entry.observed === 'quarantined').length,
    approved: results.filter((entry) => entry.observed === 'approved').length,
    truePositives: positives.length - falseNegatives.length,
    falseNegatives: falseNegatives.length,
    trueNegatives: negatives.length - falsePositives.length,
    falsePositives: falsePositives.length,
    falseNegativeFixtureIds: falseNegatives.map((entry) => entry.fixtureId),
    falsePositiveFixtureIds: falsePositives.map((entry) => entry.fixtureId),
    deliveredObservations: results.reduce(
      (total, entry) => total + entry.deliveredObservationCount,
      0,
    ),
    deliveredObservationsFromPositives: positives.reduce(
      (total, entry) => total + entry.deliveredObservationCount,
      0,
    ),
    rawTextLeaks: results.filter((entry) => entry.rawTextReachedAdapter).length,
  };

  return {
    suiteVersion: OBSERVATION_SUITE_VERSION,
    attachmentKind: 'red-team-observation',
    analysisVersion: OBSERVATION_SUITE_VERSION,
    claim: OBSERVATION_SUITE_CLAIM,
    fixtureSetVersion: FIXTURE_SET_VERSION,
    filterVersion,
    detectorVersion,
    fixtures: results,
    summary,
  };
}
