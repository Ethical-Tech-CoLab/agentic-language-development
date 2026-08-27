export * from './dtsf.js';
export * from './schema-manifest.js';
export * from './schemas.js';

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
import type { SchemaExportName } from './schema-manifest.js';

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
} satisfies Record<SchemaExportName, unknown>;
