import type { EvidenceWriter } from '@ald/types';

/** Only the asynchronous writes the Gateway may request of the Evidence Store. */
export type GatewayEvidencePort = Pick<
  EvidenceWriter,
  | 'commitTurn'
  | 'commitRejection'
  | 'commitControlArtifact'
  | 'appendLedgerEvent'
  | 'appendInterventionEvent'
  | 'appendAffectEvent'
>;

/** The request may have committed, but the writer's response was not confirmed. */
export class EvidenceWriteUncertainError extends Error {
  readonly code = 'evidence-write-uncertain';

  constructor() {
    super('evidence write outcome is uncertain; this run cannot continue');
    this.name = 'EvidenceWriteUncertainError';
  }
}
