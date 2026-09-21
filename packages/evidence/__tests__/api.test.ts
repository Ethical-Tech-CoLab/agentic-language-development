/**
 * ALD-010 criterion 3 regression guard: every SQL statement against event
 * tables remains private to `SqliteEvidenceWriter`. The Controller RPC only
 * dispatches an allowlisted method to that writer; no raw-SQL helper is public.
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
  'connectControllerEvidenceRpc',
  'createControllerEvidenceRpcServer',
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
