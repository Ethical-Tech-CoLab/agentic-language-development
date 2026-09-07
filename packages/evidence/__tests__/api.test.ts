/**
 * ALD-010 criterion 3 regression guard: the package must not expose any
 * function that writes an event table other than `SqliteEvidenceWriter`.
 * Every SQL statement against the event tables lives in `src/writer.ts` and
 * is private to it; this test fails if a new raw-SQL helper is exported.
 */
import { describe, expect, it } from 'vitest';

import * as evidence from '../src/index.js';

const EXPECTED_EXPORTS = [
  'CheckpointChainError',
  'DuplicateEventError',
  'DuplicateRunError',
  'EvidenceWriterError',
  'ExperimentRecordVersionError',
  'ForkDetectedError',
  'IntegrityBlockedError',
  'InterpretationBindingError',
  'InvalidRequestError',
  'LEDGER_EVENT_TYPES',
  'SqliteEvidenceWriter',
  'UnknownRunError',
  'applyMigrations',
  'buildRunManifest',
  'canonicalizeJson',
  'deserializeUnsignedLedgerEvent',
  'exportRunBundle',
  'isLedgerEventType',
  'migrations',
  'openEvidenceDatabase',
  'parseCanonicalJson',
  'serializeUnsignedLedgerEvent',
  'validateLedgerEventDraft',
];

describe('public API surface', () => {
  it('exports exactly the curated runtime symbols', () => {
    expect(Object.keys(evidence).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it('routes every event-table write through the writer class', () => {
    const writeMethods = [
      'registerRun',
      'commitTurn',
      'commitRejection',
      'commitControlArtifact',
      'appendLedgerEvent',
      'appendTurnRecord',
      'appendInterventionEvent',
      'appendAuditLedgerEntry',
      'appendAffectEvent',
      'insertCheckpointManifest',
      'insertAnchorReceipt',
      'appendExperimentRecord',
      'acknowledgeIntegrityReview',
    ];
    for (const method of writeMethods) {
      expect(
        typeof (evidence.SqliteEvidenceWriter.prototype as Record<string, unknown>)[
          method
        ],
      ).toBe('function');
    }
  });
});
