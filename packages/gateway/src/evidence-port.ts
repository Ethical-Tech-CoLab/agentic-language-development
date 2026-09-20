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
