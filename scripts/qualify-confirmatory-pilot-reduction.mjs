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
  reduceConfirmatoryPilot,
} from '@ald/analysis';

import { venvPython } from './resolve-venv-python.mjs';

const receiptPath = 'reports/research/confirmatory-pilot-reduction-qualification-receipt.json';
const sourcePaths = [
  'packages/analysis/src/confirmatory-pilot-reduction.ts',
  'packages/analysis/src/confirmatory-pilot.ts',
  'packages/analysis/src/descriptive.ts',
  'packages/analysis/__tests__/confirmatory-pilot-reduction.test.ts',
  'protocols/confirmatory-pilot-reduction.v1.json',
  'scripts/qualify-confirmatory-pilot-reduction.mjs',
];
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function sourceArtifact(path, root = process.cwd()) {
  const resolved = resolve(root, path);
  const stat = lstatSync(resolved);
  assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symbolic link`);
  const bytes = readFileSync(resolved);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

function softwareFixture() {
  return Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS)
    .map(([id, memberIds], experimentIndex) => ({
      id,
      registrationSha256: `sha256:${(experimentIndex + 1).toString(16).padStart(64, '0')}`,
      slots: Array.from({ length: 20 }, (_, index) => ({
        slot: index + 1,
        runId: `qualification-${id.toLowerCase()}-${String(index + 1).padStart(2, '0')}`,
        seed: `qualification-only-${id}-${index + 1}`,
        evidenceSha256: `sha256:${(1000 + experimentIndex * 20 + index).toString(16).padStart(64, '0')}`,
        components: Object.fromEntries(memberIds.map((memberId, memberIndex) => [
          memberId,
          Object.fromEntries(CONFIRMATORY_PILOT_COMPONENTS[memberId]
            .map((componentId, componentIndex) => [
              componentId,
              memberId === 'H5'
                ? Number((index + componentIndex + experimentIndex) % 3 === 0)
                : (10 * experimentIndex + 3 * memberIndex + 2 * componentIndex +
                  (index * 7) % 17 + index / 10) / 1000,
            ])),
        ])),
      })),
    }));
}

function referenceRows(inputs) {
  const rows = ['member\tcomponent\tvalue'];
  for (const input of inputs) {
    for (const memberId of CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS[input.id]) {
      for (const componentId of CONFIRMATORY_PILOT_COMPONENTS[memberId]) {
        for (const slot of input.slots) {
          rows.push(`${memberId}\t${componentId}\t${slot.components[memberId][componentId]}`);
        }
      }
    }
  }
  const program = String.raw`
import math
import statistics
import sys
from scipy import stats
lines = sys.stdin.read().splitlines()
assert lines[0] == 'member\tcomponent\tvalue', 'expected header row'
groups = {}
order = []
for line in lines[1:]:
    member, component, raw = line.split('\t')
    key = (member, component)
    if key not in groups:
        groups[key] = []
        order.append(key)
    groups[key].append(float(raw))
print(f"Python {sys.version.split()[0]} + numpy/scipy (repo .venv, pinned)")
factor = math.sqrt(19.0 / stats.chi2.ppf(0.05, 19))
z = stats.norm.ppf(0.95)
invalid_upper = z * z / (20.0 + z * z)
print("%.17g\t%.17g" % (factor, invalid_upper))
for member, component in order:
    values = groups[(member, component)]
    sd = statistics.stdev(values)
    print("%s\t%s\t%d\t%.17g\t%.17g\t%.17g"
          % (member, component, len(values), statistics.mean(values), sd, sd * factor))
`;
  const lines = execFileSync(venvPython(), ['-c', program],
    { encoding: 'utf8', input: `${rows.join('\n')}\n` }).trim().split('\n');
  const implementation = lines.shift();
  assert.match(implementation, /^Python /u);
  const [factor, invalidUpper] = lines.shift().split('\t').map(Number);
  const references = lines.map((line) => {
    const [memberId, componentId, n, mean, sampleSd, upper95Sd] = line.split('\t');
    const numeric = [n, mean, sampleSd, upper95Sd].map(Number);
    assert.ok(numeric.every(Number.isFinite));
    return { memberId, componentId, n: numeric[0], mean: numeric[1],
      sampleSd: numeric[2], upper95Sd: numeric[3] };
  });
  return { implementation, factor, invalidUpper, references };
}

export function runConfirmatoryPilotReductionQualification() {
  const inputs = softwareFixture();
  const reduction = reduceConfirmatoryPilot(inputs);
  const reference = referenceRows(inputs);
  assert.equal(reference.references.length, 14);
  assert.equal(reduction.summary.members.flatMap((member) => member.components).length, 14);
  let maximumAbsoluteDifference = 0;
  for (const expected of reference.references) {
    const member = reduction.summary.members.find((row) => row.id === expected.memberId);
    const actual = member?.components.find((row) => row.id === expected.componentId);
    assert.ok(actual, `${expected.memberId}.${expected.componentId} missing`);
    assert.equal(actual.n, expected.n);
    for (const key of ['mean', 'sampleSd', 'upper95Sd']) {
      assert.ok(Number.isFinite(actual[key]));
      const difference = Math.abs(actual[key] - expected[key]);
      assert.ok(difference <= 1e-12,
        `${expected.memberId}.${expected.componentId}.${key} differs from Python`);
      maximumAbsoluteDifference = Math.max(maximumAbsoluteDifference, difference);
    }
  }
  for (const experiment of reduction.summary.experiments) {
    assert.ok(Math.abs(experiment.invalidProbabilityUpper95 - reference.invalidUpper) <= 1e-12,
      `${experiment.id} invalid-run upper bound differs from Python`);
  }
  assert.equal(reduction.originalEvidenceVerified, false);
  assert.equal(reduction.registrationAncestryVerified, false);
  assert.equal(reduction.selectionAdmitted, false);
  assert.equal(reduction.researchFinding, false);

  const incomplete = structuredClone(inputs);
  incomplete[0].slots.pop();
  assert.throws(() => reduceConfirmatoryPilot(incomplete), /twenty valid/u);
  const reused = structuredClone(inputs);
  reused[1].slots[0].seed = reused[0].slots[0].seed;
  assert.throws(() => reduceConfirmatoryPilot(reused), /slot identities/u);
  const missing = structuredClone(inputs);
  delete missing[0].slots[0].components.H1.disabled;
  assert.throws(() => reduceConfirmatoryPilot(missing), /exact ordered registered keys/u);
  const nonbinary = structuredClone(inputs);
  nonbinary[1].slots[0].components.H5['stable-acquisition'] = 0.5;
  assert.throws(() => reduceConfirmatoryPilot(nonbinary), /is invalid/u);

  return {
    fixture: 'deterministic-synthetic-complete-pilot-v1',
    experiments: 7,
    slotsPerExperiment: 20,
    components: 14,
    componentObservations: 280,
    rejectedMutationCases: 4,
    independentReference: {
      implementation: reference.implementation,
      comparisons: 42,
      maximumAbsoluteDifference,
      tolerance: 1e-12,
      upperSdFactor: reference.factor,
      invalidProbabilityUpper95: reference.invalidUpper,
      rows: reference.references,
    },
    sourceInputSha256: reduction.sourceInputSha256,
    outputSha256: sha256(JSON.stringify(reduction)),
    selectionAdmitted: false,
    researchFinding: false,
  };
}

export function validateConfirmatoryPilotReductionQualification(receipt, root = process.cwd()) {
  const gitAtRoot = (...args) => execFileSync('git', ['-C', root, ...args],
    { encoding: 'utf8' }).trim();
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, 'synthetic-confirmatory-pilot-reduction-software-qualification');
  assert.equal(receipt.passed, true);
  assert.equal(receipt.syntheticFixturesOnly, true);
  assert.equal(receipt.originalEvidenceVerified, false);
  assert.equal(receipt.registrationAncestryVerified, false);
  assert.equal(receipt.selectionAdmitted, false);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.externalSpend, 0);
  assert.match(receipt.execution.commit, /^[0-9a-f]{40}$/u);
  assert.equal(gitAtRoot('rev-parse', `${receipt.execution.commit}^{tree}`), receipt.execution.tree);
  assert.equal(JSON.parse(gitAtRoot('show', `${receipt.execution.commit}:package.json`)).version,
    receipt.execution.version);
  assert.deepEqual(receipt.sourceArtifacts.map((artifact) => artifact.path), sourcePaths);
  for (const artifact of receipt.sourceArtifacts) {
    const bytes = execFileSync('git', ['-C', root, 'show',
      `${receipt.execution.commit}:${artifact.path}`]);
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(sha256(bytes), artifact.sha256);
    if (artifact.path !== 'scripts/qualify-confirmatory-pilot-reduction.mjs') {
      assert.deepEqual(sourceArtifact(artifact.path, root), artifact);
    }
  }
  assert.deepEqual(receipt.qualification, runConfirmatoryPilotReductionQualification());
  assert.match(receipt.claimBoundary, /not an admitted pilot/u);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    write: { type: 'boolean', default: false },
    preview: { type: 'boolean', default: false },
  } });
  if (values.preview) {
    const result = runConfirmatoryPilotReductionQualification();
    console.log(`Pilot reducer preview: ${result.independentReference.comparisons} Python comparisons, ${result.rejectedMutationCases} negative controls; no pilot admitted`);
  } else if (values.write) {
    assert.equal(existsSync(receiptPath), false, 'refusing to overwrite qualification receipt');
    assert.equal(git('status', '--porcelain'), '', 'commit exact qualification sources before receipt creation');
    const receipt = {
      schemaVersion: 1,
      classification: 'synthetic-confirmatory-pilot-reduction-software-qualification',
      capturedAt: '2026-10-04',
      passed: true,
      syntheticFixturesOnly: true,
      originalEvidenceVerified: false,
      registrationAncestryVerified: false,
      selectionAdmitted: false,
      researchFinding: false,
      externalSpend: 0,
      execution: {
        commit: git('rev-parse', 'HEAD'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        version: JSON.parse(readFileSync('package.json', 'utf8')).version,
      },
      sourceArtifacts: sourcePaths.map((path) => sourceArtifact(path)),
      qualification: runConfirmatoryPilotReductionQualification(),
      claimBoundary: 'Synthetic numerical software qualification only; not an admitted pilot, campaign power result, selected N, resource authorization, independent review, or research finding.',
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    console.log(`Wrote ${receiptPath}`);
  } else {
    validateConfirmatoryPilotReductionQualification(JSON.parse(readFileSync(receiptPath, 'utf8')));
    console.log('Confirmatory pilot-reduction software qualification valid against independent Python');
  }
}
