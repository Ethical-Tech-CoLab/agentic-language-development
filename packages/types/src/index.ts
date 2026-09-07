export * from './contracts.js';
export * from './domains.js';
export * from './dtsf.js';
export * from './schema-manifest.js';
export * from './schemas-integrity.js';
export * from './schemas.js';

import type { SchemaExportName } from './schema-manifest.js';
import {
  AnchorReceiptSchema,
  AuditLedgerEntrySchema,
  CheckpointManifestSchema,
  ConsistencyProofSchema,
  ExperimentRecordFileSchema,
  InclusionProofSchema,
  InterventionEventSchema,
  RunManifestSchema,
  TreeReferenceSchema,
  TurnRecordSchema,
  UnsignedCheckpointManifestSchema,
} from './schemas-integrity.js';
import {
  AffectEventSchema,
  AffectStateMeasurementSchema,
  AgentActionProposalSchema,
  AnchorReceiptReferenceSchema,
  ChannelEventSchema,
  CheckpointManifestReferenceSchema,
  DeliveredChannelArtifactSchema,
  ExperimentRecordSchema,
  LedgerDraftEnvelopeSchema,
  LedgerEventSchema,
  ObservationSchema,
  RunConfigSchema,
  TurnProposalEnvelopeSchema,
  VerificationReportSchema,
} from './schemas.js';

export const schemaRegistry = {
  RunConfigSchema,
  ObservationSchema,
  AgentActionProposalSchema,
  TurnProposalEnvelopeSchema,
  LedgerDraftEnvelopeSchema,
  DeliveredChannelArtifactSchema,
  AffectStateMeasurementSchema,
  LedgerEventSchema,
  ChannelEventSchema,
  AffectEventSchema,
  CheckpointManifestReferenceSchema,
  AnchorReceiptReferenceSchema,
  ExperimentRecordSchema,
  VerificationReportSchema,
  TreeReferenceSchema,
  UnsignedCheckpointManifestSchema,
  CheckpointManifestSchema,
  RunManifestSchema,
  AnchorReceiptSchema,
  InclusionProofSchema,
  ConsistencyProofSchema,
  TurnRecordSchema,
  InterventionEventSchema,
  AuditLedgerEntrySchema,
  ExperimentRecordFileSchema,
} satisfies Record<SchemaExportName, unknown>;
