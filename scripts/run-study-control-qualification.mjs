#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import { hashCanonical, InMemorySignerRegistry } from '@ald/hashing';
import { createLearnerAdapterFactory } from '@ald/learners';
import { buildRunConfig, createDerivedRunConfig } from '@ald/lifecycle';
import { autoRestore, takeSnapshot } from '@ald/ops';
import {
  SAFETY_ESCALATION_REASON,
  createProductionRuntime,
} from '@ald/orchestrator';
import { HASH_DOMAINS } from '@ald/types';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    out: { type: 'string', required: true },
    root: { type: 'string', required: true },
  },
});

const outputPath = resolve(values.out);
const qualificationRoot = resolve(values.root);
const softwareCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const trackedTreeAtLaunch = execFileSync('git', ['status', '--porcelain'], {
  encoding: 'utf8',
}).trim().length === 0;
const signerRegistries = new Map();
const signerProvider = (runId) => {
  const existing = signerRegistries.get(runId);
  if (existing !== undefined) return existing;
  const created = InMemorySignerRegistry.generate(runId);
  signerRegistries.set(runId, created);
  return created;
};

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(qualificationRoot, { recursive: true });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function policyHash(adapter) {
  return hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy());
}

class AdapterWrapper {
  constructor(inner) {
    this.inner = inner;
    this.track = inner.track;
    this.isolation = inner.isolation;
    if (inner.updatePolicy !== undefined) {
      this.updatePolicy = (batch) => inner.updatePolicy.call(inner, batch);
    }
    if (inner.measureAffect !== undefined) {
      this.measureAffect = () => inner.measureAffect.call(inner);
    }
    if (inner.receiveAffect !== undefined) {
      this.receiveAffect = (delivery) => inner.receiveAffect.call(inner, delivery);
    }
    if (inner.applyCurriculumStage !== undefined) {
      this.applyCurriculumStage = (stage) =>
        inner.applyCurriculumStage.call(inner, stage);
    }
    if (inner.describeProvenance !== undefined) {
      this.describeProvenance = () => inner.describeProvenance.call(inner);
    }
    if (inner.initialPolicyHash !== undefined) {
      this.initialPolicyHash = () => inner.initialPolicyHash.call(inner);
    }
  }

  init(context) {
    return this.inner.init(context);
  }

  observe(observation) {
    return this.inner.observe(observation);
  }

  act(budget) {
    return this.inner.act(budget);
  }

  receive(delivery) {
    return this.inner.receive(delivery);
  }

  onOutcome(outcome) {
    return this.inner.onOutcome(outcome);
  }

  exportPolicy() {
    return this.inner.exportPolicy();
  }
}

class DeadlineAdapter extends AdapterWrapper {
  async act(budget) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, budget.responseBudgetMs + 100));
    return super.act(budget);
  }
}

class EvaluationFaultAdapter extends AdapterWrapper {
  actCalls = 0;

  async act(budget) {
    this.actCalls += 1;
    if (this.actCalls === 2 || this.actCalls === 3) {
      const error = new Error('qualification evaluation adapter fault');
      error.name = 'QualificationEvaluationFault';
      throw error;
    }
    return super.act(budget);
  }
}

function wrappedFactory(track, Wrapper) {
  const base = createLearnerAdapterFactory(track);
  return {
    track,
    create: () => new Wrapper(base.create()),
  };
}

function openRuntime(name, adapterFactoryFor) {
  const directory = join(qualificationRoot, name);
  const bundleRoot = join(directory, 'bundles');
  let production;
  const transport = new FakeChainTransport({
    network: 'base-sepolia',
    endpointLabel: 'local-v10-qualification-fake-chain',
  });
  const evidence = {
    listRuns: () => production.runtime.listRuns().map((run) => run.runId),
    insertAnchorReceipt: (receipt) =>
      production.runtime.writerFor(receipt.runId).insertAnchorReceipt(receipt),
    readCheckpoints: (runId) =>
      production.runtime.writerFor(runId).readCheckpoints(runId),
    readAnchorReceipts: (runId) =>
      production.runtime.writerFor(runId).readAnchorReceipts(runId),
  };
  const publisher = new BaseAnchorPublisher({
    transport,
    evidence,
    clock: { now: () => new Date().toISOString() },
    anchorAddress: `0x${'42'.repeat(20)}`,
    finalityPolicy: '1-confirmation',
    retry: {
      attempts: 2,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      sleep: async () => transport.mineBlock(),
    },
    confirmationPoll: { attempts: 2, intervalMs: 0 },
  });
  production = createProductionRuntime({
    databasePath: join(directory, 'evidence.sqlite'),
    bundleRoot,
    softwareCommit,
    signerProvider,
    allowUnanchored: false,
    anchorPublisher: publisher,
    anchorPolicy: 'required',
    ...(adapterFactoryFor === undefined ? {} : { adapterFactoryFor }),
  });
  return { ...production, bundleRoot, directory, transport };
}

async function verifiedRun(production, runId, expectedState) {
  const summary = production.runtime.getRun(runId);
  assert.equal(summary?.state, expectedState);
  const bundleDir = production.runtime.bundleDirFor(runId);
  const verification = await production.runtime.verify(runId, bundleDir);
  assert.equal(verification.exitCode, 0, `${runId} bundle verification failed`);
  return {
    runId,
    state: summary.state,
    turns: production.runtime.turnRecords(runId).length,
    checkpoints: production.runtime.checkpoints(runId).length,
    verifierExitCode: verification.exitCode,
    verificationReport: join(bundleDir, 'verification-report.json'),
  };
}

async function qualifyTrainedControlAndLineage() {
  const production = openRuntime('trained-control-lineage');
  try {
    const parent = buildRunConfig({
      runId: 'v10-trained-parent',
      experimentId: 'E16',
      randomSeed: 'v10-trained-parent-seed',
      deploymentMode: 'prototype',
      babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
      learningSignal: 'extrinsic-task',
      communicationCondition: 'normal',
      maxTurnsPerRun: 16,
      evaluationTurns: 4,
      checkpointEventInterval: 8,
      interventionPlan: {
        version: 1,
        evaluationSuite: {
          ablation: true,
          substitution: true,
          scramblingControl: true,
          probeShare: 1,
        },
      },
    });
    await production.runtime.createRun(parent);
    const adapters = production.runtime.adaptersFor(parent.runId);
    const initialHashes = {
      babyA: policyHash(adapters['baby-a']),
      babyB: policyHash(adapters['baby-b']),
    };
    let frozenHashes;
    await production.runtime.runToCompletion(parent.runId, {
      onTurn: (result) => {
        if (result.phase === 'running') {
          frozenHashes = {
            babyA: policyHash(adapters['baby-a']),
            babyB: policyHash(adapters['baby-b']),
          };
        }
      },
    });
    assert.ok(frozenHashes !== undefined);
    const finalHashes = {
      babyA: policyHash(adapters['baby-a']),
      babyB: policyHash(adapters['baby-b']),
    };
    assert.notDeepEqual(initialHashes, frozenHashes);
    assert.deepEqual(finalHashes, frozenHashes);
    const probeEvents = production.runtime
      .auditLog(parent.runId)
      .filter((event) => event.eventType === 'causal-probe');
    const appliedProbes = probeEvents.filter(
      (event) => event.reasonCode === 'live-probe-applied',
    );
    assert.ok(appliedProbes.length > 0);
    const parentEvidence = await verifiedRun(production, parent.runId, 'sealed');

    const parentCheckpoint = production.runtime.checkpoints(parent.runId).at(-1);
    assert.ok(parentCheckpoint !== undefined);
    const child = createDerivedRunConfig(
      parent,
      parentCheckpoint.checkpointHash,
      'v10-derived-disabled-control',
      {
        babyAInitialPolicyRef: 'policies/baby-a-latest.json',
        babyBInitialPolicyRef: 'policies/baby-b-latest.json',
        overrides: {
          randomSeed: 'v10-derived-disabled-control-seed',
          communicationCondition: 'disabled',
          maxTurnsPerRun: 1,
          evaluationTurns: 4,
          interventionPlan: { version: 1 },
        },
      },
    );
    await production.runtime.createRun(child);
    const childAdapters = production.runtime.adaptersFor(child.runId);
    const parentPolicyFiles = await Promise.all(
      ['baby-a', 'baby-b'].map((role) =>
        readFile(
          join(production.bundleRoot, 'runs', parent.runId, 'policies', `${role}-latest.json`),
          'utf8',
        ).then(JSON.parse),
      ),
    );
    const initialization = production.runtime
      .auditLog(child.runId)
      .find((event) => event.reasonCode === 'learner-initialization');
    const recordedInitialPolicies = initialization?.details.initialPolicies;
    assert.deepEqual(
      {
        babyA: recordedInitialPolicies['baby-a'].sourcePolicyHash,
        babyB: recordedInitialPolicies['baby-b'].sourcePolicyHash,
      },
      {
      babyA: hashCanonical(HASH_DOMAINS.policyCheckpoint, parentPolicyFiles[0]),
      babyB: hashCanonical(HASH_DOMAINS.policyCheckpoint, parentPolicyFiles[1]),
      },
    );
    let childFrozenHashes;
    await production.runtime.runToCompletion(child.runId, {
      onTurn: (result) => {
        if (result.phase === 'running') {
          childFrozenHashes = {
            babyA: policyHash(childAdapters['baby-a']),
            babyB: policyHash(childAdapters['baby-b']),
          };
        }
      },
    });
    assert.ok(childFrozenHashes !== undefined);
    assert.deepEqual(
      {
        babyA: policyHash(childAdapters['baby-a']),
        babyB: policyHash(childAdapters['baby-b']),
      },
      childFrozenHashes,
    );
    const childTurns = production.runtime.turnRecords(child.runId);
    assert.equal(childTurns.filter((turn) => turn.phase === 'evaluating').length, 4);
    assert.ok(
      childTurns
        .filter((turn) => turn.phase === 'evaluating')
        .every((turn) => turn.communicationCondition === 'disabled'),
    );
    const childEvidence = await verifiedRun(production, child.runId, 'sealed');
    const childReport = JSON.parse(
      await readFile(childEvidence.verificationReport, 'utf8'),
    );
    assert.deepEqual(
      childReport.gaps.filter((gap) => gap.startsWith('lineage-')),
      [],
    );
    return {
      parent: parentEvidence,
      child: childEvidence,
      policiesChangedDuringTraining: true,
      parentEvaluationPolicyHashesFrozen: true,
      childEvaluationPolicyHashesFrozen: true,
      childSourcePolicyHashesMatchParent: true,
      childEvaluationCommunicationDisabled: true,
      probeScheduleFrozen: production.runtime
        .auditLog(parent.runId)
        .some((event) => event.eventType === 'probe-schedule'),
      liveProbeApplications: appliedProbes.length,
      derivedLineageVerifierGaps: [],
    };
  } finally {
    production.close();
  }
}

async function qualifyNoLearning() {
  const production = openRuntime('no-learning');
  try {
    const config = buildRunConfig({
      runId: 'v10-no-learning',
      experimentId: 'E03',
      randomSeed: 'v10-no-learning-seed',
      deploymentMode: 'prototype',
      babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      learningSignal: 'none',
      communicationCondition: 'normal',
      maxTurnsPerRun: 2,
      evaluationTurns: 2,
    });
    await production.runtime.createRun(config);
    const adapters = production.runtime.adaptersFor(config.runId);
    assert.equal(adapters['baby-a'].updatePolicy, undefined);
    assert.equal(adapters['baby-b'].updatePolicy, undefined);
    const initial = {
      babyA: policyHash(adapters['baby-a']),
      babyB: policyHash(adapters['baby-b']),
    };
    await production.runtime.runToCompletion(config.runId);
    assert.deepEqual(
      {
        babyA: policyHash(adapters['baby-a']),
        babyB: policyHash(adapters['baby-b']),
      },
      initial,
    );
    const policyEvents = production.runtime
      .ledgers(config.runId)
      .babyA.concat(production.runtime.ledgers(config.runId).babyB)
      .filter((event) => event.eventType === 'policy.checkpointed');
    assert.equal(policyEvents.length, 0);
    return {
      ...(await verifiedRun(production, config.runId, 'sealed')),
      updatePolicyAbsentBothRoles: true,
      policyHashesConstant: true,
      policyCheckpointEvents: 0,
    };
  } finally {
    production.close();
  }
}

async function qualifyDeadline() {
  const production = openRuntime('deadline', (config, role) =>
    wrappedFactory(role === 'baby-a' ? config.babyA.track : config.babyB.track, DeadlineAdapter),
  );
  try {
    const config = buildRunConfig({
      runId: 'v10-deadline',
      experimentId: 'E03',
      randomSeed: 'v10-deadline-seed',
      deploymentMode: 'prototype',
      babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      learningSignal: 'none',
      maxTurnsPerRun: 1,
      evaluationTurns: 1,
      turnResponseBudgetMs: 1_000,
    });
    await production.runtime.createRun(config);
    await production.runtime.runToCompletion(config.runId);
    const records = production.runtime.turnRecords(config.runId);
    assert.equal(records.length, 2);
    assert.ok(
      records.every(
        (turn) =>
          turn.outcome.details?.reason === 'forfeit' &&
          turn.outcome.details?.reasonCode === 'timeout',
      ),
    );
    const channel = production.runtime.transcript(config.runId);
    assert.equal(channel.length, 2);
    assert.ok(
      channel.every((event) => event.gatewayValidationResult === 'rejected'),
    );
    assert.ok(channel.every((event) => event.reasonCode === 'timeout'));
    return {
      ...(await verifiedRun(production, config.runId, 'sealed')),
      responseBudgetMs: 1_000,
      timedOutTurns: records.length,
      timeoutRejections: channel.length,
      noUnrecordedTurn: true,
    };
  } finally {
    production.close();
  }
}

async function qualifyManualAbort() {
  const production = openRuntime('manual-abort');
  try {
    const config = buildRunConfig({
      runId: 'v10-manual-abort',
      experimentId: 'E03',
      randomSeed: 'v10-manual-abort-seed',
      deploymentMode: 'prototype',
      babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      learningSignal: 'none',
      maxTurnsPerRun: 10,
      evaluationTurns: 2,
    });
    await production.runtime.createRun(config);
    await production.runtime.step(config.runId);
    await production.runtime.abort(config.runId, {
      actorId: 'operator:qualification',
      reasonCode: 'qualification-manual-abort',
    });
    const aborts = production.runtime
      .auditLog(config.runId)
      .filter((event) => event.eventType === 'abort');
    assert.equal(aborts.length, 1);
    return {
      ...(await verifiedRun(production, config.runId, 'aborted-sealed')),
      abortEventRecorded: true,
      experimentDisposition: production.runtime.experimentRecords(config.runId).at(-1)
        ?.disposition,
    };
  } finally {
    production.close();
  }
}

async function qualifyEvaluationSafetyStop() {
  const production = openRuntime('evaluation-safety-stop', (config, role) => {
    const track = role === 'baby-a' ? config.babyA.track : config.babyB.track;
    return role === 'baby-a'
      ? wrappedFactory(track, EvaluationFaultAdapter)
      : createLearnerAdapterFactory(track);
  });
  try {
    const config = buildRunConfig({
      runId: 'v10-evaluation-safety-stop',
      experimentId: 'E03',
      randomSeed: 'v10-evaluation-safety-stop-seed',
      deploymentMode: 'prototype',
      babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
      learningSignal: 'none',
      maxTurnsPerRun: 1,
      evaluationTurns: 4,
    });
    await production.runtime.createRun(config);
    await production.runtime.runToCompletion(config.runId);
    const audit = production.runtime.auditLog(config.runId);
    const adapterFailures = audit.filter(
      (event) => event.eventType === 'safety-trigger' && event.reasonCode === 'adapter-failure',
    );
    const escalations = audit.filter(
      (event) => event.eventType === 'abort' && event.reasonCode === SAFETY_ESCALATION_REASON,
    );
    assert.equal(adapterFailures.length, 1);
    assert.equal(adapterFailures[0].details.phase, 'evaluating');
    assert.equal(adapterFailures[0].details.attempts, 2);
    assert.equal(escalations.length, 1);
    assert.equal(production.runtime.turnRecords(config.runId).length, 2);
    return {
      ...(await verifiedRun(production, config.runId, 'aborted-sealed')),
      evaluationAdapterFailureTriggers: adapterFailures.length,
      retryAttempts: adapterFailures[0].details.attempts,
      safetyEscalationAbortEvents: escalations.length,
      evaluationStoppedAfterFailedTurn: true,
    };
  } finally {
    production.close();
  }
}

async function qualifySnapshotRestore() {
  let production = openRuntime('snapshot-restore');
  const config = buildRunConfig({
    runId: 'v10-snapshot-restore',
    experimentId: 'E11',
    randomSeed: 'v10-snapshot-restore-seed',
    deploymentMode: 'prototype',
    babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
    babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
    learningSignal: 'extrinsic-task',
    maxTurnsPerRun: 8,
    evaluationTurns: 2,
    checkpointEventInterval: 4,
  });
  try {
    await production.runtime.createRun(config);
    for (let turn = 0; turn < 4; turn += 1) {
      await production.runtime.step(config.runId);
    }
    const snapshotDirectory = join(production.directory, 'snapshots');
    const taken = await takeSnapshot(production.runtime, snapshotDirectory, {
      clock: { now: () => new Date().toISOString() },
      softwareCommit,
    });
    const snapshotPolicyHashes = clone(taken.snapshot.runs[0].policyHashes);
    production.close();
    production = openRuntime('snapshot-restore');
    const restored = await autoRestore(() => production.runtime, {
      directory: snapshotDirectory,
      bundleRoot: production.bundleRoot,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.runs.length, 1);
    assert.equal(restored.runs[0].turnMatches, true);
    assert.equal(restored.runs[0].prefix.ok, true);
    assert.deepEqual(restored.runs[0].policyMatches, {
      'baby-a': true,
      'baby-b': true,
    });
    await production.runtime.runToCompletion(config.runId);
    return {
      ...(await verifiedRun(production, config.runId, 'sealed')),
      snapshotPath: taken.path,
      snapshotDigest: taken.snapshot.digest,
      snapshotTurn: taken.snapshot.runs[0].turn,
      snapshotPolicyHashes,
      restoreOk: restored.ok,
      turnCursorMatched: restored.runs[0].turnMatches,
      policyHashesMatchedBothRoles: Object.values(restored.runs[0].policyMatches).every(Boolean),
      committedPrefixVerified: restored.runs[0].prefix.ok,
      recoveryEventRecorded: production.runtime
        .auditLog(config.runId)
        .some((event) => event.eventType === 'recovery'),
    };
  } finally {
    try {
      production.close();
    } catch {
      // The pre-restore handle was already closed deliberately.
    }
  }
}

const startedAt = new Date().toISOString();
const results = {
  trainedControlAndLineage: await qualifyTrainedControlAndLineage(),
  noLearning: await qualifyNoLearning(),
  deadline: await qualifyDeadline(),
  manualAbort: await qualifyManualAbort(),
  evaluationSafetyStop: await qualifyEvaluationSafetyStop(),
  snapshotRestore: await qualifySnapshotRestore(),
};
const report = {
  schemaVersion: 1,
  classification: 'non-confirmatory-study-control-software-qualification',
  researchFinding: false,
  publicChainTransaction: false,
  anchorTransport: 'local-v10-qualification-fake-chain',
  candidate: {
    commit: softwareCommit,
    trackedTreeAtLaunch,
  },
  startedAt,
  completedAt: new Date().toISOString(),
  results,
  allAcceptanceChecksPassed: true,
  limitations: [
    'This is deterministic software qualification, not registered experimental evidence.',
    'Local fake-chain confirmations do not establish public-chain publication.',
    'In-process learner adapters exercise controller semantics but do not replace Mode R container evidence.',
    'The deadline fixture intentionally exceeds a one-second budget; it does not benchmark model latency.',
    'The derived disabled-channel run qualifies lineage, control delivery, and evaluation freeze, not a behavioral effect.',
  ],
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report)}\n`);
