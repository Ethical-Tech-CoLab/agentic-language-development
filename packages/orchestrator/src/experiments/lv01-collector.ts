/**
 * LV01 stage collector (R05.2b-ii).
 *
 * Pure front half: workload resolution, packet-bound slot seeds, the
 * offline scheduled branch-target lookup, treatment-case construction, and
 * paired-case preparation. The executor runs one paired case for real: create each
 * planned branch run, step its single turn-0 evaluation, live-gate the
 * treatment delivery against the committed slice, and export the branch
 * bundles. The slot collector derives everything from the sealed parent
 * bundle (checkpoint, policy refs, native ledger index), commits the
 * treatment batch before any branch runs, and self-audits the case through
 * the independent loader + auditor before reporting it valid. The stage
 * walk journals every transition; audit replays every valid slot from raw
 * bundles and raw records only.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  SqliteEvidenceWriter,
  exportRunBundle,
  openEvidenceDatabase,
  type BundleReader,
  type EvidenceDatabase,
  type LearnerContractText,
} from '@ald/evidence';
import { StepClock } from '@ald/gateway';
import {
  InMemorySignerRegistry,
  hashCanonical,
  hashCarrierMark,
  sha256Bytes,
} from '@ald/hashing';
import {
  indexLv01TrainingLedger,
  loadLearnerContract,
} from '@ald/learners';
import { LV01_UNTOUCHED_TYPE_CODES, ReferentialScenarioEngine } from '@ald/scenario';
import {
  CheckpointManifestSchema,
  LedgerEventSchema,
  RunConfigSchema,
  fixedTokenInventory,
  type Clock,
  type LedgerEvent,
  type Lv01AuditReceipt,
  type Lv01StagePacket,
  type RunConfig,
  type SignerRegistry,
  type TurnResult,
} from '@ald/types';

import {
  createNurseryRuntime,
  type NurseryRuntimeImpl,
} from '../nursery-runtime.js';
import { simpleCheckpointFactory } from '../testing.js';
import {
  LV01_BRANCHES,
  captureLv01SlotTerminal,
  createLv01PairedCasePlan,
  createLv01StageJournal,
  finalizeLv01Stage,
  recordLv01SlotCase,
  transitionLv01Slot,
  type Lv01Branch,
  type Lv01PairedCasePlan,
  type Lv01ResourceCounter,
  type Lv01SlotResources,
  type Lv01Stage,
  type Lv01StageJournal,
} from './ledger-value.js';
import {
  acquireLv01JournalLock,
  appendLv01Journal,
  initializeLv01Journal,
  readLv01Journal,
  type Lv01JournalLock,
} from './ledger-value-journal.js';
import {
  authenticateFromManifest,
  loadLv01AuditShared,
  loadLv01AuditedBranch,
  parseBundleFiles,
  type Lv01BundleDocs,
} from './lv01-audit-loader.js';
import { auditLv01PairedCase } from './lv01-auditor.js';
import {
  buildLedgerTreatmentBatch,
  deriveLv01DerangementSeed,
  sliceLedgerTreatment,
  type Lv01LedgerTreatmentBatch,
  type Lv01RoleNativeIndexes,
  type Lv01TreatmentCase,
} from './lv01-ledger-treatments.js';
import {
  buildLv01Schedule,
  scheduledCaseFor,
  verifyLv01ScheduleCoverage,
  type Lv01Schedule,
  type Lv01ScheduledCase,
} from './lv01-schedule.js';
import {
  deriveLv01LedgerCutoff,
  mapLv01LedgerAssociations,
  type Lv01PairedPredictionProvider,
} from './lv01-paired-predictions.js';
import {
  auditLv01StageCollection,
  type Lv01StageCaseAudit,
} from './lv01-stage-audit.js';
import {
  verifyLv01StageBinding,
  verifyLv01StagePacket,
} from './lv01-stage-packets.js';

function fail(message: string): never {
  throw new Error(`LV01 collector: ${message}`);
}

export interface Lv01CollectionWorkload {
  readonly profile: 'small-fixture';
  readonly trainingTurns: number;
  readonly validationFitCases: number;
  readonly validationSelectionCases: number;
  readonly withinSupportTestCases: number;
}

/**
 * Resolve the executable workload from the bound allocation. Only
 * small-fixture blocks execute in-process; the full 5,160-decision
 * Prototype-worker path is unimplemented and fails closed here. Full
 * workloads must never silently switch to production transport.
 */
export function lv01WorkloadForCollection(stage: string, allocation: unknown): Lv01CollectionWorkload {
  const root = (allocation as Record<string, unknown> | null)?.['allocation'] as Record<string, unknown> | undefined;
  const fixture = root?.['smallFixture'] as Record<string, unknown> | undefined;
  const trainingTurns = fixture?.['trainingCases'];
  if (typeof trainingTurns !== 'number' || !Number.isInteger(trainingTurns) || trainingTurns < 1) {
    fail(`${stage} allocation carries no executable small-fixture workload`);
  }
  const count = (name: string): number => {
    const value = fixture?.[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${stage} small fixture has no ${name}`);
    return value;
  };
  return {
    profile: 'small-fixture',
    trainingTurns,
    validationFitCases: count('validationFitCases'),
    validationSelectionCases: count('validationSelectionCases'),
    withinSupportTestCases: count('withinSupportTestCases'),
  };
}

/** Packet-bound slot seeds: deterministic, unique per slot, no fresh entropy. */
export function lv01SlotSeeds(
  packetCommitment: string,
  slotIndex: number,
): { readonly randomSeed: string; readonly scenario: string; readonly babyA: string; readonly babyB: string; readonly gateway: string; readonly analysis: string } {
  const seed = (role: string): string => hashCanonical('lv01-slot-seed/v1', { packetCommitment, slotIndex, role });
  return {
    randomSeed: seed('random'),
    scenario: seed('scenario'),
    babyA: seed('baby-a'),
    babyB: seed('baby-b'),
    gateway: seed('gateway'),
    analysis: seed('analysis'),
  };
}

export interface Lv01ScheduledBranchTarget {
  readonly targetTypeCode: number;
  readonly candidateTypeCodes: readonly number[];
  readonly candidateRefs: readonly string[];
  readonly receiver: 'baby-a' | 'baby-b';
  /** The scheduled instance state hash; served turn records must match it. */
  readonly stateHash: string;
  /** Schedule identity of the served case, bound into the audit record. */
  readonly scheduledCaseId: string;
}

/**
 * Look up the scheduled turn-0 case offline. Replicates exactly how the
 * runtime serves a branch's first turn (scheduled LV01 case for the slot's
 * receiver role); the executor and audit both trip on any drift between
 * this lookup and the served case. Never the generic evaluation split.
 */
export function scheduledLv01BranchTarget(input: {
  readonly schedule: Lv01Schedule;
  readonly partition: Lv01ScheduledCase['partition'];
  readonly caseIndex: number;
  readonly receiver: 'baby-a' | 'baby-b';
}): Lv01ScheduledBranchTarget {
  const entry = scheduledCaseFor(input.schedule, input.partition, input.receiver, input.caseIndex);
  return {
    targetTypeCode: entry.targetTypeCode,
    candidateTypeCodes: [...entry.candidateTypeCodes],
    candidateRefs: [...entry.candidateRefs],
    receiver: entry.receiverRole,
    stateHash: entry.stateHash,
    scheduledCaseId: entry.caseId,
  };
}

/**
 * The two ledger-branch treatment cases for one paired case, keyed by the
 * branch run identities the plan will derive. Both name the same scheduled
 * instance (all branches serve one scheduled case per slot); the batch
 * deranges the two selections within the slot receiver role.
 */
export function buildLv01TreatmentCases(
  scheduled: Lv01ScheduledBranchTarget,
  childRunIdPrefix: string,
): readonly [Lv01TreatmentCase, Lv01TreatmentCase] {
  const treatmentCase = (branch: 'ledger-consistent' | 'ledger-shuffled'): Lv01TreatmentCase => ({
    caseId: `${childRunIdPrefix}-${branch}:turn:0`,
    receiverRole: scheduled.receiver,
    targetTypeCode: scheduled.targetTypeCode,
    candidateTypeCodes: [...scheduled.candidateTypeCodes],
  });
  return [treatmentCase('ledger-consistent'), treatmentCase('ledger-shuffled')];
}

export interface Lv01PairedCaseInputs {
  readonly parent: RunConfig;
  readonly parentCheckpointHash: string;
  readonly babyAInitialPolicyRef: string;
  readonly babyBInitialPolicyRef: string;
  readonly childRunIdPrefix: string;
  readonly actionDrawScope: {
    readonly stage: 'development' | 'qualification' | 'shadow' | 'generalization' | 'pilot';
    readonly slotKind: 'primary' | 'reserve';
    readonly slotIndex: string;
    readonly partition: 'dev' | 'within-support' | 'novel-composition';
  };
  readonly treatmentCases: readonly Lv01TreatmentCase[];
  readonly nativeIndexes: Lv01RoleNativeIndexes;
  readonly symbolInventory: readonly string[];
  readonly derangementSeed: string;
  readonly slotSeeds: {
    readonly scenario: string;
    readonly babyA: string;
    readonly babyB: string;
    readonly gateway: string;
    readonly analysis: string;
  };
  readonly scheduledCase: {
    readonly partition: 'training' | 'validation-fit' | 'validation-selection' | 'within-support-test';
    readonly caseIndex: number;
    readonly receiverRole: 'baby-a' | 'baby-b';
  };
}

/** Commit the treatment batch, then plan the seven branches around its slices. */
export function prepareLv01PairedCase(input: Lv01PairedCaseInputs): {
  readonly plan: Lv01PairedCasePlan;
  readonly batch: Lv01LedgerTreatmentBatch;
} {
  const batch = buildLedgerTreatmentBatch({
    cases: [...input.treatmentCases],
    nativeIndexes: input.nativeIndexes,
    symbolInventory: [...input.symbolInventory],
    derangementSeed: input.derangementSeed,
  });
  const sliceFor = (branch: 'ledger-consistent' | 'ledger-shuffled') => {
    const found = batch.cases.find((entry) => entry.caseId === `${input.childRunIdPrefix}-${branch}:turn:0`);
    if (found === undefined) fail(`treatment batch has no case for ${branch}`);
    return { ...sliceLedgerTreatment(batch, found.caseId, branch) };
  };
  const plan = createLv01PairedCasePlan({
    parent: input.parent,
    parentCheckpointHash: input.parentCheckpointHash,
    babyAInitialPolicyRef: input.babyAInitialPolicyRef,
    babyBInitialPolicyRef: input.babyBInitialPolicyRef,
    childRunIdPrefix: input.childRunIdPrefix,
    actionDrawScope: input.actionDrawScope,
    slotSeeds: input.slotSeeds,
    scheduledCase: input.scheduledCase,
    ledgerTreatments: {
      'ledger-consistent': sliceFor('ledger-consistent'),
      'ledger-shuffled': sliceFor('ledger-shuffled'),
    },
  });
  return { plan, batch };
}

/* ------------------------------------------------------------------ */
/* Bundle IO                                                           */
/* ------------------------------------------------------------------ */

const LV01_BUNDLE_FILES = [
  'run-manifest.json',
  'intervention-log.jsonl',
  'turn-records.jsonl',
  'baby-a-ledger.jsonl',
  'baby-b-ledger.jsonl',
] as const;

/**
 * Read one exported run bundle into loader documents. `run-config.json`
 * lives under `configuration/`; `checkpoints.json` is synthesized from the
 * retained `checkpoints/*.json` manifests (the exporter writes one file per
 * checkpoint), ordered by checkpoint sequence.
 */
export async function readLv01BundleDocs(bundleDir: string): Promise<Lv01BundleDocs> {
  const files: Record<string, string> = {};
  for (const name of LV01_BUNDLE_FILES) {
    try {
      files[name] = await readFile(join(bundleDir, name), 'utf8');
    } catch {
      fail(`bundle at ${bundleDir} is missing ${name}`);
    }
  }
  try {
    files['run-config.json'] = await readFile(join(bundleDir, 'configuration', 'run-config.json'), 'utf8');
  } catch {
    fail(`bundle at ${bundleDir} is missing configuration/run-config.json`);
  }
  try {
    const policyNames = await readdir(join(bundleDir, 'policies'));
    for (const name of policyNames.sort()) {
      files[`policies/${name}`] = await readFile(join(bundleDir, 'policies', name), 'utf8');
    }
  } catch {
    // A bundle without policy exports carries no policies; the loader fails
    // closed when a derivation ref needs one.
  }
  const checkpoints: { sequence: number; hash: string }[] = [];
  try {
    const names = await readdir(join(bundleDir, 'checkpoints'));
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const parsed = CheckpointManifestSchema.safeParse(
        JSON.parse(await readFile(join(bundleDir, 'checkpoints', name), 'utf8')) as unknown,
      );
      if (!parsed.success) fail(`bundle at ${bundleDir} carries an invalid checkpoint ${name}`);
      checkpoints.push({ sequence: parsed.data.checkpointSequence, hash: parsed.data.checkpointHash });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('LV01 collector:')) throw error;
    // No checkpoints directory: the loader fails closed on derivation.
  }
  checkpoints.sort((left, right) => left.sequence - right.sequence);
  files['checkpoints.json'] = JSON.stringify({ checkpointHashes: checkpoints.map((entry) => entry.hash) });
  return parseBundleFiles(files);
}

/** The frozen parent checkpoint: the max-sequence retained manifest hash. */
export function lv01ParentCheckpointHash(parentDocs: Lv01BundleDocs): string {
  if (parentDocs.checkpoints.length === 0) fail('parent bundle retains no checkpoints');
  return parentDocs.checkpoints[parentDocs.checkpoints.length - 1] as string;
}

/* ------------------------------------------------------------------ */
/* Harness executor                                                    */
/* ------------------------------------------------------------------ */

export interface Lv01CollectorHarness {
  readonly root: string;
  readonly runtime: NurseryRuntimeImpl;
  readonly readerFor: (runId: string) => BundleReader;
  close(): void;
}

/**
 * Open the collection store: the live SQLite evidence store and bundle
 * root that already hold the sealed parent run. Branches execute as new
 * runs in this same store because the runtime maps the parent's frozen
 * training ledger through unscoped reads and loads the parent's exported
 * policies from the store's run directory; the store is append-only for
 * sealed parent streams, so branches cannot rewrite parent evidence.
 * Small-fixture grade, matching the only workload this collector executes.
 *
 * `ordinary` is the collection-time ordinary-record predictor the runtime
 * commits pre-action on every branch. It arrives as an explicit input:
 * ordinary selection is an analysis-time decision (see the registered
 * analysis plan), and the collector invents none of it.
 */
export async function createLv01CollectorHarness(input: {
  readonly root: string;
  readonly databasePath?: string;
  readonly softwareCommit: string;
  readonly ordinary: Lv01PairedPredictionProvider;
  readonly clock?: Clock;
}): Promise<Lv01CollectorHarness> {
  const database: EvidenceDatabase = openEvidenceDatabase(input.databasePath ?? join(input.root, 'evidence.sqlite'));
  const clock = input.clock ?? new StepClock();
  const registries = new Map<string, SignerRegistry>();
  // Runs that already exist in the store (the sealed parent) resolve to
  // their RECORDED public keys: the runtime verifies parent streams under
  // parent keys and the child never re-signs them, so no private key is
  // needed — and a fresh key would fail authentication. Only genuinely
  // new branch runs generate keys.
  const readWriter = new SqliteEvidenceWriter({
    database,
    signers: InMemorySignerRegistry.generate('lv01-collector-read'),
    clock,
    softwareCommit: input.softwareCommit,
  });
  const signerProvider = (runId: string): SignerRegistry => {
    const existing = registries.get(runId);
    if (existing !== undefined) return existing;
    const recorded = readWriter.readRunSigners(runId);
    if (recorded.length > 0) {
      const sealed: SignerRegistry = {
        runId,
        publicKeys: () => recorded.map((key) => ({ ...key })),
        signer: () => {
          throw new Error(`LV01 collector: sealed run ${runId} cannot sign`);
        },
      };
      registries.set(runId, sealed);
      return sealed;
    }
    const created = InMemorySignerRegistry.generate(runId);
    registries.set(runId, created);
    return created;
  };
  const runtime = createNurseryRuntime({
    database,
    bundleRoot: input.root,
    softwareCommit: input.softwareCommit,
    checkpointFactory: simpleCheckpointFactory({ clock, softwareCommit: input.softwareCommit }),
    signerProvider,
    clock,
    anchorPolicy: 'skip',
    lv01PredictionFor: (config) => (config.lv01PairedCase === undefined ? undefined : input.ordinary),
  });
  return {
    root: input.root,
    runtime,
    readerFor: (runId: string): BundleReader =>
      new SqliteEvidenceWriter({ database, signers: signerProvider(runId), clock, softwareCommit: input.softwareCommit }),
    close: (): void => {
      database.close();
    },
  };
}

export interface Lv01BranchExecution {
  readonly branch: Lv01Branch;
  readonly runId: string;
  readonly bundleDir: string;
  readonly outcome: boolean;
}

/**
 * Execute the seven planned branches: create each derived run, step its
 * single turn-0 evaluation, live-gate the served case (evaluation phase,
 * turn 0, one accepted channel delivery), verify treatment branches
 * delivered exactly the committed slice token, and export the branch
 * bundle. Any divergence fails the case: there is no retry inside a case.
 */
export async function executeLv01PairedCaseBranches(input: {
  readonly plan: Lv01PairedCasePlan;
  readonly harness: Lv01CollectorHarness;
  readonly caseDir: string;
  readonly softwareCommit: string;
}): Promise<readonly Lv01BranchExecution[]> {
  if (input.plan.branches.length !== LV01_BRANCHES.length) fail('executor requires all seven planned branches');
  const executions: Lv01BranchExecution[] = [];
  for (const [index, planned] of input.plan.branches.entries()) {
    if (planned.branch !== LV01_BRANCHES[index]) fail('planned branches arrive out of order');
    executions.push(await executeOneBranch({ ...input, planned }));
  }
  return executions;
}

async function executeOneBranch(input: {
  readonly planned: Lv01PairedCasePlan['branches'][number];
  readonly harness: Lv01CollectorHarness;
  readonly caseDir: string;
  readonly softwareCommit: string;
}): Promise<Lv01BranchExecution> {
  const { planned, harness } = input;
  const config = planned.config;
  await harness.runtime.createRun(config);
  let turn: TurnResult;
  try {
    turn = await harness.runtime.step(config.runId);
  } catch (error) {
    fail(`branch ${planned.branch} turn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (turn.turn !== 0) fail(`branch ${planned.branch} served turn ${turn.turn}, expected turn 0`);
  if (turn.phase !== 'evaluating') fail(`branch ${planned.branch} ran in phase ${turn.phase}, expected evaluating`);

  const channel = turn.channelEvent;
  const pairedCase = config.lv01PairedCase;
  if (pairedCase === undefined || pairedCase.branch !== planned.branch) {
    fail(`branch ${planned.branch} configuration carries no paired-case section`);
  }
  const slice = pairedCase.ledgerTreatment;
  if (planned.branch === 'disabled') {
    // Disabled still records a channel event, but with no delivery: the
    // public artifact hash is the hash of canonical null (SPEC §11.5).
    if (channel === null) fail('disabled branch recorded no channel event');
    if (channel.gatewayValidationResult !== 'accepted') {
      fail(`disabled branch channel event was ${channel.gatewayValidationResult}`);
    }
    if (channel.publicArtifactHash !== hashCarrierMark(config.carrierMode, null)) {
      fail('disabled branch delivered an artifact');
    }
  } else {
    if (channel === null) fail(`branch ${planned.branch} delivered no channel event`);
    if (channel.gatewayValidationResult !== 'accepted') {
      fail(`branch ${planned.branch} channel delivery was ${channel.gatewayValidationResult}`);
    }
    if (slice !== undefined) {
      const expected = hashCarrierMark(config.carrierMode, { symbols: [slice.deliveredToken] });
      if (channel.publicArtifactHash !== expected) {
        fail(`branch ${planned.branch} delivered a token outside its committed slice`);
      }
    }
  }

  const bundleDir = join(input.caseDir, 'branches', config.runId);
  const contracts = new Map<string, LearnerContractText>();
  for (const track of [config.babyA.track, config.babyB.track]) {
    if (!contracts.has(track)) {
      const contract = loadLearnerContract(track);
      contracts.set(track, { track, version: contract.version, text: contract.text });
    }
  }
  await exportRunBundle(harness.readerFor(config.runId), config.runId, bundleDir, {
    softwareCommit: input.softwareCommit,
    learnerContracts: [...contracts.values()],
  });
  return { branch: planned.branch, runId: config.runId, bundleDir, outcome: turn.outcome.success };
}

/* ------------------------------------------------------------------ */
/* Slot collector                                                      */
/* ------------------------------------------------------------------ */

export interface Lv01CollectedSlot {
  readonly slot: number;
  readonly kind: 'primary' | 'reserve';
  readonly caseCommitment: string;
  readonly caseDir: string;
  readonly executions: readonly Lv01BranchExecution[];
  readonly outcomes: Record<Lv01Branch, boolean>;
  readonly resources: Lv01SlotResources;
}

const scopeStageFor = (stage: Lv01Stage): 'development' | 'qualification' | 'pilot' => {
  if (stage === 'development' || stage === 'qualification' || stage === 'pilot') return stage;
  fail(`stage ${stage} has no registered action-draw scope`);
};

function typedParentConfig(parentDocs: Lv01BundleDocs): RunConfig {
  const parsed = RunConfigSchema.safeParse(parentDocs.runConfig);
  if (!parsed.success) fail(`parent run-config is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  return parsed.data;
}

function typedLedgerEvents(docs: readonly unknown[], file: string): LedgerEvent[] {
  return docs.map((entry, index) => {
    const parsed = LedgerEventSchema.safeParse(entry);
    if (!parsed.success) fail(`${file} line ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    return parsed.data;
  });
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const names = await readdir(root, { withFileTypes: true });
  for (const entry of names) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else if (entry.isFile()) {
      total += (await readFile(path)).length;
    }
  }
  return total;
}

/**
 * Collect one slot end to end: derive everything from the sealed parent
 * bundle, build the slot schedule and look up the scheduled case, commit
 * the treatment batch BEFORE any branch runs, execute all seven branches,
 * verify the served case equals the scheduled case, and self-audit through
 * the independent loader + auditor. Returns the audited case commitment;
 * throws (invalid slot) on any divergence.
 */
export async function collectLv01Slot(input: {
  readonly packet: Lv01StagePacket;
  readonly slot: number;
  readonly kind: 'primary' | 'reserve';
  readonly parentBundleDir: string;
  readonly stageDir: string;
  readonly softwareCommit: string;
  readonly partition: 'dev' | 'within-support' | 'novel-composition';
  readonly ordinary: Lv01PairedPredictionProvider;
  readonly store: { readonly root: string; readonly databasePath?: string };
}): Promise<Lv01CollectedSlot> {
  const wallStart = Date.now();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage.rss();
  const slotLabel = String(input.slot).padStart(4, '0');
  const caseDir = join(input.stageDir, `slot-${slotLabel}`);
  await mkdir(caseDir, { recursive: true });

  const parentDocs = await readLv01BundleDocs(input.parentBundleDir);
  const parent = typedParentConfig(parentDocs);
  if (parent.experimentId !== 'LV01') fail('paired cases require an LV01 parent');
  const parentCheckpointHash = lv01ParentCheckpointHash(parentDocs);
  const babyAInitialPolicyRef = 'policies/baby-a-latest.json';
  const babyBInitialPolicyRef = 'policies/baby-b-latest.json';
  if (parentDocs.policies[babyAInitialPolicyRef] === undefined) fail('parent bundle is missing policies/baby-a-latest.json');
  if (parentDocs.policies[babyBInitialPolicyRef] === undefined) fail('parent bundle is missing policies/baby-b-latest.json');

  const authenticate = authenticateFromManifest(parentDocs.runManifest);
  // Both role ledgers are indexed from sealed parent data: each treatment
  // case is scored on its own receiver role's index, never cross-role.
  const ledgerFor = (role: 'baby-a' | 'baby-b') =>
    mapLv01LedgerAssociations(
      typedLedgerEvents(role === 'baby-a' ? parentDocs.ledgerA : parentDocs.ledgerB, `parent ${role}-ledger.jsonl`),
      role,
      authenticate,
    );
  const recordsA = ledgerFor('baby-a');
  const recordsB = ledgerFor('baby-b');
  const nativeIndexes: Lv01RoleNativeIndexes = {
    babyA: indexLv01TrainingLedger(recordsA, 'baby-a', deriveLv01LedgerCutoff(recordsA)),
    babyB: indexLv01TrainingLedger(recordsB, 'baby-b', deriveLv01LedgerCutoff(recordsB)),
  };
  // Served cutoff follows the slot's scheduled receiver role.
  const receiver: 'baby-a' | 'baby-b' = input.slot % 2 === 1 ? 'baby-b' : 'baby-a';
  const cutoff = deriveLv01LedgerCutoff(receiver === 'baby-a' ? recordsA : recordsB);

  // Slot schedule: the engine runs on the slot scenario seed (shared with
  // the branch run configs below), the frozen LV01 held-out diagonal is
  // asserted explicitly rather than inherited, and training cases stay in
  // the parent domain (no-overlap against parent training refs is loader
  // work, tracked separately).
  const seeds = lv01SlotSeeds(input.packet.packetCommitment, input.slot);
  const allocationRaw = await readFile(input.packet.allocation.path, 'utf8').catch(() => {
    fail(`allocation file ${input.packet.allocation.path} is missing`);
  });
  if (`sha256:${sha256Bytes(Buffer.from(allocationRaw, 'utf8')).toString('hex')}` !== input.packet.allocation.sha256) {
    fail('allocation bytes differ from the registered packet allocation');
  }
  const workload = lv01WorkloadForCollection(input.packet.stage, JSON.parse(allocationRaw) as unknown);
  if (workload.withinSupportTestCases < 1) fail(`${input.packet.stage} allocation schedules no within-support test cases`);
  const scheduleEngine = new ReferentialScenarioEngine(
    {
      version: 1,
      symbolInventory: fixedTokenInventory(parent.symbolInventorySize ?? 32),
      interactionMode: parent.interactionMode,
      heldOutTypeCodes: [...LV01_UNTOUCHED_TYPE_CODES],
    },
    seeds.scenario,
  );
  const schedule = buildLv01Schedule({
    engine: scheduleEngine,
    counts: {
      training: 0,
      'validation-fit': workload.validationFitCases,
      'validation-selection': workload.validationSelectionCases,
      'within-support-test': workload.withinSupportTestCases,
    },
    receiverRoles: ['baby-a', 'baby-b'],
  });
  // Rotation across slots keeps targets balanced: same-role slots would
  // otherwise all test the round-robin head of the test partition.
  const scheduled = scheduledLv01BranchTarget({
    schedule,
    partition: 'within-support-test',
    caseIndex: (input.slot - 1) % workload.withinSupportTestCases,
    receiver,
  });
  const scheduleCommitment = verifyLv01ScheduleCoverage(schedule, [scheduled.scheduledCaseId]);
  const childRunIdPrefix = `lv01-${input.packet.stage}-v${input.packet.version}-s${slotLabel}`;
  if (!/^[a-z0-9-]+$/u.test(childRunIdPrefix)) fail('child run identifier prefix is invalid');
  const treatmentCases = buildLv01TreatmentCases(scheduled, childRunIdPrefix);
  const { plan, batch } = prepareLv01PairedCase({
    parent,
    parentCheckpointHash,
    babyAInitialPolicyRef,
    babyBInitialPolicyRef,
    childRunIdPrefix,
    actionDrawScope: {
      stage: scopeStageFor(input.packet.stage),
      slotKind: input.kind,
      slotIndex: slotLabel,
      partition: input.partition,
    },
    treatmentCases: [...treatmentCases],
    nativeIndexes,
    symbolInventory: fixedTokenInventory(parent.symbolInventorySize ?? 32),
    // Registered-form batch seed. Partition passes through the draw-scope
    // vocabulary (dev/within-support/novel-composition); aligning it with
    // the seed policy's partition vocabulary is deferred design work.
    derangementSeed: deriveLv01DerangementSeed({
      root: 'ald-ledger-value-v2',
      studyId: 'LV01',
      stage: input.packet.stage,
      policyVersion: 'v2',
      slotKind: input.kind,
      slotIndex: slotLabel,
      partition: input.partition,
    }),
    slotSeeds: { scenario: seeds.scenario, babyA: seeds.babyA, babyB: seeds.babyB, gateway: seeds.gateway, analysis: seeds.analysis },
    scheduledCase: { partition: 'within-support-test', caseIndex: (input.slot - 1) % workload.withinSupportTestCases, receiverRole: receiver },
  });
  await writeFile(join(caseDir, 'treatment-batch.json'), `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
  await writeFile(
    join(caseDir, 'schedule.json'),
    `${JSON.stringify({ commitment: scheduleCommitment, counts: schedule.counts, executedCaseId: scheduled.scheduledCaseId, cases: schedule.cases }, null, 2)}\n`,
    'utf8',
  );

  const harness = await createLv01CollectorHarness({
    root: input.store.root,
    databasePath: input.store.databasePath,
    softwareCommit: input.softwareCommit,
    ordinary: input.ordinary,
  });
  let executions: readonly Lv01BranchExecution[];
  try {
    executions = await executeLv01PairedCaseBranches({
      plan,
      harness,
      caseDir,
      softwareCommit: input.softwareCommit,
    });
  } finally {
    harness.close();
  }
  const rssPostBranches = process.memoryUsage.rss();

  // Served case must equal the scheduled case: every branch payload commits
  // the scenario it actually served, and the loader already bound the
  // payload to the turn record and the intention selection.
  const verificationStart = Date.now();
  const branchDocs: Lv01BundleDocs[] = [];
  for (const execution of executions) {
    branchDocs.push(await readLv01BundleDocs(execution.bundleDir));
  }
  const audited = branchDocs.map((docs) => loadLv01AuditedBranch(docs));
  for (const branch of audited) {
    if (branch.payload.state.scenarioStateHash !== scheduled.stateHash) {
      fail(`branch ${branch.branch} served a case outside the committed schedule`);
    }
    if (branch.payload.cutoff.sequence !== cutoff.sequence || branch.payload.cutoff.turn !== cutoff.turn) {
      fail(`branch ${branch.branch} committed a cutoff outside the parent index`);
    }
  }
  // Served-vs-batch target verification belongs here but the audited branch
  // payload carries no served target yet; the previous call compared the
  // batch against its own schedule input (tautological) and is removed rather
  // than kept as theater. A5 loader work exposes served targets, then this
  // call returns with independently observed values.
  const first = audited[0];
  if (first === undefined) fail('case has no audited branches');
  const shared = loadLv01AuditShared({
    parentDocs,
    branchDocs: branchDocs[0] as Lv01BundleDocs,
    firstBranch: first,
    treatmentBatch: batch,
  });
  const { caseCommitment } = auditLv01PairedCase({ plan, shared, branches: audited });
  const verificationMilliseconds = Date.now() - verificationStart;
  // Sampled RSS maximum (start, post-branches, post-audit). Branches run
  // in-process so RSS covers them; this is a sampled maximum, honestly
  // labeled, never a final-RSS-as-peak substitution.
  const peakBytes = Math.max(rssStart, rssPostBranches, process.memoryUsage.rss());

  const cpu = process.cpuUsage(cpuStart);
  const outcomes = {} as Record<Lv01Branch, boolean>;
  for (const execution of executions) {
    outcomes[execution.branch] = execution.outcome;
  }
  return {
    slot: input.slot,
    kind: input.kind,
    caseCommitment,
    caseDir,
    executions,
    outcomes,
    resources: {
      cpuMicroseconds: Math.round(cpu.user + cpu.system),
      wallMilliseconds: Date.now() - wallStart,
      peakBytes,
      evidenceBytes: await directoryBytes(caseDir),
      verificationMilliseconds,
      unresolved: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Stage walk                                                          */
/* ------------------------------------------------------------------ */

export interface Lv01StageCollection {
  readonly journal: Lv01StageJournal;
  readonly journalPath: string;
  readonly cases: readonly Lv01StageCaseAudit[];
  readonly slots: readonly Lv01CollectedSlot[];
}

/**
 * Collect a bound stage: verify packet + binding, lock and initialize the
 * journal, run primaries in slot order, then ordered reserves — one
 * reserve per invalid primary, never more, never out of order. Every
 * transition is journaled; every failure carries its stage and reason;
 * the journal finalizes on every path.
 */
export async function collectLv01Stage(input: {
  readonly packet: unknown;
  readonly binding: unknown;
  readonly parentBundleDir: string;
  readonly evidenceDir: string;
  readonly softwareCommit: string;
  readonly partition: 'dev' | 'within-support' | 'novel-composition';
  readonly ordinary: Lv01PairedPredictionProvider;
  readonly store: { readonly root: string; readonly databasePath?: string };
  readonly owner: string;
}): Promise<Lv01StageCollection> {
  const packet = verifyLv01StagePacket(input.packet);
  const binding = verifyLv01StageBinding(input.binding, packet);
  void binding;
  const stageDir = join(input.evidenceDir, 'lv01', `${packet.stage}-v${packet.version}`);
  await mkdir(stageDir, { recursive: true });
  const journalPath = join(stageDir, 'journal.jsonl');
  const startedAt = new Date().toISOString();
  const lock = await acquireLv01JournalLock(journalPath, input.owner, startedAt);
  try {
    return await runStageLocked({ ...input, packet, stageDir, journalPath, lock, startedAt });
  } finally {
    await lock.release();
  }
}

async function runStageLocked(input: {
  readonly packet: Lv01StagePacket;
  readonly parentBundleDir: string;
  readonly softwareCommit: string;
  readonly partition: 'dev' | 'within-support' | 'novel-composition';
  readonly ordinary: Lv01PairedPredictionProvider;
  readonly store: { readonly root: string; readonly databasePath?: string };
  readonly owner: string;
  readonly stageDir: string;
  readonly journalPath: string;
  readonly lock: Lv01JournalLock;
  readonly startedAt: string;
}): Promise<Lv01StageCollection> {
  const { packet } = input;
  let journal = createLv01StageJournal(packet.stage, packet.version, packet.slotPlan.primaries, packet.slotPlan.reserves);
  await initializeLv01Journal(input.lock, journal, input.startedAt);

  const cases: Lv01StageCaseAudit[] = [];
  const slots: Lv01CollectedSlot[] = [];
  const stamp = (): string => new Date().toISOString();

  const primaries = journal.slots.filter((slot) => slot.kind === 'primary');
  const reserves = journal.slots.filter((slot) => slot.kind === 'reserve');
  let invalidPrimaries = 0;

  // The running marker is journaled for forensics, but the terminal
  // capture runs from the pre-start snapshot: captureLv01SlotTerminal
  // performs the unattempted→running→terminal transitions itself.
  const runSlot = async (index: number, kind: 'primary' | 'reserve'): Promise<void> => {
    await appendLv01Journal(input.lock, transitionLv01Slot(journal, index, 'running'), stamp());
    const slotWallStart = Date.now();
    const slotCpuStart = process.cpuUsage();
    try {
      const collected = await collectLv01Slot({
        packet,
        slot: index,
        kind,
        parentBundleDir: input.parentBundleDir,
        stageDir: input.stageDir,
        softwareCommit: input.softwareCommit,
        partition: input.partition,
        ordinary: input.ordinary,
        store: input.store,
      });
      const terminal = captureLv01SlotTerminal(journal, index, 'valid', collected.resources, null);
      journal = recordLv01SlotCase(terminal.journal, index, collected.caseCommitment);
      cases.push({ slot: index, caseCommitment: collected.caseCommitment });
      slots.push(collected);
    } catch (error) {
      if (kind === 'primary') invalidPrimaries += 1;
      const reason = error instanceof Error ? error.message : String(error);
      // Partial failure costs: wall and CPU are measured at catch time;
      // evidence is best-effort over whatever the attempt wrote; peak and
      // verification never ran, so they are unresolved — never zero-as-data.
      const cpu = process.cpuUsage(slotCpuStart);
      const slotLabel = String(index).padStart(4, '0');
      let evidenceBytes = 0;
      let evidenceUnresolved = true;
      try {
        evidenceBytes = await directoryBytes(join(input.stageDir, `slot-${slotLabel}`));
        evidenceUnresolved = false;
      } catch {
        evidenceBytes = 0;
      }
      const unresolved: Lv01ResourceCounter[] = ['peakBytes', 'verificationMilliseconds'];
      if (evidenceUnresolved) unresolved.push('evidenceBytes');
      const terminal = captureLv01SlotTerminal(
        journal,
        index,
        'invalid',
        {
          cpuMicroseconds: Math.round(cpu.user + cpu.system),
          wallMilliseconds: Date.now() - slotWallStart,
          peakBytes: 0,
          evidenceBytes,
          verificationMilliseconds: 0,
          unresolved,
        },
        'collect',
        reason,
      );
      journal = terminal.journal;
    }
    await appendLv01Journal(input.lock, journal, stamp());
  };

  for (const slot of primaries) {
    await runSlot(slot.index, 'primary');
  }

  // Ordered reserves only: the registered invalidity rule allows no other
  // replacement than an ordered prefix of the reserve pool.
  for (const slot of reserves.slice(0, invalidPrimaries)) {
    await runSlot(slot.index, 'reserve');
  }

  journal = finalizeLv01Stage(journal);
  await appendLv01Journal(input.lock, journal, stamp());
  return { journal, journalPath: input.journalPath, cases, slots };
}

/* ------------------------------------------------------------------ */
/* Stage audit replay                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rebuild the registered plan from raw records only: parent bundle for the
 * parent config, branch run-configs for lineage + slices + draw scope.
 * Anything the records do not carry fails closed here, never defaults.
 */
export function rebuildLv01CasePlan(input: {
  readonly parentDocs: Lv01BundleDocs;
  readonly branchDocs: readonly Lv01BundleDocs[];
}): Lv01PairedCasePlan {
  if (input.branchDocs.length !== LV01_BRANCHES.length) fail('plan rebuild requires all seven branch bundles');
  const parent = typedParentConfig(input.parentDocs);
  const first = RunConfigSchema.safeParse(input.branchDocs[0]?.runConfig);
  if (!first.success) fail('branch run-config is invalid');
  const checkpoint = first.data.derivedFromCheckpointHash;
  const babyAInitialPolicyRef = first.data.babyA.initialPolicyRef;
  const babyBInitialPolicyRef = first.data.babyB.initialPolicyRef;
  if (typeof checkpoint !== 'string' || typeof babyAInitialPolicyRef !== 'string' || typeof babyBInitialPolicyRef !== 'string') {
    fail('branch derivation carries no lineage');
  }
  const firstPairedCase = first.data.lv01PairedCase;
  if (firstPairedCase === undefined) fail('branch run-config carries no LV01 paired case');
  const drawScope = firstPairedCase.actionDraw;
  if (drawScope === undefined) fail('branch run-config carries no draw scope');
  const scheduledCase = firstPairedCase.scheduledCase;
  if (scheduledCase === undefined) fail('branch run-config carries no scheduled case');
  const firstSeeds = first.data.seedBindings;
  if (firstSeeds === undefined) fail('branch run-config carries no seed bindings');
  const firstBranch = firstPairedCase.branch;
  if (!first.data.runId.endsWith(`-${firstBranch}`)) fail('branch run identity carries no branch suffix');
  const prefix = first.data.runId.slice(0, -(firstBranch.length + 1));
  const slices: Partial<Record<Lv01Branch, {
    readonly selectedToken: string;
    readonly deliveredToken: string;
    readonly batchCommitment: string;
    readonly sourceCaseId: string;
  }>> = {};
  for (const docs of input.branchDocs) {
    const parsed = RunConfigSchema.safeParse(docs.runConfig);
    if (!parsed.success) fail('branch run-config is invalid');
    const section = parsed.data.lv01PairedCase;
    if (section === undefined || !LV01_BRANCHES.includes(section.branch)) fail('branch run-config carries no LV01 paired case');
    if (parsed.data.derivedFromCheckpointHash !== checkpoint) fail('branch derivations disagree on the parent checkpoint');
    if (section.ledgerTreatment !== undefined) {
      slices[section.branch] = { ...section.ledgerTreatment };
    }
  }
  return createLv01PairedCasePlan({
    parent,
    parentCheckpointHash: checkpoint,
    babyAInitialPolicyRef,
    babyBInitialPolicyRef,
    childRunIdPrefix: prefix,
    actionDrawScope: {
      stage: drawScope.stage,
      slotKind: drawScope.slotKind,
      slotIndex: drawScope.slotIndex,
      partition: drawScope.partition,
    },
    slotSeeds: {
      scenario: firstSeeds.scenario,
      babyA: firstSeeds.babyA,
      babyB: firstSeeds.babyB,
      gateway: firstSeeds.gateway,
      analysis: firstSeeds.analysis,
    },
    scheduledCase: {
      partition: scheduledCase.partition,
      caseIndex: scheduledCase.caseIndex,
      receiverRole: scheduledCase.receiverRole,
    },
    ledgerTreatments: slices,
  });
}

/**
 * Audit a collected stage from raw bundles only: replay every valid slot
 * through the loader + auditor against a rebuilt plan, then judge the
 * journal, cases, and reserves into an immutable receipt.
 */
export async function auditLv01Stage(input: {
  readonly packet: unknown;
  readonly binding: unknown;
  readonly parentBundleDir: string;
  readonly stageDir: string;
}): Promise<{ readonly receipt: Lv01AuditReceipt; readonly reportPath: string }> {
  const packet = verifyLv01StagePacket(input.packet);
  const binding = verifyLv01StageBinding(input.binding, packet);
  void binding;
  const journalPath = join(input.stageDir, 'journal.jsonl');
  const journalEvents = await readLv01Journal(journalPath);
  const journal = journalEvents.at(-1)?.journal;
  if (journal === undefined) fail('journal has no events');

  const parentDocs = await readLv01BundleDocs(input.parentBundleDir);
  // Audit-time schedule inputs: re-verified from the packet, never trusted
  // from the collect-time schedule.json claim each slot carries.
  const auditParent = typedParentConfig(parentDocs);
  const auditAllocationRaw = await readFile(packet.allocation.path, 'utf8').catch(() => {
    fail(`allocation file ${packet.allocation.path} is missing`);
  });
  if (`sha256:${sha256Bytes(Buffer.from(auditAllocationRaw, 'utf8')).toString('hex')}` !== packet.allocation.sha256) {
    fail('allocation bytes differ from the registered packet allocation');
  }
  let auditAllocation: unknown;
  try {
    auditAllocation = JSON.parse(auditAllocationRaw) as unknown;
  } catch {
    fail(`allocation file ${packet.allocation.path} is not valid JSON`);
  }
  const auditWorkload = lv01WorkloadForCollection(packet.stage, auditAllocation);
  if (auditWorkload.withinSupportTestCases < 1) fail(`${packet.stage} allocation schedules no within-support test cases`);
  const cases: Lv01StageCaseAudit[] = [];
  for (const slot of journal.slots) {
    if (slot.status !== 'valid') continue;
    const slotLabel = String(slot.index).padStart(4, '0');
    const caseDir = join(input.stageDir, `slot-${slotLabel}`);
    const batch = JSON.parse(await readFile(join(caseDir, 'treatment-batch.json'), 'utf8')) as Lv01LedgerTreatmentBatch;
    const branchDocs: Lv01BundleDocs[] = [];
    for (const branch of LV01_BRANCHES) {
      const runId = `lv01-${packet.stage}-v${packet.version}-s${slotLabel}-${branch}`;
      branchDocs.push(await readLv01BundleDocs(join(caseDir, 'branches', runId)));
    }
    const plan = rebuildLv01CasePlan({ parentDocs, branchDocs });
    const audited = branchDocs.map((docs) => loadLv01AuditedBranch(docs));
    const first = audited[0];
    if (first === undefined) fail(`slot ${slot.index} has no audited branches`);
    const shared = loadLv01AuditShared({
      parentDocs,
      branchDocs: branchDocs[0] as Lv01BundleDocs,
      firstBranch: first,
      treatmentBatch: batch,
    });
    const { caseCommitment } = auditLv01PairedCase({ plan, shared, branches: audited });
    if (slot.caseCommitment !== caseCommitment) {
      fail(`slot ${slot.index} journal case disagrees with the replayed audit`);
    }
    // Rebuild the slot schedule from packet-bound seeds and re-bind the
    // collect-time claim: commitment equality, executed-case slot binding,
    // and served-instance agreement across every branch.
    const auditSeeds = lv01SlotSeeds(packet.packetCommitment, slot.index);
    const auditEngine = new ReferentialScenarioEngine(
      {
        version: 1,
        symbolInventory: fixedTokenInventory(auditParent.symbolInventorySize ?? 32),
        interactionMode: auditParent.interactionMode,
        heldOutTypeCodes: [...LV01_UNTOUCHED_TYPE_CODES],
      },
      auditSeeds.scenario,
    );
    const rebuilt = buildLv01Schedule({
      engine: auditEngine,
      counts: {
        training: 0,
        'validation-fit': auditWorkload.validationFitCases,
        'validation-selection': auditWorkload.validationSelectionCases,
        'within-support-test': auditWorkload.withinSupportTestCases,
      },
      receiverRoles: ['baby-a', 'baby-b'],
    });
    let storedSchedule: { readonly commitment?: unknown; readonly executedCaseId?: unknown };
    try {
      storedSchedule = JSON.parse(await readFile(join(caseDir, 'schedule.json'), 'utf8')) as {
        readonly commitment?: unknown;
        readonly executedCaseId?: unknown;
      };
    } catch {
      fail(`slot ${slot.index} schedule record is malformed`);
    }
    if (typeof storedSchedule.commitment !== 'string' || typeof storedSchedule.executedCaseId !== 'string') {
      fail(`slot ${slot.index} schedule record is malformed`);
    }
    if (verifyLv01ScheduleCoverage(rebuilt, [storedSchedule.executedCaseId]) !== storedSchedule.commitment) {
      fail(`slot ${slot.index} schedule commitment disagrees with the rebuilt schedule`);
    }
    const auditReceiver = slot.index % 2 === 1 ? 'baby-b' : 'baby-a';
    const expected = scheduledCaseFor(
      rebuilt,
      'within-support-test',
      auditReceiver,
      (slot.index - 1) % auditWorkload.withinSupportTestCases,
    );
    if (storedSchedule.executedCaseId !== expected.caseId) {
      fail(`slot ${slot.index} executed case ${storedSchedule.executedCaseId} is not the scheduled slot case`);
    }
    for (const branch of audited) {
      if (branch.payload.state.scenarioStateHash !== expected.stateHash) {
        fail(`slot ${slot.index} branch ${branch.branch} served a case outside the rebuilt schedule`);
      }
    }
    cases.push({ slot: slot.index, caseCommitment });
  }

  const receipt = auditLv01StageCollection({
    packet,
    journalEvents: journalEvents as readonly unknown[],
    cases,
  });
  const reportPath = join(input.stageDir, 'audit-receipt.json');
  await writeFile(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { receipt, reportPath };
}
