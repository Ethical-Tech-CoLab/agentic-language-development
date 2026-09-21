#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createBabyProcessAdapterFactory } from '@ald/isolation';
import { runLearnerAdapterConformance } from '@ald/learners';

const protocolPath = 'protocols/mode-r-baby-model-boundary-qualification.v1.json';
const evidenceRoot = 'evidence/mode-r-baby-model-process-development-v1';
const receiptPath = `${evidenceRoot}/receipt.json`;
const sourcePaths = [
  protocolPath,
  'packages/isolation/src/baby-factory.ts',
  'packages/isolation/src/baby-host.ts',
  'packages/isolation/src/factory.ts',
  'packages/isolation/src/host.ts',
  'packages/isolation/src/remote-adapter.ts',
  'packages/isolation/src/protocol.ts',
  'packages/isolation/src/process-transport.ts',
  'packages/isolation/bin/ald-baby-host.js',
  'packages/isolation/bin/ald-learner-host.js',
  'packages/isolation/__tests__/isolation.test.ts',
  'packages/isolation/__tests__/mode-r-authority-graph.test.ts',
  'packages/learners/src/conformance.ts',
  'scripts/run-mode-r-baby-model-qualification.mjs',
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const artifact = (path) => {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
};

function validateAuthorityBindings(protocol) {
  assert.equal(protocol.schemaVersion, 1);
  assert.equal(protocol.status, 'design-locked-not-executed');
  assert.equal(protocol.researchFinding, false);
  assert.equal(protocol.b12Closed, false);
  for (const binding of protocol.authorityBindings) {
    assert.equal(sha256(readFileSync(binding.path)), `sha256:${binding.sha256}`);
  }
}

function childProcessIds(parentId) {
  const path = `/proc/${String(parentId)}/task/${String(parentId)}/children`;
  return readFileSync(path, 'utf8').trim().split(/\s+/u).filter(Boolean).map(Number);
}

function residentKiB(processId) {
  const status = readFileSync(`/proc/${String(processId)}/status`, 'utf8');
  const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
  assert.ok(match, `missing VmRSS for process ${String(processId)}`);
  return Number(match[1]);
}

async function waitForExit(processIds) {
  const deadline = Date.now() + 2_000;
  let live = [];
  do {
    live = processIds.filter((processId) => existsSync(`/proc/${String(processId)}`));
    if (live.length === 0) return [];
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  } while (Date.now() < deadline);
  return live;
}

function validateReceipt(receipt, root = process.cwd()) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, 'mode-r-baby-model-process-development-qualification');
  assert.equal(receipt.passed, true);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registeredStudyExecution, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.b12Closed, false);
  assert.equal(receipt.externalSpendUsd, 0);
  assert.equal(receipt.execution.platform, 'linux');
  assert.equal(receipt.execution.cleanBefore, true);
  assert.equal(receipt.execution.cleanAfterRuntime, true);
  assert.match(receipt.execution.commit, /^[0-9a-f]{40}$/u);
  assert.match(receipt.execution.tree, /^[0-9a-f]{40}$/u);
  assert.equal(
    execFileSync('git', ['-C', root, 'rev-parse', `${receipt.execution.commit}^{tree}`], {
      encoding: 'utf8',
    }).trim(),
    receipt.execution.tree,
  );
  assert.equal(
    JSON.parse(execFileSync('git', ['-C', root, 'show',
      `${receipt.execution.commit}:package.json`], { encoding: 'utf8' })).version,
    receipt.execution.version,
  );
  assert.deepEqual(receipt.sourceArtifacts.map(({ path }) => path), sourcePaths);
  for (const expected of receipt.sourceArtifacts) {
    const bytes = execFileSync('git', ['-C', root, 'show',
      `${receipt.execution.commit}:${expected.path}`]);
    assert.equal(bytes.length, expected.bytes, `${expected.path} byte count`);
    assert.equal(sha256(bytes), expected.sha256, `${expected.path} sha256`);
  }
  assert.equal(receipt.observations.babyProcessIds.length, 2);
  assert.equal(receipt.observations.modelAdapterProcessIds.length, 2);
  assert.equal(new Set([
    receipt.execution.collectorProcessId,
    ...receipt.observations.babyProcessIds,
    ...receipt.observations.modelAdapterProcessIds,
  ]).size, 5);
  assert.deepEqual(receipt.observations.modelChildrenPerBaby, [1, 1]);
  assert.equal(receipt.observations.conformance.episodes, 1);
  assert.equal(receipt.observations.conformance.proposals, 2);
  assert.ok(receipt.observations.conformance.ledgerDrafts['baby-a'] > 0);
  assert.ok(receipt.observations.conformance.ledgerDrafts['baby-b'] > 0);
  assert.deepEqual(receipt.observations.outerTiming, [
    { timingNormalization: 'normalized', turnDeadlineAuthority: 'adapter' },
    { timingNormalization: 'normalized', turnDeadlineAuthority: 'adapter' },
  ]);
  assert.deepEqual(receipt.observations.liveAfterDispose, []);
  assert.ok(receipt.observations.resourceSnapshot.totalResidentKiB > 0);
  assert.match(receipt.claimBoundary, /does not qualify the selected container topology/u);
  return receipt;
}

async function execute() {
  assert.equal(process.platform, 'linux', 'this process-tree qualification requires Linux /proc');
  assert.equal(git('status', '--porcelain'), '', 'commit exact sources before qualification');
  assert.equal(existsSync(evidenceRoot), false, 'refusing to overwrite qualification evidence');
  const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
  validateAuthorityBindings(protocol);
  mkdirSync(evidenceRoot, { recursive: true });

  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const factory = createBabyProcessAdapterFactory({
    track: 'no-learning',
    timing: 'normalized',
    deadlineMs: 1_000,
    process: { stderr: 'count', hostLabel: 'baby-development-qualification' },
    modelHostLabel: 'model-adapter-development-qualification',
  });
  let result;
  let babyProcessIds = [];
  let modelAdapterProcessIds = [];
  let modelChildrenPerBaby = [];
  let outerTiming = [];
  let resourceSnapshot;
  let failure;
  try {
    result = await runLearnerAdapterConformance(factory, {
      episodes: 1,
      seed: 'mode-r-baby-model-process-development-v1',
    });
    babyProcessIds = factory.adapters.map((adapter) => adapter.isolation.processId);
    assert.ok(babyProcessIds.every(Number.isInteger));
    const children = babyProcessIds.map(childProcessIds);
    modelChildrenPerBaby = children.map((ids) => ids.length);
    assert.deepEqual(modelChildrenPerBaby, [1, 1]);
    modelAdapterProcessIds = children.flat();
    outerTiming = factory.adapters.map((adapter) => ({
      timingNormalization: adapter.isolation.timingNormalization,
      turnDeadlineAuthority: adapter.isolation.turnDeadlineAuthority,
    }));
    const allIds = [process.pid, ...babyProcessIds, ...modelAdapterProcessIds];
    const residentByProcess = Object.fromEntries(
      allIds.map((processId) => [String(processId), residentKiB(processId)]),
    );
    resourceSnapshot = {
      unit: 'KiB',
      measuredAt: new Date().toISOString(),
      residentByProcess,
      totalResidentKiB: Object.values(residentByProcess)
        .reduce((sum, value) => sum + value, 0),
      qualification: 'single-live-snapshot-not-peak-or-selected-resource-envelope',
    };
  } catch (error) {
    failure = error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'unknown', message: String(error) };
  } finally {
    await factory.dispose();
  }

  const observedIds = [...babyProcessIds, ...modelAdapterProcessIds];
  const liveAfterDispose = await waitForExit(observedIds);
  const cleanAfterRuntime = git('status', '--porcelain') === '';
  const endedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    classification: 'mode-r-baby-model-process-development-qualification',
    capturedAt: endedAt,
    passed: failure === undefined && liveAfterDispose.length === 0 && cleanAfterRuntime,
    researchFinding: false,
    registeredStudyExecution: false,
    scientificDisposition: 'not-tested',
    b12Closed: false,
    externalSpendUsd: 0,
    execution: {
      commit: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      version: packageJson.version,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      collectorProcessId: process.pid,
      startedAt,
      endedAt,
      wallMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      cleanBefore: true,
      cleanAfterRuntime,
    },
    protocol: artifact(protocolPath),
    sourceArtifacts: sourcePaths.map(artifact),
    observations: {
      babyProcessIds,
      modelAdapterProcessIds,
      modelChildrenPerBaby,
      outerTiming,
      conformance: result === undefined ? null : {
        episodes: result.episodes,
        proposals: result.proposals,
        successes: result.successes,
        ledgerDrafts: {
          'baby-a': result.ledgers['baby-a'].drafts.length,
          'baby-b': result.ledgers['baby-b'].drafts.length,
        },
        policyHashes: {
          'baby-a': result.policyHashes['baby-a'].length,
          'baby-b': result.policyHashes['baby-b'].length,
        },
      },
      resourceSnapshot: resourceSnapshot ?? null,
      liveAfterDispose,
    },
    failure: failure ?? null,
    claimBoundary: 'This development receipt qualifies a synthetic no-learning LearnerAdapter path across distinct Baby and model-adapter processes with one outer normalized deadline and process-tree teardown. It does not qualify the selected container topology, Gateway/Evidence Writer integration, route or signer isolation, the selected resource envelope, B12 closure, a behavioral study, a scientific finding, independent review, or publication readiness.',
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  if (!receipt.passed) {
    throw new Error(`qualification failed; preserved ${receiptPath}: ${failure?.message ?? 'teardown failure'}`);
  }
  validateReceipt(receipt);
  console.log(`Mode R Baby/model process development qualification passed; wrote ${receiptPath}`);
}

const { values } = parseArgs({
  options: {
    run: { type: 'boolean', default: false },
    audit: { type: 'boolean', default: false },
  },
});
assert.notEqual(values.run, values.audit, 'choose exactly one of --run or --audit');
if (values.run) {
  await execute();
} else {
  assert.equal(existsSync(receiptPath), true, `missing ${receiptPath}`);
  validateReceipt(JSON.parse(readFileSync(resolve(receiptPath), 'utf8')));
  console.log('Mode R Baby/model process development qualification valid (live evidence)');
}
