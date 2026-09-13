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
const sampleSizeDecisionSource = values['sample-size-decision'] === undefined
  ? undefined
  : await readJson(values['sample-size-decision']);
const sampleSizeDecision = sampleSizeDecisionSource?.value;

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

  const power = await readJson(sampleSizeDecision.powerReceiptPath);
  if (sha256(power.bytes) !== sampleSizeDecision.powerReceiptSha256) {
    throw new Error('sample-size decision power receipt digest does not match retained bytes');
  }
  if (
    power.value.experimentId !== 'E03' ||
    power.value.classification !== 'outcome-blind-power-simulation' ||
    power.value.decisionRule !== sampleSizeDecision.decisionRule ||
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
  maxTurnsPerRun: 1,
  evaluationTurns: 200,
  evaluationSeeds: primarySeeds,
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
