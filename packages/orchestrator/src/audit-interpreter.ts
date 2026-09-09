/**
 * Delayed, batch-only human audit-ledger interpretation (SPEC §13.6;
 * BACKLOG ALD-064).
 *
 * This service reads signed agent-native ledger events and can append only to
 * the separately signed `audit` stream. It has no adapter, Gateway, or Baby
 * route dependency, so its generated text cannot become learner feedback.
 */
import {
  LedgerEventSchema,
  UnsignedAuditLedgerEntrySchema,
  type AuditInterpretationBatchRequest,
  type AuditLedgerEntry,
  type EvidenceWriter,
} from '@ald/types';

/** A source must have one fully completed later turn before interpretation. */
export const AUDIT_INTERPRETATION_DELAY_TURNS = 1;

export type AuditInterpreterErrorCode =
  | 'empty-batch'
  | 'invalid-interpreter-version'
  | 'invalid-source'
  | 'source-not-eligible';

export class AuditInterpreterError extends Error {
  constructor(
    readonly code: AuditInterpreterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuditInterpreterError';
  }
}

export class AuditLedgerInterpreter {
  constructor(
    private readonly evidence: EvidenceWriter,
    private readonly delayTurns = AUDIT_INTERPRETATION_DELAY_TURNS,
  ) {
    if (!Number.isInteger(delayTurns) || delayTurns < 1) {
      throw new RangeError('Audit interpretation delay must be a positive integer');
    }
  }

  /**
   * Validates the complete batch before writing its first entry. `nextTurn`
   * is the runtime's authoritative next turn index, never caller input.
   */
  async appendBatch(
    request: AuditInterpretationBatchRequest,
    nextTurn: number,
  ): Promise<AuditLedgerEntry[]> {
    if (request.entries.length === 0) {
      throw new AuditInterpreterError(
        'empty-batch',
        'Audit interpretation batches must contain at least one entry',
      );
    }
    if (request.interpreterVersion.trim().length === 0) {
      throw new AuditInterpreterError(
        'invalid-interpreter-version',
        'Audit interpreter version must not be empty',
      );
    }

    const eligibleThroughTurn = nextTurn - 1 - this.delayTurns;
    for (const draft of request.entries) {
      UnsignedAuditLedgerEntrySchema.shape.content.parse(draft.content);
      const stream =
        draft.babyId === 'A' ? 'baby-a-ledger' : 'baby-b-ledger';
      const source = this.evidence
        .readEvents(request.runId, stream)
        .find((event) => event.entryHash === draft.sourceEntryHash);
      if (source === undefined) {
        throw new AuditInterpreterError(
          'invalid-source',
          `Audit source ${draft.sourceEntryHash} is not present in ${stream}`,
        );
      }
      const event = LedgerEventSchema.parse(JSON.parse(source.canonicalJson));
      if (event.contentSchema !== 'agent-native-ledger') {
        throw new AuditInterpreterError(
          'invalid-source',
          `Audit source ${draft.sourceEntryHash} is not agent-native ledger state`,
        );
      }
      if (event.turn > eligibleThroughTurn) {
        throw new AuditInterpreterError(
          'source-not-eligible',
          `Audit source ${draft.sourceEntryHash} from turn ${String(event.turn)} ` +
            `is not eligible through turn ${String(eligibleThroughTurn)}`,
        );
      }
    }

    const appended: AuditLedgerEntry[] = [];
    for (const draft of request.entries) {
      appended.push(
        await this.evidence.appendAuditLedgerEntry({
          runId: request.runId,
          babyId: draft.babyId,
          sourceEntryHash: draft.sourceEntryHash,
          interpreterVersion: request.interpreterVersion,
          content: draft.content,
        }),
      );
    }
    return appended;
  }
}
