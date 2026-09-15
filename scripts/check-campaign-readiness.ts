#!/usr/bin/env tsx

import { accessSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkE03LocalPilotState } from './e03-local-pilot-state.mjs';

type ExecutionStage = 'qualification' | 'pilot' | 'confirmatory' | 'analysis' | 'exploratory' | 'replication' | 'reporting';
type GateDecision = 'ready' | 'blocked' | 'complete';
type AttemptStatus = 'not-started' | 'running' | 'completed' | 'failed' | 'aborted';
type ScientificDisposition = 'not-tested' | 'supported' | 'not-supported' | 'inconclusive';

interface ExperimentProgress {
  id: string;
  executionReadiness: { stage: ExecutionStage; decision: GateDecision; reasonCodes: string[] };
  attempt: { version?: string; status: AttemptStatus; planned: number | null; attempted: number; completed: number };
  scientificDisposition: ScientificDisposition;
  evidence: Array<{ kind: string; path: string; statusAuthority: boolean }>;
}

interface Review {
  schemaVersion: number;
  reviewClass: string;
  independentHumanReview: boolean;
  decision: string;
  topologyBoundarySupplement: {
    recordedAt: string; sourceCommit: string; priorB12Finding: string;
    priorB12Closure: string; basis: string; boundary: string;
  };
  e03PilotPreparationSupplement: {
    recordedAt: string; sourceCommit: string; priorReasonCodes: string[];
    topologyAuditPath: string; stageAllocationPath: string; boundary: string;
  };
  e03PilotCompletionSupplement: { terminalSha256: string; sampleSizeInputSha256: string; selectedPrimarySeeds: number };
  e03PowerSelectionSupplement: {
    originalPath: string; originalSha256: string; primarySeeds: number;
    repetitions: number; nominalCompleteRuleLower95: number;
    invalidAsFailureSensitivitySuccesses: number;
  };
  e03SampleSizeDecisionSupplement: {
    path: string; sha256: string; selectedPrimarySeeds: number;
  };
  resolvedFindings: Array<{ id: string; owner: string; resolution: string; boundary: string }>;
  blockingFindings: Array<{ id: string; severity: string; owner: string; finding: string; closure: string }>;
  experiments: ExperimentProgress[];
  safeLocalNextActions: string[];
  prohibitedUntilClosure: string[];
}

const review = JSON.parse(readFileSync('protocols/campaign-readiness-review.v1.json', 'utf8')) as Review;
const cards = JSON.parse(readFileSync('protocols/research-protocol-cards.v1.json', 'utf8')) as { cards: Array<{ id: string }> };
const allocation = JSON.parse(readFileSync('protocols/seed-and-resource-allocation.v1.json', 'utf8')) as {
  planningAccounting: { projectedUncompressedGiBAtMeasuredRate: number; projectedSingleCoreHoursAtMeasuredRate: number };
  localCeiling: { workingStorageGiB: number; cpuHours: number; externalSpend: number };
};

if (review.schemaVersion !== 1 || review.reviewClass !== 'internal-adversarial-methods-review') {
  throw new Error('unexpected campaign review identity');
}
if (review.independentHumanReview || review.decision !== 'not-registration-ready') {
  throw new Error('internal review must not claim independence or readiness');
}
const expected = cards.cards.map((card) => card.id).sort();
const actual = review.experiments.map((entry) => entry.id).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('campaign review does not cover the same 19 experiment cards');
}
const findingIds = new Set(review.blockingFindings.map((finding) => finding.id));
if (findingIds.size !== review.blockingFindings.length) throw new Error('blocking-finding IDs are not unique');
for (const finding of review.blockingFindings) {
  if (finding.finding.length < 20 || finding.closure.length < 20) {
    throw new Error(`${finding.id} lacks an evidence-bearing finding or closure test`);
  }
}
for (const required of ['B07','B08','B09','B10','B11','B12','B13','B14']) {
  if (!findingIds.has(required)) throw new Error(`campaign review omits ${required}`);
}
const b12 = review.blockingFindings.find((finding) => finding.id === 'B12');
const supplement = review.topologyBoundarySupplement;
if (!supplement || !/^2026-09-15T\d{2}:\d{2}:\d{2}Z$/u.test(supplement.recordedAt) ||
    !/^[0-9a-f]{7}$/u.test(supplement.sourceCommit) ||
    supplement.priorB12Finding !== 'Timing/envelope/error and host controls pass on the exact current two-container Mode R reference topology, but have not run on the final selected registered study topology.' ||
    supplement.priorB12Closure !== 'Final-topology detector-positive and negative measurements with selected learners, carriers, samples, tolerances, and bounds, bound into verified evidence.' ||
    !supplement.basis.includes('distinct Baby twins') ||
    !supplement.basis.includes('Gateway, SQLite writer, and signers are constructed in the Nursery process') ||
    !supplement.boundary.includes('no historical receipt or study outcome is promoted') ||
    !b12?.finding.includes('controller trust-zone process boundary') ||
    !b12.closure.includes('sealed TypeScript/Rust evidence')) {
  throw new Error('B12 topology boundary supplement is missing or contradicts the current blocker');
}
const resolvedIds = new Set(review.resolvedFindings.map((finding) => finding.id));
for (const required of ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B15']) {
  if (!resolvedIds.has(required)) throw new Error(`campaign review omits resolved finding ${required}`);
}
if ([...resolvedIds].some((id) => findingIds.has(id)) ||
    (findingIds.has('B16') === resolvedIds.has('B16'))) {
  throw new Error('campaign review has contradictory blocking/resolved findings');
}
if (review.resolvedFindings.some((finding) => finding.resolution.length < 40 || finding.boundary.length < 40)) {
  throw new Error('a resolved finding lacks a complete resolution or claim boundary');
}
const executionStages = new Set<ExecutionStage>(['qualification', 'pilot', 'confirmatory', 'analysis', 'exploratory', 'replication', 'reporting']);
const gateDecisions = new Set<GateDecision>(['ready', 'blocked', 'complete']);
const attemptStatuses = new Set<AttemptStatus>(['not-started', 'running', 'completed', 'failed', 'aborted']);
const scientificDispositions = new Set<ScientificDisposition>(['not-tested', 'supported', 'not-supported', 'inconclusive']);
for (const entry of review.experiments) {
  const { executionReadiness, attempt } = entry;
  if (entry.id !== 'E03' && !['E00', 'E01', 'E02'].includes(entry.id) &&
      findingIds.has('B12') && !executionReadiness.reasonCodes.includes('B12')) {
    throw new Error(`${entry.id} omits the open B12 selected-topology boundary gate`);
  }
  if (attempt.version !== undefined && !/^v[1-9][0-9]*$/u.test(attempt.version)) {
    throw new Error(`${entry.id} has an invalid attempt version`);
  }
  if (!executionStages.has(executionReadiness.stage) || !gateDecisions.has(executionReadiness.decision)) {
    throw new Error(`${entry.id} has an invalid execution-readiness state`);
  }
  if (!attemptStatuses.has(attempt.status) || !scientificDispositions.has(entry.scientificDisposition)) {
    throw new Error(`${entry.id} has an invalid attempt or scientific disposition`);
  }
  if ((executionReadiness.decision === 'blocked') !== (executionReadiness.reasonCodes.length > 0)) {
    throw new Error(`${entry.id} readiness decision contradicts its reason codes`);
  }
  for (const reason of executionReadiness.reasonCodes) {
    if (!findingIds.has(reason) && !/^E\d{2}(?:-[a-z]+)?(?:-or-E\d{2})?$/u.test(reason)) {
      throw new Error(`${entry.id} has an unknown readiness reason ${reason}`);
    }
  }
  if (!Number.isInteger(attempt.attempted) || !Number.isInteger(attempt.completed) ||
      attempt.attempted < 0 || attempt.completed < 0 || attempt.completed > attempt.attempted) {
    throw new Error(`${entry.id} has invalid attempt accounting`);
  }
  if (attempt.planned !== null && (!Number.isInteger(attempt.planned) || attempt.planned < attempt.attempted)) {
    throw new Error(`${entry.id} attempt accounting exceeds its planned allocation`);
  }
  if (attempt.status === 'not-started' && (attempt.attempted !== 0 || attempt.completed !== 0)) {
    throw new Error(`${entry.id} is not started but has attempted or completed runs`);
  }
  if (executionReadiness.decision === 'complete' && attempt.status !== 'completed') {
    throw new Error(`${entry.id} cannot complete an execution gate without a completed attempt`);
  }
  if (executionReadiness.decision === 'ready' && (attempt.status === 'failed' || attempt.status === 'aborted')) {
    throw new Error(`${entry.id} cannot be ready while its current attempt is terminally unsuccessful`);
  }
  if (entry.scientificDisposition !== 'not-tested' && attempt.status !== 'completed') {
    throw new Error(`${entry.id} has a scientific disposition without a completed attempt`);
  }
  const authorities = entry.evidence.filter((evidence) => evidence.statusAuthority);
  if (attempt.status === 'not-started' ? authorities.length !== 0 : authorities.length !== 1) {
    throw new Error(`${entry.id} must have exactly one status-authority receipt after starting`);
  }
  for (const evidence of entry.evidence) {
    const separatelyRetainedE03 = entry.id === 'E03' && attempt.status === 'completed' &&
      !existsSync(evidence.path) &&
      ((evidence.kind === 'terminal-receipt' &&
        evidence.path === 'evidence/pilots/e03-blinded-v3/receipt.json') ||
       (evidence.kind === 'outcome-blind-sample-size-input' &&
        evidence.path === 'evidence/pilots/e03-blinded-v3/sample-size-input.json'));
    if (!separatelyRetainedE03) accessSync(evidence.path);
  }
  const packetEvidence = entry.evidence.find((evidence) => evidence.kind === 'prospective-registration-packet');
  if (packetEvidence) {
    const packet = JSON.parse(readFileSync(packetEvidence.path, 'utf8')) as {
      preRegistrationHash?: string;
      artifact?: { bindings?: Array<{ key: string; content?: { receiptPath?: string } }> };
    };
    const terminalPath = packet.artifact?.bindings?.find((binding) =>
      binding.key === 'evidenceAndAnchorPolicy')?.content?.receiptPath;
    if (terminalPath && existsSync(terminalPath)) {
      const terminal = JSON.parse(readFileSync(terminalPath, 'utf8')) as Record<string, unknown>;
      if (terminal.experimentId !== entry.id || terminal.registrationHash !== packet.preRegistrationHash) {
        throw new Error(`${entry.id} terminal receipt contradicts its prospective registration`);
      }
      if (authorities[0]?.path !== terminalPath) {
        throw new Error(`${entry.id} terminal receipt exists but is not the status authority`);
      }
    }
  }
  if (authorities.length === 1) {
    const authorityPath = authorities[0]!.path;
    const portablePath = entry.evidence.find((evidence) =>
      evidence.kind === 'portable-terminal-summary')?.path;
    const receiptPath = !existsSync(authorityPath) && entry.id === 'E03' &&
      attempt.status === 'completed' &&
      authorityPath === 'evidence/pilots/e03-blinded-v3/receipt.json' && portablePath
      ? portablePath : authorityPath;
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    if (receipt.experimentId !== entry.id) throw new Error(`${entry.id} status receipt belongs to another experiment`);
    const slots = Array.isArray(receipt.slots) ? receipt.slots.length :
      receipt.classification === 'portable-original-pilot-status-summary' &&
      typeof receipt.completedRuns === 'number' ? receipt.completedRuns : 0;
    let receiptStatus: AttemptStatus | 'unresolved' = 'unresolved';
    if (
      receipt.attemptStatus === 'running' &&
      receipt.researchFinding === false &&
      receipt.scientificDisposition === 'not-tested' &&
      receipt.completedSlots === 0
    ) receiptStatus = 'running';
    else if (receipt.allDispositionsMatched === true && slots === attempt.planned) receiptStatus = 'completed';
    else if (receipt.passed === true && receipt.failure === null && slots === attempt.planned) receiptStatus = 'completed';
    else if (receipt.passed === false && typeof receipt.failure === 'string' && receipt.failure.length > 0) receiptStatus = 'failed';
    else if (receipt.passed === false && receipt.failure === null && slots === attempt.planned) receiptStatus = 'completed';
    if (receiptStatus !== attempt.status || slots !== attempt.completed) {
      throw new Error(`${entry.id} progress contradicts its status-authority receipt`);
    }
    if (
      (typeof receipt.plannedSlots === 'number' && receipt.plannedSlots !== attempt.planned) ||
      (typeof receipt.attemptedSlots === 'number' && receipt.attemptedSlots !== attempt.attempted) ||
      (typeof receipt.completedSlots === 'number' && receipt.completedSlots !== attempt.completed) ||
      (typeof receipt.plannedRuns === 'number' && receipt.plannedRuns !== attempt.planned) ||
      (typeof receipt.attemptedRuns === 'number' && receipt.attemptedRuns !== attempt.attempted) ||
      (typeof receipt.completedRuns === 'number' && receipt.completedRuns !== attempt.completed)
    ) {
      throw new Error(`${entry.id} accounting contradicts its status-authority receipt`);
    }
  }
}
checkE03LocalPilotState(review.experiments.find((entry) => entry.id === 'E03'),
  review.e03PilotCompletionSupplement, review.e03PowerSelectionSupplement,
  review.e03SampleSizeDecisionSupplement);
const e02 = review.experiments.find((entry) => entry.id === 'E02');
if ((e02?.executionReadiness.stage === 'qualification' &&
     e02.executionReadiness.decision === 'complete' && e02.attempt.status === 'completed') !==
    resolvedIds.has('B16')) {
  throw new Error('B16 disposition contradicts the terminal E02 qualification gate');
}
if (resolvedIds.has('B16')) {
  const terminalPath = e02?.evidence.find((evidence) => evidence.statusAuthority)?.path;
  const fullAuditPath = e02?.evidence.find((evidence) => evidence.kind === 'post-run-full-raw-audit')?.path;
  if (!terminalPath || !fullAuditPath) throw new Error('B16 closure lacks terminal and full-audit evidence');
  const terminalBytes = readFileSync(terminalPath);
  const terminal = JSON.parse(terminalBytes.toString('utf8')) as {
    classification?: string; passed?: boolean; failure?: string | null;
    executionCommit?: string; registrationHash?: string; researchFinding?: boolean;
    externalSpend?: number; publicChainTransaction?: boolean;
    slots?: Array<{ passed?: boolean; probesRecomputed?: number }>;
  };
  const audit = JSON.parse(readFileSync(fullAuditPath, 'utf8')) as {
    experimentId?: string; classification?: string; terminalReceiptSha256?: string;
    passed?: boolean; slotsRecomputed?: number; probeReportsRecomputed?: number;
    executionCommit?: string; registrationHash?: string; terminalReceiptPath?: string;
    originalEvidenceRoot?: string; auditCommand?: string; auditExitStatus?: number;
    typescriptVerifierPassed?: boolean; retainedRustAuditorPassed?: boolean; rBoundsRecomputed?: boolean;
    researchFinding?: boolean; scientificDisposition?: string; externalSpend?: number;
    publicChainTransaction?: boolean;
  };
  if (terminal.classification !== 'prospectively-registered-software-qualification' ||
      terminal.passed !== true || terminal.failure !== null ||
      terminal.researchFinding !== false || terminal.externalSpend !== 0 ||
      terminal.publicChainTransaction !== false ||
      terminal.slots?.length !== 5 || terminal.slots.some((slot) =>
        slot.passed !== true || slot.probesRecomputed !== 12) ||
      audit.experimentId !== 'E02' || audit.classification !== 'original-raw-evidence-recomputed-audit' ||
      audit.terminalReceiptSha256 !== `sha256:${createHash('sha256').update(terminalBytes).digest('hex')}` ||
      audit.terminalReceiptPath !== terminalPath || audit.executionCommit !== terminal.executionCommit ||
      audit.registrationHash !== terminal.registrationHash ||
      audit.originalEvidenceRoot !== 'evidence/qualification/e02-v3' ||
      audit.auditCommand !== 'corepack pnpm@12.3.4 run audit:qualification-e02:live' ||
      audit.auditExitStatus !== 0 || audit.typescriptVerifierPassed !== true ||
      audit.retainedRustAuditorPassed !== true || audit.rBoundsRecomputed !== true ||
      audit.researchFinding !== false || audit.scientificDisposition !== 'not-tested' ||
      audit.externalSpend !== 0 || audit.publicChainTransaction !== false ||
      audit.passed !== true || audit.slotsRecomputed !== 5 || audit.probeReportsRecomputed !== 60) {
    throw new Error('B16 closure contradicts the complete audited E02 software qualification');
  }
}
const e03 = review.experiments.find((entry) => entry.id === 'E03');
const e03Preparation = review.e03PilotPreparationSupplement;
if (!e03Preparation || !/^2026-09-15T\d{2}:\d{2}:\d{2}Z$/u.test(e03Preparation.recordedAt) ||
    !/^[0-9a-f]{7}$/u.test(e03Preparation.sourceCommit) ||
    JSON.stringify(e03Preparation.priorReasonCodes) !== JSON.stringify(['E03-topology', 'B07', 'B11']) ||
    e03Preparation.topologyAuditPath !== 'reports/research/e03-prototype-topology-audit-receipt.json' ||
    e03Preparation.stageAllocationPath !== 'protocols/e03-pilot-resource-allocation.v1.json' ||
    !e03Preparation.boundary.includes('B07 remains open for the full campaign')) {
  throw new Error('E03 pilot-preparation progress lacks bounded historical provenance');
}
if (e03 && e03.attempt.status === 'not-started' &&
    e03.executionReadiness.decision === 'blocked') {
  if (e03.executionReadiness.stage !== 'pilot' || e03.executionReadiness.decision !== 'blocked' ||
      JSON.stringify(e03.executionReadiness.reasonCodes) !== JSON.stringify(['B11']) ||
      e03.attempt.status !== 'not-started' ||
      !e03.evidence.some((item) => item.kind === 'development-topology-audit' &&
        item.path === e03Preparation.topologyAuditPath) ||
      !e03.evidence.some((item) => item.kind === 'prospective-stage-allocation' &&
        item.path === e03Preparation.stageAllocationPath)) {
    throw new Error('E03 pilot preparation contradicts its retained topology/allocation gate');
  }
  const topologyBytes = readFileSync(e03Preparation.topologyAuditPath);
  const topology = JSON.parse(topologyBytes.toString('utf8')) as {
    executionCommit?: string; profile?: string; classification?: string; passed?: boolean;
    researchFinding?: boolean; externalSpend?: number; conditionsAudited?: number;
    nurseryContainerCount?: number; roleContainerCount?: number; pairedScenarioCheck?: boolean;
    sharedProcessCheck?: boolean; typescriptVerifierPassed?: boolean; rustAuditorPassed?: boolean;
    rawReceiptPath?: string; rawReceiptSha256?: string;
    originalSlots?: Array<{ nurseryContainerId?: string; signedOriginalDataReconciled?: boolean }>;
  };
  const stageBytes = readFileSync(e03Preparation.stageAllocationPath);
  const stage = JSON.parse(stageBytes.toString('utf8')) as {
    stage?: string; decision?: string; plannedRuns?: number; reserveSlots?: number;
    externalSpend?: number; publicChainTransaction?: boolean; priorCpuHoursCharged?: number;
    reservedCpuHours?: number; priorRetainedStorageGiB?: number;
    reservedWorkingStorageGiB?: number; maximumResidentGiB?: number;
    projectedSequentialWallHours?: number; measurementSourceSha256?: string;
    policySourceSha256?: string;
    measuredMaximums?: { maximumPerSlotWallHours?: number; maximumPerSlotHostOverheadHours?: number };
    projectionCorrectionProvenance?: { priorProjectedSequentialWallHours?: number;
      rawServiceWallMilliseconds?: number; aggregateCollectorWallMilliseconds?: number;
      boundary?: string };
  };
  const topologyDigest = `sha256:${createHash('sha256').update(topologyBytes).digest('hex')}`;
  const policyDigest = `sha256:${createHash('sha256').update(
    readFileSync('protocols/seed-and-resource-allocation.v1.json')).digest('hex')}`;
  const hostOverhead = ((stage.projectionCorrectionProvenance?.rawServiceWallMilliseconds ?? NaN) -
    (stage.projectionCorrectionProvenance?.aggregateCollectorWallMilliseconds ?? NaN)) / 6 / 3_600_000;
  const requiredWall = Math.ceil(((stage.measuredMaximums?.maximumPerSlotWallHours ?? NaN) +
    hostOverhead) * 120 * 1.25 * 10) / 10;
  if (!topology.executionCommit?.startsWith(e03Preparation.sourceCommit) ||
      topology.profile !== 'prototype-v2' || topology.classification !== 'original-prototype-development-audit' ||
      topology.passed !== true || topology.researchFinding !== false || topology.externalSpend !== 0 ||
      topology.conditionsAudited !== 6 || topology.nurseryContainerCount !== 6 ||
      topology.roleContainerCount !== 0 || topology.sharedProcessCheck !== true ||
      topology.pairedScenarioCheck !== true || topology.typescriptVerifierPassed !== true ||
      topology.rustAuditorPassed !== true || topology.originalSlots?.length !== 6 ||
      topology.originalSlots.some((slot) => slot.signedOriginalDataReconciled !== true) ||
      new Set(topology.originalSlots.map((slot) => slot.nurseryContainerId)).size !== 6 ||
      stage.stage !== 'blinded-pilot' || stage.decision !== 'ready' || stage.plannedRuns !== 120 ||
      stage.reserveSlots !== 0 || stage.externalSpend !== 0 || stage.publicChainTransaction !== false ||
      stage.measurementSourceSha256 !== topologyDigest || stage.policySourceSha256 !== policyDigest ||
      !(stage.priorCpuHoursCharged! + stage.reservedCpuHours! <= allocation.localCeiling.cpuHours) ||
      !(stage.priorRetainedStorageGiB! + stage.reservedWorkingStorageGiB! <= allocation.localCeiling.workingStorageGiB) ||
      !(stage.maximumResidentGiB! <= allocation.localCeiling.maximumResidentGiB) ||
      stage.projectionCorrectionProvenance?.priorProjectedSequentialWallHours !== 0.2 ||
      !stage.projectionCorrectionProvenance.boundary?.includes('before packet creation or seed use') ||
      !(hostOverhead > 0) ||
      !Number.isFinite(stage.measuredMaximums?.maximumPerSlotHostOverheadHours ?? NaN) ||
      Math.abs((stage.measuredMaximums?.maximumPerSlotHostOverheadHours ?? NaN) - hostOverhead) > 1e-12 ||
      !(stage.projectedSequentialWallHours! >= requiredWall)) {
    throw new Error('E03 pilot preparation contradicts original development receipts or measured allocation');
  }
  if (topology.rawReceiptPath && existsSync(topology.rawReceiptPath)) {
    const rawDigest = `sha256:${createHash('sha256').update(readFileSync(topology.rawReceiptPath)).digest('hex')}`;
    if (rawDigest !== topology.rawReceiptSha256) {
      throw new Error('E03 development audit contradicts retained original receipt bytes');
    }
  }
  const packetEvidence = e03.evidence.find((item) => item.kind === 'prospective-registration-packet');
  if (e03.evidence.some((item) => item.kind === 'simulated-registration-binding')) {
    throw new Error('E03 blocked packet preparation cannot claim an activated binding');
  }
  if (packetEvidence) {
    if (!['protocols/e03-pilot-registration.v1.json',
      'protocols/e03-pilot-registration.v2.json',
      'protocols/e03-pilot-registration.v3.json'].includes(packetEvidence.path)) {
      throw new Error('E03 blocked pilot packet uses an unexpected registration path');
    }
    const packet = JSON.parse(readFileSync(packetEvidence.path, 'utf8')) as {
      preRegistrationHash?: string; artifact?: { experimentId?: string; protocolGitCommit?: string;
        parameters?: { stage?: string; executionBinding?: {
          prototypeTopology?: { sha256?: string }; stageResourceAllocation?: { sha256?: string };
        } } }; runs?: unknown[];
    };
    const allocationDigest = `sha256:${createHash('sha256').update(stageBytes).digest('hex')}`;
    if (!/^sha256:[0-9a-f]{64}$/u.test(packet.preRegistrationHash ?? '') ||
        packet.artifact?.experimentId !== 'E03' ||
        !/^[0-9a-f]{40}$/u.test(packet.artifact?.protocolGitCommit ?? '') ||
        packet.artifact.parameters?.stage !== 'blinded-pilot' ||
        packet.artifact.parameters.executionBinding?.prototypeTopology?.sha256 !== topologyDigest ||
        packet.artifact.parameters.executionBinding?.stageResourceAllocation?.sha256 !== allocationDigest ||
        packet.runs?.length !== 120) {
      throw new Error('E03 blocked pilot packet contradicts the measured prospective preparation');
    }
  }
}
if (e03 && e03.executionReadiness.stage === 'pilot' &&
    (e03.executionReadiness.decision !== 'blocked' || e03.attempt.status !== 'not-started')) {
  const evidencePath = (kind: string): string | undefined =>
    e03.evidence.find((item) => item.kind === kind)?.path;
  const packetPath = evidencePath('prospective-registration-packet');
  const bindingPath = evidencePath('simulated-registration-binding');
  const topologyPath = evidencePath('development-topology-audit');
  const stageAllocationPath = evidencePath('prospective-stage-allocation');
  if (!packetPath || !bindingPath || !topologyPath || !stageAllocationPath) {
    throw new Error('E03 pilot progression lacks packet, simulated binding, original-topology audit, or measured allocation evidence');
  }
  const packet = JSON.parse(readFileSync(packetPath, 'utf8')) as {
    preRegistrationHash: string; runs: unknown[];
    artifact: { parameters: { stage?: string; seedManifest?: { entries?: unknown[]; reserveSeeds?: number };
      executionBinding?: { prototypeTopology?: { sha256?: string }; stageResourceAllocation?: { sha256?: string } } } };
  };
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as {
    preRegistrationHash?: string; repositoryRegistration?: { path?: string };
    preRunAnchor?: { anchorClass?: string; status?: string };
  };
  const topology = JSON.parse(readFileSync(topologyPath, 'utf8')) as {
    experimentId?: string; profile?: string; classification?: string; conditionsAudited?: number;
    roleContainerCount?: number; nurseryContainerCount?: number; sharedProcessCheck?: boolean;
    auditExitStatus?: number; passed?: boolean; researchFinding?: boolean;
    pairedScenarioCheck?: boolean; typescriptVerifierPassed?: boolean; rustAuditorPassed?: boolean;
    originalSlots?: Array<{ signedOriginalDataReconciled?: boolean; nurseryContainerId?: string;
      nurseryProcessId?: number; roleProcessIds?: Record<string, number> }>;
  };
  const stageAllocation = JSON.parse(readFileSync(stageAllocationPath, 'utf8')) as {
    experimentId?: string; stage?: string; classification?: string; decision?: string;
    plannedRuns?: number; reserveSlots?: number; measurementSourceSha256?: string;
    policySourceSha256?: string; priorCpuHoursCharged?: number; reservedCpuHours?: number;
    priorRetainedStorageGiB?: number; reservedWorkingStorageGiB?: number; externalSpend?: number;
  };
  const sourceSha = (path: string): string => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  if (
    packet.artifact.parameters.stage !== 'blinded-pilot' ||
    packet.artifact.parameters.seedManifest?.entries?.length !== 20 ||
    packet.artifact.parameters.seedManifest?.reserveSeeds !== 0 ||
    packet.runs.length !== 120 ||
    binding.preRegistrationHash !== packet.preRegistrationHash ||
    binding.repositoryRegistration?.path !== packetPath ||
    binding.preRunAnchor?.anchorClass !== 'simulated' ||
    binding.preRunAnchor?.status !== 'confirmed' ||
    topology.experimentId !== 'E03' || topology.profile !== 'prototype-v2' ||
    topology.classification !== 'original-prototype-development-audit' ||
    topology.conditionsAudited !== 6 || topology.roleContainerCount !== 0 ||
    topology.nurseryContainerCount !== 6 || topology.sharedProcessCheck !== true ||
    topology.pairedScenarioCheck !== true || topology.typescriptVerifierPassed !== true ||
    topology.rustAuditorPassed !== true || !topology.originalSlots || topology.originalSlots.length !== 6 ||
    topology.originalSlots.some((slot) => slot.signedOriginalDataReconciled !== true ||
      !/^[a-f0-9]{12}$/u.test(slot.nurseryContainerId ?? '') ||
      !Number.isInteger(slot.nurseryProcessId) ||
      slot.roleProcessIds?.['baby-a'] !== slot.nurseryProcessId ||
      slot.roleProcessIds?.['baby-b'] !== slot.nurseryProcessId) ||
    new Set(topology.originalSlots.map((slot) => slot.nurseryContainerId)).size !== 6 ||
    topology.auditExitStatus !== 0 || topology.passed !== true || topology.researchFinding !== false ||
    stageAllocation.experimentId !== 'E03' || stageAllocation.stage !== 'blinded-pilot' ||
    stageAllocation.classification !== 'prospective-local-stage-allocation' ||
    stageAllocation.decision !== 'ready' || stageAllocation.plannedRuns !== 120 ||
    stageAllocation.reserveSlots !== 0 || stageAllocation.externalSpend !== 0 ||
    stageAllocation.measurementSourceSha256 !== sourceSha(topologyPath) ||
    stageAllocation.policySourceSha256 !== sourceSha('protocols/seed-and-resource-allocation.v1.json') ||
    packet.artifact.parameters.executionBinding?.prototypeTopology?.sha256 !== sourceSha(topologyPath) ||
    packet.artifact.parameters.executionBinding?.stageResourceAllocation?.sha256 !== sourceSha(stageAllocationPath) ||
    !(Number(stageAllocation.priorCpuHoursCharged) + Number(stageAllocation.reservedCpuHours) <= allocation.localCeiling.cpuHours) ||
    !(Number(stageAllocation.priorRetainedStorageGiB) + Number(stageAllocation.reservedWorkingStorageGiB) <=
      allocation.localCeiling.workingStorageGiB)
  ) {
    throw new Error('E03 pilot progression contradicts its exact registered topology, simulated commitment, or measured zero-spend allocation');
  }
}
if (
  allocation.planningAccounting.projectedUncompressedGiBAtMeasuredRate <= allocation.localCeiling.workingStorageGiB ||
  allocation.planningAccounting.projectedSingleCoreHoursAtMeasuredRate <= allocation.localCeiling.cpuHours ||
  allocation.localCeiling.externalSpend !== 0
) {
  throw new Error('resource blocker no longer matches the allocation protocol');
}
if (review.safeLocalNextActions.length < 4 || review.prohibitedUntilClosure.length < 4) {
  throw new Error('campaign review lacks actionable safe/prohibited boundaries');
}
const readinessSource = readFileSync('docs/experiment-readiness-gates.json', 'utf8');
for (const id of expected) {
  if (!readinessSource.includes(`"${id}"`)) throw new Error(`software readiness map omits ${id}`);
}

const ready = review.experiments.filter((entry) => entry.executionReadiness.decision === 'ready').length;
const complete = review.experiments.filter((entry) => entry.executionReadiness.decision === 'complete').length;
console.log(`campaign readiness review passed: ${String(actual.length)} experiments, ${String(findingIds.size)} blockers, ${String(ready)} ready and ${String(complete)} completed gates; decision=${review.decision}`);
