/**
 * ALD-040/ALD-068 acceptance coverage for the committed observation attack
 * corpus and the reusable side-channel measurement primitives.
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  InstrumentedAdapterSink,
  errorShapeWithinTolerance,
  loadObservationFixtures,
  measureErrorShape,
  measureSizeChannel,
  measureTimingChannel,
  runObservationRedTeamSuite,
  verifyCommittedFixtures,
  withinTolerance,
} from '../src/index.js';

const FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../fixtures/', import.meta.url),
);

describe('ALD-068 committed observation red-team corpus', () => {
  it('matches every committed fixture to its manifest hash', () => {
    const verification = verifyCommittedFixtures(FIXTURE_DIRECTORY);
    expect(verification.length).toBeGreaterThan(20);
    expect(verification.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('quarantines every attack, approves every control, and leaks no text', () => {
    const sink = new InstrumentedAdapterSink();
    const result = runObservationRedTeamSuite({
      fixtures: loadObservationFixtures(FIXTURE_DIRECTORY),
      sink,
    });

    expect(result.attachmentKind).toBe('red-team-observation');
    expect(result.summary.falseNegativeFixtureIds).toEqual([]);
    expect(result.summary.falsePositiveFixtureIds).toEqual([]);
    expect(result.summary.deliveredObservationsFromPositives).toBe(0);
    expect(result.summary.rawTextLeaks).toBe(0);
    expect(sink.records).toHaveLength(result.summary.deliveredObservations);
    expect(sink.records.length).toBeGreaterThan(0);
  });

  it('is byte-deterministic for the same committed fixture set', () => {
    const fixtures = loadObservationFixtures(FIXTURE_DIRECTORY);
    expect(JSON.stringify(runObservationRedTeamSuite({ fixtures }))).toBe(
      JSON.stringify(runObservationRedTeamSuite({ fixtures })),
    );
  });
});

describe('ALD-040 side-channel measurement primitives', () => {
  it('passes identical timing and size profiles and fails distinguishable ones', () => {
    const timing = measureTimingChannel([
      { label: 'accepted', durationMs: 100 },
      { label: 'accepted', durationMs: 101 },
      { label: 'rejected', durationMs: 100 },
      { label: 'rejected', durationMs: 101 },
    ]);
    expect(
      withinTolerance(timing, {
        maxAbsoluteMeanDifference: 0,
        maxAbsoluteCohensD: 0,
        maxKsDistance: 0,
      }).withinTolerance,
    ).toBe(true);

    const size = measureSizeChannel([
      { label: 'accepted', sizeBytes: 128 },
      { label: 'accepted', sizeBytes: 128 },
      { label: 'rejected', sizeBytes: 32 },
      { label: 'rejected', sizeBytes: 32 },
    ]);
    expect(
      withinTolerance(size, { maxAbsoluteMeanDifference: 0 }),
    ).toMatchObject({ withinTolerance: false });
  });

  it('detects byte-level error-envelope variation without storing bodies', () => {
    const normalized = measureErrorShape([
      { label: 'accepted', body: '{"status":"complete"}' },
      { label: 'rejected', body: '{"status":"complete"}' },
    ]);
    expect(errorShapeWithinTolerance(normalized).withinTolerance).toBe(true);

    const leaking = measureErrorShape([
      { label: 'accepted', body: '{"status":"accepted"}' },
      { label: 'rejected', body: '{"status":"rejected"}' },
    ]);
    expect(errorShapeWithinTolerance(leaking)).toMatchObject({
      withinTolerance: false,
      violations: expect.arrayContaining(['bodies-differ', 'label-recoverable']),
    });
    expect(JSON.stringify(leaking)).not.toContain('status');
  });
});
