#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  CONFIRMATORY_PILOT_SUMMARY_VERSION,
  confirmatoryPilotInvalidProbabilityUpper95,
  simulateConfirmatoryComponentPower,
} from '@ald/analysis';

import { venvPython } from './resolve-venv-python.mjs';

const receiptPath = 'reports/research/confirmatory-power-simulator-qualification-receipt.json';
const fixtureSeed = 'ald-confirmatory-power-software-qualification/v1';
const fixtureUpperSd = 0.08;
const sourcePaths = [
  'packages/analysis/src/confirmatory-power-simulation.ts',
  'packages/analysis/src/confirmatory-selection.ts',
  'packages/analysis/src/confirmatory-pilot.ts',
  'packages/analysis/src/hypothesis.ts',
  'packages/analysis/src/special.ts',
  'packages/hashing/src/prng.ts',
  'packages/analysis/__tests__/confirmatory-power-simulation.test.ts',
  'protocols/confirmatory-power-simulator.v1.json',
  'scripts/check-confirmatory-power-simulator.mjs',
  'scripts/check-confirmatory-power-simulator-qualification.mjs',
];
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sourceArtifact = (path, root = process.cwd()) => {
  const resolved = resolve(root, path);
  const stat = lstatSync(resolved);
  assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symbolic link`);
  const bytes = readFileSync(resolved);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
};

function softwareFixture() {
  return {
    schemaVersion: 2,
    analysisVersion: CONFIRMATORY_PILOT_SUMMARY_VERSION,
    stage: 'blinded-pilot',
    status: 'complete',
    experiments: Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS).map(([id, memberIds]) => ({
      id,
      memberIds,
      status: 'complete',
      plannedSlots: 20,
      attemptedSlots: 20,
      completedSlots: 20,
      validSlots: 20,
      invalidSlots: 0,
      invalidProbabilityUpper95: confirmatoryPilotInvalidProbabilityUpper95(0, 20),
      invalidProbabilityUpper95Method: 'wilson-score-one-sided-95',
    })),
    members: Object.entries(CONFIRMATORY_PILOT_COMPONENTS).map(([id, components]) => ({
      id,
      components: components.map((component) => ({
        id: component,
        n: 20,
        mean: 0,
        sampleSd: fixtureUpperSd,
        upper95Sd: fixtureUpperSd,
        upper95SdMethod: 'synthetic-software-qualification-fixture',
      })),
    })),
    researchFinding: false,
    scientificDisposition: 'not-tested',
    confirmatoryEstimateUse: false,
    selectionEligible: true,
  };
}

function independentPythonReferences() {
  const program = String.raw`
import math
import sys
from scipy import stats
alpha = 0.05 / 9
ns = (25, 50, 75, 100, 125, 150, 200, 300)
def t_power(n, standardized_delta):
    critical = stats.t.ppf(1.0 - alpha, n - 1)
    return stats.nct.sf(critical, n - 1, math.sqrt(n) * standardized_delta)
def binomial_power(n):
    p_values = [stats.binom.sf(k - 1, n, 0.5) for k in range(n + 1)]
    below = [j for j, p in enumerate(p_values) if p < alpha]
    if not below:
        return 0.0
    return stats.binom.sf(below[0] - 1, n, 0.75)
print(f"Python {sys.version.split()[0]} + numpy/scipy (repo .venv, pinned)")
for n in ns:
    print("%d,%r,%r,%r,%r"
          % (n, float(t_power(n, 0.05 / 0.08)), float(t_power(n, 0.02 / 0.08)),
             float(t_power(n, 0.10 / 0.08)), float(binomial_power(n))))
`;
  const lines = execFileSync(venvPython(), ['-c', program],
    { encoding: 'utf8' }).trim().split('\n');
  const implementation = lines.shift();
  assert.match(implementation, /^Python /u);
  return {
    implementation,
    rows: lines.map((line) => {
      const [n, delta005, delta002, delta010, binary075] = line.split(',').map(Number);
      assert.ok([n, delta005, delta002, delta010, binary075].every(Number.isFinite));
      return { primarySeeds: n, delta005, delta002, delta010, binary075 };
    }),
  };
}

const componentReferenceKey = {
  H1: { disabled: 'delta005', constant: 'delta005', random: 'delta005', shuffled: 'delta005' },
  H2: { 'target-action-probability': 'delta005' },
  H3: { 'held-out-success': 'delta005' },
  H4: { 'brier-improvement': 'delta002' },
  H5: { 'stable-acquisition': 'binary075', 'first-stable-turn-ratio': 'binary075' },
  H6a: { 'restricted-mean-turns': 'delta010' },
  H6b: { 'excess-cmi-bits': 'delta002' },
  H7: { 'replacement-degradation': 'delta005' },
  H8: { 'informativeness-bits': 'delta005', 'normalized-ambiguity': 'delta010' },
};

export function runConfirmatoryPowerSimulatorQualification() {
  const simulation = simulateConfirmatoryComponentPower(softwareFixture(), fixtureSeed);
  const references = independentPythonReferences();
  assert.deepEqual(simulation.rows.map((row) => row.primarySeeds),
    references.rows.map((row) => row.primarySeeds));
  let maximumStandardErrors = 0;
  let comparisons = 0;
  for (const [rowIndex, row] of simulation.rows.entries()) {
    const reference = references.rows[rowIndex];
    for (const [memberId, components] of Object.entries(componentReferenceKey)) {
      for (const [componentId, referenceKey] of Object.entries(components)) {
        const expected = reference[referenceKey];
        const observed = row.componentDecisionSuccesses[memberId][componentId] / row.repetitions;
        const standardError = Math.sqrt(expected * (1 - expected) / row.repetitions);
        const standardized = standardError === 0 ? observed === expected ? 0 : Infinity :
          Math.abs(observed - expected) / standardError;
        maximumStandardErrors = Math.max(maximumStandardErrors, standardized);
        assert.ok(standardized <= 5, `${row.primarySeeds}.${memberId}.${componentId} differs from Python by ${standardized} SE`);
        comparisons += 1;
      }
    }
  }
  return {
    fixtureSeed,
    fixtureUpperSd,
    candidates: simulation.rows.length,
    componentsPerCandidate: 14,
    repetitionsPerCandidate: simulation.rows[0].repetitions,
    independentReference: {
      implementation: references.implementation,
      comparisons,
      maximumAbsoluteStandardErrors: maximumStandardErrors,
      thresholdStandardErrors: 5,
      rows: references.rows,
    },
    outputSha256: sha256(JSON.stringify(simulation)),
    firstCandidateCounts: simulation.rows[0].componentDecisionSuccesses,
    finalCandidateCounts: simulation.rows.at(-1).componentDecisionSuccesses,
    diagnosticDependenceModel: simulation.rows[0].diagnosticDependenceModel,
  };
}

export function validateConfirmatoryPowerSimulatorQualification(receipt, root = process.cwd()) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, 'synthetic-confirmatory-power-simulator-software-qualification');
  assert.equal(receipt.passed, true);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registeredExecution, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.syntheticFixturesOnly, true);
  assert.equal(receipt.eligiblePilotUsed, false);
  assert.equal(receipt.campaignPowerResult, false);
  assert.equal(receipt.selectedPrimarySeeds, null);
  assert.equal(receipt.resourceAuthorization, false);
  assert.equal(receipt.externalSpend, 0);
  assert.match(receipt.execution.commit, /^[0-9a-f]{40}$/u);
  assert.match(receipt.execution.tree, /^[0-9a-f]{40}$/u);
  assert.match(receipt.execution.version, /^0\.1\.\d+$/u);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', `${receipt.execution.commit}^{tree}`), receipt.execution.tree,
    'receipt tree must belong to its execution commit');
  const versionAtExecution = JSON.parse(git('show', `${receipt.execution.commit}:package.json`)).version;
  assert.equal(versionAtExecution, receipt.execution.version,
    'receipt version must belong to its execution commit');
  assert.deepEqual(receipt.sourceArtifacts.map((artifact) => artifact.path), sourcePaths);
  for (const expected of receipt.sourceArtifacts) {
    const committedBytes = execFileSync('git', ['-C', root, 'show',
      `${receipt.execution.commit}:${expected.path}`]);
    assert.equal(committedBytes.length, expected.bytes,
      `${expected.path} byte count differs from the execution commit`);
    assert.equal(sha256(committedBytes), expected.sha256,
      `${expected.path} digest differs from the execution commit`);
    if (expected.path !== 'scripts/check-confirmatory-power-simulator-qualification.mjs') {
      assert.deepEqual(sourceArtifact(expected.path, root), expected);
    }
  }
  assert.deepEqual(receipt.qualification, runConfirmatoryPowerSimulatorQualification());
  assert.match(receipt.claimBoundary, /not a pilot, campaign power result, selected N/u);
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
      classification: 'synthetic-confirmatory-power-simulator-software-qualification',
      capturedAt: '2026-09-20',
      passed: true,
      researchFinding: false,
      registeredExecution: false,
      scientificDisposition: 'not-tested',
      syntheticFixturesOnly: true,
      eligiblePilotUsed: false,
      campaignPowerResult: false,
      selectedPrimarySeeds: null,
      resourceAuthorization: false,
      externalSpend: 0,
      execution: {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
        version: JSON.parse(readFileSync('package.json', 'utf8')).version,
      },
      sourceArtifacts: sourcePaths.map((path) => sourceArtifact(path)),
      qualification: runConfirmatoryPowerSimulatorQualification(),
      claimBoundary: 'This qualifies deterministic synthetic software paths against independent Python reference power calculations. It is not a pilot, campaign power result, selected N, resource authorization, study outcome, scientific finding, independent human review, or publication result.',
    };
    validateConfirmatoryPowerSimulatorQualification(receipt);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    console.log(`wrote ${receiptPath}`);
  } else {
    assert.equal(existsSync(receiptPath), true, 'confirmatory power-simulator qualification receipt is missing');
    validateConfirmatoryPowerSimulatorQualification(JSON.parse(readFileSync(receiptPath, 'utf8')));
    console.log('Confirmatory power-simulator software qualification valid against independent Python references');
  }
}
