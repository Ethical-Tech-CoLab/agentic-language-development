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
] as const;

export type SchemaExportName = (typeof EXPECTED_SCHEMA_EXPORTS)[number];
