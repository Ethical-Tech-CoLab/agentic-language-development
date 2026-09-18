#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { compileE03Registration } from '@ald/analysis';
import { validateE03FullCollectorQualification } from './check-e03-full-collector-qualification.mjs';
import { resolveRewrittenCommit } from './git-history-rewrite.mjs';
import { hashCanonical } from '@ald/hashing';
import { loadLearnerContract, promptBundleHash } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';

const { values } = parseArgs({
  options: {
    out: {
      type: 'string',
      default: 'evidence/preregistration/e03-pilot-v1-draft.json',
    },
    stage: { type: 'string', default: 'pilot' },
    'attempt-version': { type: 'string', default: 'v1' },
    'primary-seeds': { type: 'string', default: '20' },
    'sample-size-decision': { type: 'string' },
    'e02-receipt': {
      type: 'string',
      default: 'reports/research/e02-v3-qualification-receipt.json',
    },
    'resource-allocation': {
      type: 'string',
      default: 'protocols/seed-and-resource-allocation.v1.json',
    },
    'topology-audit': {
      type: 'string',
      default: 'reports/research/e03-prototype-topology-audit-receipt.json',
    },
    'stage-resource-allocation': { type: 'string' },
  },
});
const stage = values.stage === 'pilot'
  ? 'blinded-pilot'
  : values.stage === 'full'
    ? 'full-qualification'
    : undefined;
if (stage === undefined) {
  throw new Error('--stage must be pilot or full');
}
if (!['v1', 'v2', 'v3'].includes(values['attempt-version']) ||
    (stage !== 'blinded-pilot' && values['attempt-version'] !== 'v1')) {
  throw new Error('--attempt-version must be v1, v2, or v3; later versions are pilot-only');
}
const primarySeeds = Number(values['primary-seeds']);
if (!Number.isInteger(primarySeeds) || primarySeeds < 1) {
  throw new Error('--primary-seeds must be a positive integer');
}
const sha256 = (bytes) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const readJson = async (path) => {
  const bytes = await readFile(resolve(path));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
};
const repositoryPath = (path, label) => {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return path;
};
const sampleSizeDecisionSource = values['sample-size-decision'] === undefined
  ? undefined
  : await readJson(values['sample-size-decision']);
const sampleSizeDecision = sampleSizeDecisionSource?.value;
const e02ReceiptPath = repositoryPath(values['e02-receipt'], '--e02-receipt');
const resourceAllocationPath = repositoryPath(
  values['resource-allocation'],
  '--resource-allocation',
);
const topologyAuditPath = repositoryPath(values['topology-audit'], '--topology-audit');
const stageAllocationPath = repositoryPath(
  values['stage-resource-allocation'] ??
    (stage === 'blinded-pilot' ? 'protocols/e03-pilot-resource-allocation.v1.json' : ''),
  '--stage-resource-allocation',
);
if (stageAllocationPath.length === 0) {
  throw new Error('--stage-resource-allocation is required for --stage full');
}
const e02ReceiptSource = await readJson(e02ReceiptPath);
const resourceAllocationSource = await readJson(resourceAllocationPath);
const topologyAuditSource = await readJson(topologyAuditPath);
const stageAllocationSource = await readJson(stageAllocationPath);
const reserveDesignPath = 'protocols/e03-full-paired-reserve-amendment.v1.json';
const reserveDesignSource = stage === 'full-qualification'
  ? await readJson(reserveDesignPath) : undefined;
const fullCollectorQualificationPath =
  'reports/research/e03-full-collector-qualification-receipt.json';
const fullCollectorQualificationSource = stage === 'full-qualification'
  ? await readJson(fullCollectorQualificationPath) : undefined;
if (reserveDesignSource) {
  const reserve = reserveDesignSource.value;
  const pilotPacket = await readJson('protocols/e03-pilot-registration.v3.json');
  if (reserve.classification !== 'prospective-full-e03-paired-reserve-clarification' ||
      reserve.priorFullPacketExists !== false || reserve.fullSeedsUsed !== false ||
      reserve.pilotRegistrationHash !== pilotPacket.value.preRegistrationHash ||
      reserve.reserveUnit !== 'paired-six-condition-scenario-slot' ||
      reserve.primaryPairedSlots !== 25 || reserve.orderedReservePairedSlots !== 3 ||
      reserve.maximumPrimaryRuns !== 150 || reserve.maximumReserveRuns !== 18 ||
      reserve.scientificThresholdsChanged !== false ||
      reserve.externalSpend !== 0 || reserve.publicChainTransaction !== false ||
      reserve.priorSourceCommit !==
        '5bc008b712b6b38d474a5cbef7045607ff7ddc5c') {
    throw new Error('E03 full registration requires the prospective paired-reserve design clarification');
  }
  execFileSync('git', ['merge-base', '--is-ancestor', resolveRewrittenCommit(reserve.priorSourceCommit), 'HEAD']);
}
const attemptVersion = values['attempt-version'];
const priorVersion = attemptVersion === 'v3' ? 'v2' : 'v1';
const amendmentPath = `protocols/e03-pilot-registration-amendment.${attemptVersion}.json`;
const amendmentSource = attemptVersion !== 'v1'
  ? await readJson(amendmentPath) : undefined;
if (amendmentSource) {
  const priorPacketPath = `protocols/e03-pilot-registration.${priorVersion}.json`;
  const priorBindingPath = `protocols/e03-pilot-registration-binding.${priorVersion}.json`;
  const priorPacket = await readJson(priorPacketPath);
  const priorBinding = await readJson(priorBindingPath);
  if (amendmentSource.value.classification !== 'prospective-unused-registration-supersession' ||
      amendmentSource.value.priorPacketPath !== priorPacketPath ||
      amendmentSource.value.priorBindingPath !== priorBindingPath ||
      amendmentSource.value.newPacketPath !== `protocols/e03-pilot-registration.${attemptVersion}.json` ||
      amendmentSource.value.priorPilotEvidenceRoot !== `evidence/pilots/e03-blinded-${priorVersion}` ||
      amendmentSource.value.priorRegistrationHash !== priorPacket.value.preRegistrationHash ||
      priorBinding.value.preRegistrationHash !== priorPacket.value.preRegistrationHash ||
      amendmentSource.value.priorSeedsUsed !== false ||
      existsSync(amendmentSource.value.priorPilotEvidenceRoot) ||
      (attemptVersion === 'v3' && existsSync('evidence/pilots/e03-blinded-v1'))) {
    throw new Error(`E03 ${attemptVersion} pilot registration requires a retained unused prior packet and prospective amendment`);
  }
}
if (
  e02ReceiptSource.value.experimentId !== 'E02' ||
  e02ReceiptSource.value.passed !== true ||
  e02ReceiptSource.value.researchFinding !== false ||
  e02ReceiptSource.value.externalSpend !== 0 ||
  e02ReceiptSource.value.publicChainTransaction !== false
) {
  throw new Error('E03 registration requires a passing zero-spend E02 v3 qualification receipt');
}
if (
  resourceAllocationSource.value.schemaVersion !== 1 ||
  resourceAllocationSource.value.localCeiling?.externalSpend !== 0 ||
  !(resourceAllocationSource.value.localCeiling.cpuHours > 0) ||
  !(resourceAllocationSource.value.localCeiling.workingStorageGiB > 0) ||
  !(resourceAllocationSource.value.localCeiling.maximumResidentGiB > 0)
) {
  throw new Error('E03 registration requires the zero-spend resource allocation policy');
}
const topologyAudit = topologyAuditSource.value;
if (
  topologyAudit.schemaVersion !== 1 ||
  topologyAudit.experimentId !== 'E03' ||
  topologyAudit.classification !== 'original-prototype-development-audit' ||
  topologyAudit.profile !== 'prototype-v2' ||
  topologyAudit.passed !== true ||
  topologyAudit.auditExitStatus !== 0 ||
  topologyAudit.conditionsAudited !== 6 ||
  topologyAudit.roleContainerCount !== 0 ||
  topologyAudit.nurseryContainerCount !== 6 ||
  topologyAudit.sharedProcessCheck !== true ||
  topologyAudit.pairedScenarioCheck !== true ||
  topologyAudit.typescriptVerifierPassed !== true ||
  topologyAudit.rustAuditorPassed !== true ||
  !Array.isArray(topologyAudit.originalSlots) ||
  topologyAudit.originalSlots.length !== 6 ||
  topologyAudit.originalSlots.some((slot) => slot.signedOriginalDataReconciled !== true ||
    !/^[a-f0-9]{12}$/u.test(slot.nurseryContainerId) ||
    !Number.isSafeInteger(slot.nurseryProcessId) ||
    slot.roleProcessIds?.['baby-a'] !== slot.nurseryProcessId ||
    slot.roleProcessIds?.['baby-b'] !== slot.nurseryProcessId) ||
  new Set(topologyAudit.originalSlots.map((slot) => slot.nurseryContainerId)).size !== 6 ||
  topologyAudit.researchFinding !== false ||
  topologyAudit.externalSpend !== 0 ||
  topologyAudit.publicChainTransaction !== false
) {
  throw new Error('E03 registration requires a complete original Prototype-Mode topology audit');
}
const stageAllocation = stageAllocationSource.value;
if (
  stageAllocation.schemaVersion !== 1 ||
  stageAllocation.experimentId !== 'E03' ||
  stageAllocation.classification !== 'prospective-local-stage-allocation' ||
  stageAllocation.stage !== stage ||
  (stage === 'blinded-pilot' && stageAllocation.plannedRuns !== 120) ||
  !(stageAllocation.reservedCpuHours > 0) ||
  !(stageAllocation.reservedWorkingStorageGiB > 0) ||
  !(stageAllocation.maximumResidentGiB > 0) ||
  stageAllocation.reservedCpuHours > resourceAllocationSource.value.localCeiling.cpuHours ||
  stageAllocation.reservedWorkingStorageGiB > resourceAllocationSource.value.localCeiling.workingStorageGiB ||
  !(stageAllocation.priorCpuHoursCharged >= 0) ||
  !(stageAllocation.priorRetainedStorageGiB >= 0) ||
  stageAllocation.reservedCpuHours + stageAllocation.priorCpuHoursCharged >
    resourceAllocationSource.value.localCeiling.cpuHours ||
  stageAllocation.reservedWorkingStorageGiB + stageAllocation.priorRetainedStorageGiB >
    resourceAllocationSource.value.localCeiling.workingStorageGiB ||
  stageAllocation.maximumResidentGiB > resourceAllocationSource.value.localCeiling.maximumResidentGiB ||
  stageAllocation.externalSpend !== 0 ||
  stageAllocation.measurementSourceSha256 !== sha256(topologyAuditSource.bytes) ||
  stageAllocation.policySourceSha256 !== sha256(resourceAllocationSource.bytes) ||
  stageAllocation.decision !== 'ready'
) {
  throw new Error('E03 registration requires a measured prospective stage allocation within the zero-spend ceiling');
}
if (stage === 'full-qualification' &&
    (sampleSizeDecisionSource === undefined ||
     stageAllocation.primarySlotsPerCondition !== primarySeeds ||
     stageAllocation.reserveSlotsPerCondition !== Math.ceil(0.1 * primarySeeds) ||
     stageAllocation.plannedRuns !== 6 *
       (primarySeeds + Math.ceil(0.1 * primarySeeds)) ||
     stageAllocation.maximumParallelRuns !== 1 ||
     stageAllocation.pilotMeasurementSourcePath !== sampleSizeDecision.pilotReceiptPath ||
     stageAllocation.pilotMeasurementSourceSha256 !==
       sampleSizeDecision.pilotReceiptSha256 ||
     stageAllocation.sampleSizeDecisionPath !== values['sample-size-decision'] ||
     stageAllocation.sampleSizeDecisionSha256 !== sha256(sampleSizeDecisionSource.bytes))) {
  throw new Error('E03 full registration allocation contradicts the selected pilot decision or reserve matrix');
}
const bindingSourcePaths = [
  'packages/analysis/src/e03-design.ts',
  'packages/analysis/src/e03-pilot.ts',
  'packages/analysis/src/e03-registration.ts',
  'packages/ops/src/research-preflight.ts',
  'packages/orchestrator/src/index.ts',
  'protocols/e03-prototype-mode-amendment.v2.json',
  'scripts/build-e03-registration.mjs',
  'scripts/run-e03-power-selection.mjs',
  'scripts/e03-power-selection.R',
  ...(fullCollectorQualificationSource ? [
    'packages/analysis/src/e03-full.ts',
    'packages/analysis/src/e03-full-qualification.ts',
    'scripts/check-e03-full-collector-qualification.mjs',
  ] : []),
  ...(reserveDesignSource ? [reserveDesignPath] : []),
];
const sourceFiles = await Promise.all(bindingSourcePaths.map(async (path) => ({
  path,
  sha256: sha256(await readFile(resolve(path))),
})));
const trackedSourcePaths = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) =>
    path.startsWith('packages/') ||
    path.startsWith('twins/') ||
    path.startsWith('deploy/') ||
    path.startsWith('scripts/'),
  );
const sourceManifest = await Promise.all(trackedSourcePaths.map(async (path) =>
  `${path}\t${sha256(await readFile(resolve(path)))}\n`,
));
sourceManifest.sort();
const executionBinding = {
  version: 1,
  sourceFiles,
  rootBuildInputs: {
    packageJsonSha256: sha256(await readFile('package.json')),
    lockfileSha256: sha256(await readFile('pnpm-lock.yaml')),
    sourceTreeSha256: sha256(Buffer.from(sourceManifest.join(''), 'utf8')),
    buildCommand: 'pnpm build',
  },
  topology: {
    mode: 'prototype',
    learnerContainersPerSlot: 0,
    nurseryContainersPerSlot: 1,
    sharedNurseryProcess: true,
    maximumParallelSlots: 1,
    adapterTransport: 'in-process',
    adapterTiming: 'immediate',
    turnResponseBudgetMs: 2_000,
    learnerTrack: 'no-learning',
  },
  signing: {
    provider: 'controller-ephemeral-per-run',
    exactRunAuthorization: false,
    learnerAccess: false,
  },
  dependency: {
    experimentId: 'E02',
    disposition: 'software-qualified',
    receiptPath: e02ReceiptPath,
    receiptSha256: sha256(e02ReceiptSource.bytes),
    registrationHash: e02ReceiptSource.value.registrationHash,
  },
  prototypeTopology: {
    path: topologyAuditPath,
    sha256: sha256(topologyAuditSource.bytes),
    auditExitStatus: 0, conditionsAudited: 6, mode: 'prototype',
  },
  resourceAllocation: {
    path: resourceAllocationPath,
    sha256: sha256(resourceAllocationSource.bytes),
    externalSpend: 0,
    publicChainTransaction: false,
  },
  stageResourceAllocation: {
    path: stageAllocationPath,
    sha256: sha256(stageAllocationSource.bytes),
    stage,
    plannedRuns: stageAllocation.plannedRuns,
    reservedCpuHours: stageAllocation.reservedCpuHours,
    reservedWorkingStorageGiB: stageAllocation.reservedWorkingStorageGiB,
    maximumResidentGiB: stageAllocation.maximumResidentGiB,
    priorCpuHoursCharged: stageAllocation.priorCpuHoursCharged,
    priorRetainedStorageGiB: stageAllocation.priorRetainedStorageGiB,
    externalSpend: 0,
  },
  ...(amendmentSource ? { registrationAmendment: {
    path: amendmentPath,
    sha256: sha256(amendmentSource.bytes),
  } } : {}),
  ...(reserveDesignSource ? { reserveDesignAmendment: {
    path: reserveDesignPath,
    sha256: sha256(reserveDesignSource.bytes),
    policy: 'paired-six-condition-scenario-slot',
  } } : {}),
  ...(fullCollectorQualificationSource ? { fullCollectorQualification: {
    path: fullCollectorQualificationPath,
    sha256: sha256(fullCollectorQualificationSource.bytes),
    executionCommit: fullCollectorQualificationSource.value.execution.commit,
  } } : {}),
  evidencePolicy: {
    anchorClass: 'simulated',
    publicTimestamp: false,
    originalEvidenceImmutable: true,
    pilotResearchFinding: false,
  },
};

if (stage === 'full-qualification') {
  try {
    validateE03FullCollectorQualification(fullCollectorQualificationSource.value);
    execFileSync('git', ['merge-base', '--is-ancestor',
      resolveRewrittenCommit(fullCollectorQualificationSource.value.execution.commit), 'HEAD']);
  } catch (error) {
    throw new Error('E03 full packet requires a valid retained collector and statistical-analysis software qualification receipt', { cause: error });
  }
  if (sampleSizeDecision === undefined) {
    throw new Error('--sample-size-decision is required for --stage full');
  }
  const pilot = await readJson(sampleSizeDecision.pilotReceiptPath);
  if (sha256(pilot.bytes) !== sampleSizeDecision.pilotReceiptSha256) {
    throw new Error('sample-size decision pilot receipt digest does not match retained bytes');
  }
  if (
    pilot.value.experimentId !== 'E03' ||
    pilot.value.stage !== 'blinded-pilot' ||
    pilot.value.registrationHash !== sampleSizeDecision.pilotRegistrationHash ||
    pilot.value.plannedRuns !== 120 ||
    pilot.value.attemptedRuns !== 120 ||
    pilot.value.completedRuns !== 120 ||
    pilot.value.validRuns !== 120 ||
    pilot.value.sampleSizeEligible !== true ||
    pilot.value.scientificDisposition !== 'not-tested'
  ) {
    throw new Error('sample-size decision does not identify a complete eligible E03 pilot');
  }

  const reduction = await readJson(sampleSizeDecision.pilotReductionPath);
  if (sha256(reduction.bytes) !== sampleSizeDecision.pilotReductionSha256) {
    throw new Error('sample-size decision pilot reduction digest does not match retained bytes');
  }
  if (
    reduction.value.classification !== 'outcome-blind-pilot-sample-size-input' ||
    reduction.value.researchFinding !== false ||
    reduction.value.scientificDisposition !== 'not-tested' ||
    reduction.value.pilotSlots !== 20 ||
    reduction.value.episodesPerSlot !== 200 ||
    reduction.value.pilotRegistrationHash !== sampleSizeDecision.pilotRegistrationHash ||
    reduction.value.pilotReceipt?.sha256 !== sampleSizeDecision.pilotReceiptSha256 ||
    reduction.value.largestLatentPilotSd !== sampleSizeDecision.largestLatentPilotSd ||
    reduction.value.selectedPrimarySeeds !== sampleSizeDecision.selectedPrimarySeeds ||
    reduction.value.requiresProspectiveAmendment !== false
  ) {
    throw new Error('sample-size decision does not match the outcome-blind pilot reduction');
  }

  const power = await readJson(sampleSizeDecision.powerReceiptPath);
  if (sha256(power.bytes) !== sampleSizeDecision.powerReceiptSha256) {
    throw new Error('sample-size decision power receipt digest does not match retained bytes');
  }
  if (
    power.value.experimentId !== 'E03' ||
    power.value.classification !== 'outcome-blind-power-simulation' ||
    power.value.decisionRule !== sampleSizeDecision.decisionRule ||
    power.value.pilotRegistrationHash !== sampleSizeDecision.pilotRegistrationHash ||
    power.value.pilotReceipt?.sha256 !== sampleSizeDecision.pilotReceiptSha256 ||
    power.value.pilotReduction?.sha256 !== sampleSizeDecision.pilotReductionSha256 ||
    power.value.largestLatentPilotSd !== sampleSizeDecision.largestLatentPilotSd ||
    power.value.selectedPrimarySeeds !== sampleSizeDecision.selectedPrimarySeeds ||
    power.value.monteCarloRepetitions !== sampleSizeDecision.monteCarloRepetitions ||
    power.value.monteCarloLower95 !== sampleSizeDecision.monteCarloLower95 ||
    power.value.invalidAsFailureSensitivity?.forcedFailuresPerCondition !==
      sampleSizeDecision.invalidAsFailureSensitivity?.forcedFailuresPerCondition ||
    power.value.invalidAsFailureSensitivity?.successes !==
      sampleSizeDecision.invalidAsFailureSensitivity?.successes ||
    power.value.invalidAsFailureSensitivity?.lower95 !==
      sampleSizeDecision.invalidAsFailureSensitivity?.lower95 ||
    power.value.invalidAsFailureSensitivity?.upper95 !==
      sampleSizeDecision.invalidAsFailureSensitivity?.upper95 ||
    power.value.passed !== true
  ) {
    throw new Error('sample-size decision does not match a passing E03 power receipt');
  }
}
const protocolGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const symbolInventorySize = 32;
const scenarioBundleHash = hashCanonical(HASH_DOMAINS.scenarioBundle, {
  version: 1,
  attributeCount: 2,
  valuesPerAttribute: 4,
  candidatesPerEpisode: 4,
  heldOutTypeCodes: [],
  symbolInventory: fixedTokenInventory(symbolInventorySize),
  interactionMode: 'cooperative-signaling',
});
const noLearningContract = loadLearnerContract('no-learning');
const baseConfig = buildRunConfig({
  runId: 'e03-registration-template',
  experimentId: 'E03',
  randomSeed: 'unrealized-seed',
  deploymentMode: 'prototype',
  registrationClass: 'qualification',
  babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
  babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
  learningSignal: 'none',
  turnResponseBudgetMs: 2_000,
  maxTurnsPerRun: 1,
  evaluationTurns: 200,
  evaluationSeeds: primarySeeds,
  checkpointEventInterval: 1_024,
  symbolInventorySize,
  scenarioBundleHash,
  promptBundleHash: promptBundleHash([noLearningContract]),
  protocolGitCommit,
  preRegistrationHash: hashCanonical(HASH_DOMAINS.preRegistration, 'draft'),
});
const result = compileE03Registration({
  baseConfig,
  stage,
  primarySeeds,
  attemptVersion: values['attempt-version'],
  executionBinding,
  ...(sampleSizeDecision === undefined ? {} : { sampleSizeDecision }),
  hypothesis:
    stage === 'blinded-pilot'
      ? 'Estimate outcome-blinded E03 variance and feasibility inputs without testing the E03 qualification claim.'
      : 'Disabled, constant, random, shuffled, and no-learning controls are ' +
        'equivalent to the registered 0.20-0.30 chance bounds while the oracle ' +
        'exceeds the registered adequacy and separation thresholds.',
  analysisPlan:
    'RESEARCH.md Appendix D §D.6-§D.10: seed-level TOST with ' +
    'Holm-Bonferroni correction, one-sided seed-level oracle adequacy, ' +
    'Holm-adjusted paired separation, bootstrap sensitivity intervals, ' +
    'mandatory case-level high-seed review, registered exclusions, and no ' +
    'outcome-dependent stopping or replacement.',
});
const outputPath = resolve(values.out);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
console.log(`preRegistrationHash=${result.preRegistrationHash}`);
console.log(`stage=${stage}`);
console.log(`plannedRuns=${String(result.runs.length)}`);
console.log(result.claimBoundary);
