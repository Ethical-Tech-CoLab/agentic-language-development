/**
 * Expected runtime-schema exports. The schema-drift test fails if a schema
 * disappears from `schemaRegistry` without this manifest changing too
 * (BACKLOG ALD-002). SPEC §11 shapes come first; integrity-chain shapes
 * (LEDGER §7, §8, §10, §13) follow.
 */
export const EXPECTED_SCHEMA_EXPORTS = [
  'RunConfigSchema',
  'ObservationSchema',
  'AgentActionProposalSchema',
  'TurnProposalEnvelopeSchema',
  'LedgerDraftEnvelopeSchema',
  'DeliveredChannelArtifactSchema',
  'AffectStateMeasurementSchema',
  'LedgerEventSchema',
  'ChannelEventSchema',
  'AffectEventSchema',
  'CheckpointManifestReferenceSchema',
  'AnchorReceiptReferenceSchema',
  'ExperimentRecordSchema',
  'VerificationReportSchema',
  'TreeReferenceSchema',
  'UnsignedCheckpointManifestSchema',
  'CheckpointManifestSchema',
  'RunManifestSchema',
  'AnchorReceiptSchema',
  'InclusionProofSchema',
  'ConsistencyProofSchema',
  'TurnRecordSchema',
  'InterventionEventSchema',
  'AuditLedgerEntrySchema',
  'ExperimentRecordFileSchema',
  'RegistrationClassSchema',
  'CurriculumStageSchema',
  'InterventionPlanSchema',
  'AffectDisplayIdSchema',
  'PreRegistrationArtifactSchema',
  'PreRegistrationBindingSchema',
  'BundleAttachmentSchema',
  'BundleAttachmentIndexSchema',
] as const;

export type SchemaExportName = (typeof EXPECTED_SCHEMA_EXPORTS)[number];
