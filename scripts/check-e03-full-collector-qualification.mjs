#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  analyzeE03FullQualification,
  E03_COMMUNICATION_CONDITIONS,
} from '@ald/analysis';

const receiptPath = 'reports/research/e03-full-collector-qualification-receipt.json';
const sourcePaths = [
  'packages/analysis/src/e03-design.ts',
  'packages/analysis/src/e03-full.ts',
  'packages/analysis/src/e03.ts',
  'packages/analysis/src/e03-full-qualification.ts',
  'scripts/check-e03-full-collector-qualification.mjs',
];
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sourceArtifact = (path) => {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symbolic link`);
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
};
const hashes = (slot) => Array.from({ length: 200 }, (_, episode) =>
  `sha256:${(slot * 200 + episode).toString(16).padStart(64, '0')}`);
const registered = Array.from({ length: 28 }, (_, index) => index + 1)
  .flatMap((slot) => E03_COMMUNICATION_CONDITIONS.map((condition) => ({
    slot,
    condition,
    use: slot <= 25 ? 'primary' : 'reserve',
    config: {
      runId: `development-e03-full-${condition}-s${String(slot).padStart(3, '0')}`,
      randomSeed: `development-e03-full-scenario-${slot}`,
    },
  })));
const developmentAttempt = (run, profile = 'qualifying') => ({
  runId: run.config.runId,
  slot: run.slot,
  use: run.use,
  condition: run.condition,
  valid: true,
  bundleVerified: true,
  agreements: profile === 'qualifying'
    ? run.condition === 'oracle' ? 188 + (run.slot % 5) : 46 +
      ((run.slot + E03_COMMUNICATION_CONDITIONS.indexOf(run.condition)) % 9)
    : run.condition === 'oracle' ? 80 : 50,
  scenarioStateHashes: hashes(run.slot),
});
const primary = (profile) => registered.filter((run) => run.use === 'primary')
  .map((run) => developmentAttempt(run, profile));
const reserve = (slot, profile) => registered.filter((run) => run.slot === slot)
  .map((run) => developmentAttempt(run, profile));
const invalidateSlot = (attempts, slot) => attempts.map((attempt) =>
  attempt.slot !== slot ? attempt : {
    ...attempt,
    valid: false,
    invalidReason: 'verifier-failure',
    bundleVerified: undefined,
    agreements: undefined,
    scenarioStateHashes: undefined,
  });
const invalidateOne = (attempts, slot) => attempts.map((attempt) =>
  attempt.slot !== slot || attempt.condition !== 'random' ? attempt : {
    ...attempt,
    valid: false,
    invalidReason: 'verifier-failure',
    bundleVerified: undefined,
    agreements: undefined,
    scenarioStateHashes: undefined,
  });

export function runE03FullCollectorQualificationFixtures() {
  const qualifying = analyzeE03FullQualification({
    registered,
    attempted: primary('qualifying'),
    analysisSeed: 'development-e03-full-qualification-pass',
    bootstrapIterations: 200,
  });
  assert.equal(qualifying.numericDisposition, 'thresholds-met');
  assert.equal(qualifying.scientificDisposition, 'not-tested');
  assert.equal(qualifying.reconciliation.includedPairs.length, 25);

  const numericFailure = analyzeE03FullQualification({
    registered,
    attempted: primary('numeric-failure'),
    analysisSeed: 'development-e03-full-qualification-failure',
    bootstrapIterations: 200,
  });
  assert.equal(numericFailure.numericDisposition, 'thresholds-not-met');
  assert.equal(numericFailure.scientificDisposition, 'not-tested');
  assert.equal(numericFailure.reconciliation.includedPairs.length, 25);

  const restored = analyzeE03FullQualification({
    registered,
    attempted: [...invalidateOne(primary('qualifying'), 7), ...reserve(26, 'qualifying')],
    analysisSeed: 'development-e03-full-qualification-reserve',
    bootstrapIterations: 200,
  });
  assert.equal(restored.numericDisposition, 'thresholds-met');
  assert.deepEqual(restored.reconciliation.replacements,
    [{ primarySlot: 7, reserveSlot: 26 }]);
  assert.equal(restored.reconciliation.validButExcludedRunIds.length, 5);

  let exhausted = invalidateSlot(primary('qualifying'), 1);
  exhausted = invalidateSlot(exhausted, 2);
  exhausted = invalidateSlot(exhausted, 3);
  exhausted = invalidateSlot(exhausted, 4);
  const incomplete = analyzeE03FullQualification({
    registered,
    attempted: [...exhausted, ...reserve(26, 'qualifying'), ...reserve(27, 'qualifying'),
      ...reserve(28, 'qualifying')],
    analysisSeed: 'development-e03-full-qualification-exhausted',
    bootstrapIterations: 200,
  });
  assert.equal(incomplete.numericDisposition, 'incomplete');
  assert.equal(incomplete.numericAnalysis, null);
  assert.equal(incomplete.scientificDisposition, 'not-tested');

  return {
    qualifyingNumericFixture: { disposition: qualifying.numericDisposition, pairs: 25 },
    numericFailureFixture: { disposition: numericFailure.numericDisposition, pairs: 25 },
    pairedReserveFixture: { disposition: restored.numericDisposition, replacements: 1,
      validButExcludedCompanions: 5 },
    exhaustionFixture: { disposition: incomplete.numericDisposition, pairs: 24 },
  };
}

export function validateE03FullCollectorQualification(receipt, root = process.cwd()) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.experimentId, 'E03');
  assert.equal(receipt.stage, 'full-qualification');
  assert.equal(receipt.classification,
    'development-synthetic-e03-full-collector-and-analysis-software-qualification');
  assert.equal(receipt.passed, true);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registeredExecution, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.syntheticFixturesOnly, true);
  assert.equal(receipt.fullRegistrationOrSeedUsed, false);
  assert.equal(receipt.externalSpend, 0);
  assert.equal(receipt.publicChainTransaction, false);
  assert.match(receipt.execution.commit, /^[0-9a-f]{40}$/u);
  assert.match(receipt.execution.tree, /^[0-9a-f]{40}$/u);
  assert.match(receipt.execution.version, /^0\.1\.\d+$/u);
  assert.deepEqual(receipt.sourceArtifacts.map((artifact) => artifact.path), sourcePaths);
  for (const artifact of receipt.sourceArtifacts) {
    assert.match(artifact.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(Number.isInteger(artifact.bytes) && artifact.bytes > 0);
    const path = resolve(root, artifact.path);
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, `${artifact.path} must not be a symbolic link`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, artifact.bytes, `${artifact.path} byte count changed`);
    assert.equal(sha256(bytes), artifact.sha256, `${artifact.path} digest changed`);
  }
  assert.deepEqual(receipt.fixtures, runE03FullCollectorQualificationFixtures());
  assert.match(receipt.claimBoundary,
    /not a registered E03 execution or behavioral result/u);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
if (values.write) {
  assert.equal(existsSync(receiptPath), false, 'refusing to overwrite qualification receipt');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), '',
    'commit the exact qualification sources before creating the retained receipt');
  const receipt = {
    schemaVersion: 1,
    experimentId: 'E03',
    stage: 'full-qualification',
    classification: 'development-synthetic-e03-full-collector-and-analysis-software-qualification',
    passed: true,
    researchFinding: false,
    registeredExecution: false,
    scientificDisposition: 'not-tested',
    syntheticFixturesOnly: true,
    fullRegistrationOrSeedUsed: false,
    externalSpend: 0,
    publicChainTransaction: false,
    execution: {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
      version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    },
    sourceArtifacts: sourcePaths.map(sourceArtifact),
    fixtures: runE03FullCollectorQualificationFixtures(),
    claimBoundary: 'This is a synthetic development software qualification of full-stage collection, paired-reserve reconciliation, and numerical analysis. It is not a registered E03 execution or behavioral result; a fresh prospective packet, live admission, original evidence, and post-batch verification remain required.',
  };
  validateE03FullCollectorQualification(receipt);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  console.log(`wrote ${receiptPath}`);
} else {
  assert.equal(existsSync(receiptPath), true, 'E03 full collector qualification receipt is missing');
  validateE03FullCollectorQualification(JSON.parse(readFileSync(receiptPath, 'utf8')));
  console.log('E03 full collector and analysis software qualification valid');
}
}
