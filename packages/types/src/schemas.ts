import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const hashString = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/iu);
const signatureString = z.string().min(16);
const isoDateTime = z.iso.datetime({ offset: true });

export const LearnerTrackIdSchema = z.enum([
  'frozen-llm',
  'scratch-rl',
  'self-supervised',
  'hybrid',
  'no-learning',
]);

export const LearningSignalSchema = z.enum([
  'none',
  'extrinsic-task',
  'intrinsic-social-influence',
  'intrinsic-curiosity',
  'intrinsic-prediction-progress',
  'intrinsic-giddiness',
  'self-supervised',
]);

export const CommunicationConditionSchema = z.enum([
  'normal',
  'disabled',
  'constant',
  'random',
  'shuffled',
  'oracle',
]);

export const InteractionModeSchema = z.enum([
  'cooperative-signaling',
  'asymmetric-information',
  'semi-cooperative-negotiation',
  'conflicting-negotiation',
  'no-agreement-control',
]);

export const CarrierModeSchema = z.enum([
  'fixed-token',
  'fixed-glyph',
  'generative-bitmap',
  'generative-canvas',
  'generative-tone',
]);

export const AffectModeSchema = z.enum([
  'none',
  'declared',
  'permuted',
  'opaque',
  'derived',
  'emergent',
]);

/** SPEC §18 `registrationClass`-adjacent: how a run is labeled for §15.1 binding. */
export const RegistrationClassSchema = z.enum(['qualification', 'confirmatory']);

/**
 * One pre-registered developmental stage (EXPERIMENT-NOTEBOOK.md E22,
 * SPEC §18 `curriculumMode: fixed-schedule`). Stages are applied by the
 * runtime at `startTurn`; adapters that cannot honour a knob must reject the
 * stage, never ignore it silently.
 */
export const CurriculumStageSchema = z
  .object({
    stageIndex: nonNegativeInteger,
    startTurn: nonNegativeInteger,
    learnerOptions: z
      .object({
        learningRate: z.number().positive().optional(),
        temperature: z.number().positive().optional(),
        explorationRate: z.number().min(0).max(1).optional(),
        memoryCapacity: positiveInteger.optional(),
      })
      .strict()
      .optional(),
    /** Staged carrier bandwidth (E22); never above the run's own ceiling. */
    maxSymbolsPerMessage: z.number().int().min(1).max(16).optional(),
    /** A consolidation interval: no policy updates while the stage is active. */
    consolidation: z.boolean().optional(),
  })
  .strict();

/**
 * Pre-registered intervention configuration (SPEC §15.2, §18; BACKLOG
 * ALD-072). Every toggle here is part of the hashed RunConfig, so turning an
 * intervention on or off is a pre-registered configuration change, never a
 * code change.
 */
export const InterventionPlanSchema = z
  .object({
    version: z.literal(1),
    /** §15.2 mandatory suite, run during `evaluating`. */
    evaluationSuite: z
      .object({
        ablation: z.boolean(),
        substitution: z.boolean(),
        /** Offline analysis only (§15.2); never applied to a live delivery. */
        scramblingControl: z.boolean(),
        /** Fraction of evaluation turns that carry a live probe. */
        probeShare: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    /** E14: one bounded extra turn after a failed episode, same carrier capacity. */
    repair: z
      .object({ enabled: z.boolean(), maxExtraTurns: z.literal(1) })
      .strict()
      .optional(),
    /** E15: type codes held out of training and evaluated separately. */
    heldOutTypeCodes: z.array(nonNegativeInteger).optional(),
    /** E22: fixed developmental schedule. */
    curriculum: z
      .object({ stages: z.array(CurriculumStageSchema).min(1) })
      .strict()
      .optional(),
    /** E31: turns between frozen drift evaluations inside one run. */
    driftEvaluationInterval: positiveInteger.optional(),
  })
  .strict();

const learnerConfigSchema = z.object({
  track: LearnerTrackIdSchema,
  modelRef: nonEmptyString,
  initialPolicyRef: nonEmptyString.optional(),
  trainingIsolation: z.enum(['independent', 'centralized']),
});

export const RunConfigSchema = z
  .object({
    version: z.literal(1),
    runId: nonEmptyString,
    parentRunId: nonEmptyString.optional(),
    derivedFromCheckpointHash: hashString.optional(),
    deploymentMode: z.enum(['prototype', 'research-grade']),
    babyA: learnerConfigSchema,
    babyB: learnerConfigSchema,
    symmetricTracks: z.boolean(),
    learningSignal: LearningSignalSchema,
    communicationCondition: CommunicationConditionSchema,
    interactionMode: InteractionModeSchema,
    carrierMode: CarrierModeSchema,
    symbolInventorySize: z.number().int().min(2).max(256).optional(),
    maxSymbolsPerMessage: z.number().int().min(1).max(16).optional(),
    maxStrokes: z.number().int().min(1).max(64).optional(),
    affectMode: AffectModeSchema,
    affectWindowSchedule: nonEmptyString,
    observationEncoding: z.enum([
      'opaque-numeric',
      'pixel',
      'hybrid-features',
    ]),
    roleReversalPeriod: positiveInteger,
    turnResponseBudgetMs: z.number().int().min(1_000),
    maxTurnsPerRun: positiveInteger,
    evaluationTurns: positiveInteger.optional(), // evaluation-phase budget; runtime default 200
    maxConsecutiveRejections: positiveInteger,
    ledgerLagTurns: z.number().int().min(0).max(2),
    curriculumMode: z.enum(['fixed-schedule', 'adaptive-guided']),
    cipherThreatModel: z.enum([
      'post-run-disclosure',
      'external-observer-only',
      'novelty-only',
    ]),
    interventionSuiteThreshold: z.number().min(0).max(1),
    evaluationSeeds: positiveInteger,
    checkpointEventInterval: positiveInteger,
    checkpointTimeIntervalMs: z.number().int().min(1_000),
    anchorNetwork: z.enum(['base-sepolia', 'base-mainnet']),
    finalityPolicy: nonEmptyString,
    prototypeRetentionDays: nonNegativeInteger,
    scenarioBundleHash: hashString,
    promptBundleHash: hashString,
    protocolGitCommit: nonEmptyString,
    preRegistrationHash: hashString,
    randomSeed: nonEmptyString,
    experimentId: z.string().regex(/^E\d{2}$/u),
    /** SPEC §15.1: absent means `qualification` (non-confirmatory). */
    registrationClass: RegistrationClassSchema.optional(),
    /** SPEC §15.2 / §18: pre-registered interventions (ALD-072). */
    interventionPlan: InterventionPlanSchema.optional(),
    /** SPEC §9.2: hash of the frozen unfamiliar-glyph bundle (`fixed-glyph` only). */
    glyphBundleHash: hashString.optional(),
    /** SPEC §9.3 `derived`: name of the fixed pre-registered measurement→display mapping. */
    affectDerivedMapping: nonEmptyString.optional(),
  })
  .superRefine((config, context) => {
    const derivedFields = [
      config.parentRunId,
      config.derivedFromCheckpointHash,
      config.babyA.initialPolicyRef,
      config.babyB.initialPolicyRef,
    ];
    const populatedDerivedFields = derivedFields.filter(
      (value) => value !== undefined,
    ).length;

    if (populatedDerivedFields !== 0 && populatedDerivedFields !== derivedFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['parentRunId'],
        message:
          'Derived runs require parentRunId, derivedFromCheckpointHash, and both initialPolicyRef values',
      });
    }

    if (config.communicationCondition === 'oracle' && config.experimentId !== 'E03') {
      context.addIssue({
        code: 'custom',
        path: ['communicationCondition'],
        message: 'The oracle communication condition is restricted to E03',
      });
    }

    for (const [field, learner] of [
      ['babyA', config.babyA],
      ['babyB', config.babyB],
    ] as const) {
      if (
        (learner.track === 'no-learning' || learner.track === 'frozen-llm') &&
        config.learningSignal !== 'none'
      ) {
        context.addIssue({
          code: 'custom',
          path: [field, 'track'],
          message: `${learner.track} requires learningSignal "none"`,
        });
      }

      if (
        learner.track === 'scratch-rl' &&
        ![
          'extrinsic-task',
          'intrinsic-social-influence',
          'intrinsic-curiosity',
          'intrinsic-prediction-progress',
          'intrinsic-giddiness',
        ].includes(config.learningSignal)
      ) {
        context.addIssue({
          code: 'custom',
          path: [field, 'track'],
          message: 'scratch-rl requires an extrinsic or intrinsic learning signal',
        });
      }

      if (
        learner.track === 'self-supervised' &&
        config.learningSignal !== 'self-supervised'
      ) {
        context.addIssue({
          code: 'custom',
          path: [field, 'track'],
          message: 'self-supervised requires learningSignal "self-supervised"',
        });
      }
    }
  });

const numericVector = z.array(z.number());
const numericMatrix = z.array(numericVector);

export const ObservationSchema = z.object({
  runId: nonEmptyString,
  turn: nonNegativeInteger,
  recipient: z.enum(['baby-a', 'baby-b']),
  encoding: z.enum(['opaque-numeric', 'pixel', 'hybrid-features']),
  payload: z.union([numericVector, numericMatrix]),
  scenarioRef: nonEmptyString,
});

export const StrokeSchema = z.object({
  startX: z.number().int().min(0).max(15),
  startY: z.number().int().min(0).max(15),
  endX: z.number().int().min(0).max(15),
  endY: z.number().int().min(0).max(15),
  width: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const BitmapProposalSchema = z.object({
  bits: z.array(z.union([z.literal(0), z.literal(1)])).length(256),
});

export const ToneProposalSchema = z.object({
  tones: z
    .array(
      z.object({
        pitchBin: z.number().int().min(0).max(7),
        durationBin: z.number().int().min(1).max(4),
      }),
    )
    .max(8),
});

export const AffectDisplayIdSchema = z.enum(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);

/** Tool names a Baby may call (SPEC §6.3), in declaration order. */
export const AGENT_ACTION_KINDS = [
  'emit_symbols',
  'emit_glyphs',
  'emit_bitmap',
  'emit_canvas',
  'emit_tones',
  'select_object',
  'perform_action',
  'submit_affect',
] as const;

export type AgentActionKind = (typeof AGENT_ACTION_KINDS)[number];

/**
 * SPEC §11.3 discriminated by `kind`. Each variant is spelled out with a
 * literal discriminant so `proposal.kind === 'select_object'` narrows
 * `publicArtifact` for consumers.
 */
export const AgentActionProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('emit_symbols'),
    publicArtifact: z.object({
      symbols: z.array(nonEmptyString).min(1).max(16),
    }),
  }),
  z.object({
    kind: z.literal('emit_glyphs'),
    publicArtifact: z.object({
      glyphs: z.array(nonEmptyString).min(1).max(16),
    }),
  }),
  z.object({
    kind: z.literal('emit_bitmap'),
    publicArtifact: z.object({ bitmap: BitmapProposalSchema }),
  }),
  z.object({
    kind: z.literal('emit_canvas'),
    publicArtifact: z.object({
      strokes: z.array(StrokeSchema).min(1).max(64),
    }),
  }),
  z.object({
    kind: z.literal('emit_tones'),
    publicArtifact: z.object({ tones: ToneProposalSchema }),
  }),
  z.object({
    kind: z.literal('select_object'),
    publicArtifact: z.object({ objectRef: nonEmptyString }),
  }),
  z.object({
    kind: z.literal('perform_action'),
    publicArtifact: z.object({ actionRef: nonEmptyString }),
  }),
  z.object({
    kind: z.literal('submit_affect'),
    publicArtifact: z.object({ displayId: AffectDisplayIdSchema }),
  }),
]);

export const LedgerEventDraftSchema = z.object({
  eventType: nonEmptyString,
  contentSchema: z.enum(['human-audit-ledger', 'agent-native-ledger']),
  subjectId: nonEmptyString,
  content: z.record(z.string(), z.unknown()),
  blindingNonce: nonEmptyString,
  evidenceRefs: z.array(nonEmptyString).default([]),
});

export const UnsignedLedgerEventSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  babyId: z.enum(['A', 'B']),
  sequence: positiveInteger,
  turn: nonNegativeInteger,
  eventType: nonEmptyString,
  contentSchema: z.enum(['human-audit-ledger', 'agent-native-ledger']),
  subjectId: nonEmptyString,
  content: z.record(z.string(), z.unknown()),
  blindingNonce: nonEmptyString,
  previousEntryHash: hashString,
  channelEventHash: hashString.optional(),
  recordedAt: isoDateTime,
  writerKeyId: nonEmptyString,
});

export const TurnProposalEnvelopeSchema = z.object({
  proposal: AgentActionProposalSchema,
  privateLedgerDraft: LedgerEventDraftSchema,
});

export const LedgerDraftEnvelopeSchema = z.object({
  channelEventHash: hashString,
  privateLedgerDraft: LedgerEventDraftSchema,
});

export const DeliveredChannelArtifactSchema = z.object({
  runId: nonEmptyString,
  turn: nonNegativeInteger,
  logicalSender: z.enum(['baby-a', 'baby-b']),
  carrier: CarrierModeSchema,
  publicArtifact: z.record(z.string(), z.unknown()),
  channelEventHash: hashString,
});

export const AffectStateMeasurementSchema = z.object({
  measurementVersion: nonEmptyString,
  scores: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
});

export const LedgerEventSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  babyId: z.enum(['A', 'B']),
  sequence: positiveInteger,
  turn: nonNegativeInteger,
  eventType: nonEmptyString,
  contentSchema: z.enum(['human-audit-ledger', 'agent-native-ledger']),
  subjectId: nonEmptyString,
  content: z.record(z.string(), z.unknown()),
  blindingNonce: nonEmptyString,
  previousEntryHash: hashString,
  channelEventHash: hashString.optional(),
  recordedAt: isoDateTime,
  writerKeyId: nonEmptyString,
  entryHash: hashString,
  writerSignature: signatureString,
});

const deliveryReceiptSchema = z.object({
  recipient: z.enum(['baby-a', 'baby-b']),
  deliveredArtifactHash: hashString,
  deliveredAt: isoDateTime,
});

export const ChannelEventSchema = z
  .object({
    version: z.literal(1),
    runId: nonEmptyString,
    sequence: positiveInteger,
    turn: nonNegativeInteger,
    logicalSender: z.enum(['baby-a', 'baby-b']),
    origin: z.enum(['baby', 'gateway-control']),
    carrier: CarrierModeSchema,
    communicationCondition: CommunicationConditionSchema,
    babyProposalHash: hashString.optional(),
    senderLedgerSequence: positiveInteger.optional(),
    senderEntryHash: hashString.optional(),
    publicArtifactHash: hashString,
    previousChannelHash: hashString,
    gatewayValidationResult: z.enum(['accepted', 'rejected']),
    reasonCode: nonEmptyString.optional(),
    deliveryReceipt: deliveryReceiptSchema.optional(),
    recordedAt: isoDateTime,
    writerKeyId: nonEmptyString,
    entryHash: hashString,
    writerSignature: signatureString,
  })
  .superRefine((event, context) => {
    if (event.gatewayValidationResult === 'rejected' && !event.reasonCode) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'Rejected channel events require a reasonCode',
      });
    }

    if (
      event.gatewayValidationResult === 'accepted' &&
      event.origin === 'baby' &&
      event.communicationCondition !== 'disabled' &&
      (!event.babyProposalHash ||
        !event.senderLedgerSequence ||
        !event.senderEntryHash ||
        !event.deliveryReceipt)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Accepted Baby-originated deliveries require proposal, ledger, and delivery bindings',
      });
    }
  });

export const AffectEventSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  sequence: positiveInteger,
  turn: nonNegativeInteger,
  windowId: nonEmptyString,
  sender: z.enum(['baby-a', 'baby-b']),
  displayId: AffectDisplayIdSchema,
  affectMode: z.enum(['declared', 'permuted', 'opaque', 'derived']),
  deliveredAt: isoDateTime,
  previousEntryHash: hashString,
  recordedAt: isoDateTime,
  writerKeyId: nonEmptyString,
  entryHash: hashString,
  writerSignature: signatureString,
});

const treeReferenceSchema = z.object({
  treeSize: nonNegativeInteger,
  merkleRoot: hashString,
  lastEntryHash: hashString,
});

export const CheckpointManifestReferenceSchema = z.object({
  checkpointSequence: nonNegativeInteger,
  checkpointHash: hashString,
  previousCheckpointHash: hashString,
  trees: z.record(z.string(), treeReferenceSchema),
  witnessKeyId: nonEmptyString,
  witnessSignature: signatureString,
});

export const AnchorReceiptReferenceSchema = z.object({
  checkpointHash: hashString,
  chainId: positiveInteger,
  transactionHash: z.string().regex(/^0x[a-f0-9]{64}$/iu),
  blockNumber: nonNegativeInteger,
  blockHash: z.string().regex(/^0x[a-f0-9]{64}$/iu),
  status: z.enum(['submitted', 'confirmed', 'failed']),
  finalityPolicy: nonEmptyString,
});

export const ExperimentRecordSchema = z.object({
  version: z.literal(1),
  recordVersion: positiveInteger,
  runId: nonEmptyString,
  experimentId: z.string().regex(/^E\d{2}$/u),
  deploymentMode: z.enum(['prototype', 'research-grade']),
  learnerContractVersion: nonEmptyString,
  runConfigRef: hashString,
  protocolGitCommit: nonEmptyString,
  preRegistrationHash: hashString,
  disposition: z.enum(['valid', 'invalid', 'aborted']),
  checkpointManifestRef: hashString,
  anchorTxRef: z.string().regex(/^0x[a-f0-9]{64}$/iu),
  verifierReportRef: nonEmptyString,
  claimBoundaryStatement: nonEmptyString,
  deviations: z.array(nonEmptyString),
});

const verificationChecksSchema = z.object({
  canonicalJsonValid: z.boolean(),
  sequencesStrictlyIncreasing: z.boolean(),
  entryHashesRebuilt: z.boolean(),
  previousEntryLinksValid: z.boolean(),
  writerSignaturesValid: z.boolean(),
  merkleRootsRebuilt: z.boolean(),
  inclusionProofsValid: z.boolean(),
  consistencyProofsValid: z.boolean(),
  checkpointHashesRebuilt: z.boolean(),
  witnessSignaturesValid: z.boolean(),
  anchorTxConfirmed: z.boolean(),
  anchorChainIdMatches: z.boolean(),
  unanchoredTailReported: z.boolean(),
});

export const VerificationReportSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  checkedAt: isoDateTime,
  verifierVersion: nonEmptyString,
  checks: verificationChecksSchema,
  gaps: z.array(nonEmptyString),
  forks: z.array(nonEmptyString),
  finalVerifiedSizes: z.record(z.string(), nonNegativeInteger),
  exitCode: z.union([z.literal(0), z.literal(1)]),
});

export type LearnerTrackId = z.infer<typeof LearnerTrackIdSchema>;
export type RegistrationClass = z.infer<typeof RegistrationClassSchema>;
export type CurriculumStage = z.infer<typeof CurriculumStageSchema>;
export type InterventionPlan = z.infer<typeof InterventionPlanSchema>;
export type AffectDisplayId = z.infer<typeof AffectDisplayIdSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type AgentActionProposal = z.infer<typeof AgentActionProposalSchema>;
export type LedgerEventDraft = z.infer<typeof LedgerEventDraftSchema>;
export type UnsignedLedgerEvent = z.infer<typeof UnsignedLedgerEventSchema>;
export type TurnProposalEnvelope = z.infer<typeof TurnProposalEnvelopeSchema>;
export type LedgerDraftEnvelope = z.infer<typeof LedgerDraftEnvelopeSchema>;
export type DeliveredChannelArtifact = z.infer<
  typeof DeliveredChannelArtifactSchema
>;
export type AffectStateMeasurement = z.infer<
  typeof AffectStateMeasurementSchema
>;
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;
export type AffectEvent = z.infer<typeof AffectEventSchema>;
export type CheckpointManifestReference = z.infer<
  typeof CheckpointManifestReferenceSchema
>;
export type AnchorReceiptReference = z.infer<
  typeof AnchorReceiptReferenceSchema
>;
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
