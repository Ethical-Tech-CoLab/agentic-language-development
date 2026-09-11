#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { compileE03Registration } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';
import { loadLearnerContract, promptBundleHash } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { HASH_DOMAINS } from '@ald/types';

const { values } = parseArgs({
  options: {
    out: {
      type: 'string',
      default: 'evidence/preregistration/e03-v1-draft.json',
    },
    'primary-seeds': { type: 'string', default: '75' },
  },
});
const primarySeeds = Number(values['primary-seeds']);
if (!Number.isInteger(primarySeeds) || primarySeeds < 1) {
  throw new Error('--primary-seeds must be a positive integer');
}
const protocolGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const scenarioBundleHash = hashCanonical(HASH_DOMAINS.scenarioBundle, {
  version: 1,
  generator: 'referential-game-v1',
  attributeCount: 2,
  valuesPerAttribute: 4,
  candidateCount: 4,
  humanReadableLabels: false,
});
const noLearningContract = loadLearnerContract('no-learning');
const baseConfig = buildRunConfig({
  runId: 'e03-registration-template',
  experimentId: 'E03',
  randomSeed: 'unrealized-seed',
  deploymentMode: 'research-grade',
  registrationClass: 'confirmatory',
  babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
  babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
  learningSignal: 'none',
  maxTurnsPerRun: 1,
  evaluationTurns: 200,
  evaluationSeeds: primarySeeds,
  scenarioBundleHash,
  promptBundleHash: promptBundleHash([noLearningContract]),
  protocolGitCommit,
  preRegistrationHash: hashCanonical(HASH_DOMAINS.preRegistration, 'draft'),
});
const result = compileE03Registration({
  baseConfig,
  primarySeeds,
  hypothesis:
    'Disabled, constant, random, shuffled, and no-learning controls are ' +
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
console.log(`plannedRuns=${String(result.runs.length)}`);
console.log(result.claimBoundary);
