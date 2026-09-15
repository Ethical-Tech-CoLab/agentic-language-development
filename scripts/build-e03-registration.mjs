#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { compileE03Registration } from '@ald/analysis';
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
const e02ReceiptSource = await readJson(e02ReceiptPath);
const resourceAllocationSource = await readJson(resourceAllocationPath);
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
const bindingSourcePaths = [
  'packages/analysis/src/e03-design.ts',
  'packages/analysis/src/e03-pilot.ts',
  'packages/analysis/src/e03-registration.ts',
  'packages/ops/src/research-preflight.ts',
  'packages/orchestrator/src/index.ts',
  'scripts/build-e03-registration.mjs',
  'scripts/run-e03-power-selection.mjs',
  'scripts/e03-power-selection.R',
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
    mode: 'research-grade',
    learnerContainersPerSlot: 2,
    nurseryContainersPerSlot: 1,
    maximumParallelSlots: 1,
    adapterTransport: 'container-tcp',
    adapterTiming: 'normalized',
    adapterDeadlineMs: 2_000,
    learnerTrack: 'no-learning',
  },
  signing: {
    provider: 'si-fort-files',
    exactRunAuthorization: true,
    learnerAccess: false,
  },
  dependency: {
    experimentId: 'E02',
    disposition: 'software-qualified',
    receiptPath: e02ReceiptPath,
    receiptSha256: sha256(e02ReceiptSource.bytes),
    registrationHash: e02ReceiptSource.value.registrationHash,
  },
  resourceAllocation: {
    path: resourceAllocationPath,
    sha256: sha256(resourceAllocationSource.bytes),
    externalSpend: 0,
    publicChainTransaction: false,
  },
  evidencePolicy: {
    anchorClass: 'simulated',
    publicTimestamp: false,
    originalEvidenceImmutable: true,
    pilotResearchFinding: false,
  },
};

if (stage === 'full-qualification') {
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
  deploymentMode: 'research-grade',
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
