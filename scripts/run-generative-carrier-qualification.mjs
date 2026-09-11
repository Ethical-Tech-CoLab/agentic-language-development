#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { carrierCapacity } from '@ald/analysis';
import {
  generateGlyphBundle,
  hashGlyphBundle,
  registerAlternateCarriers,
} from '@ald/gateway';
import { hashCanonical } from '@ald/hashing';
import {
  RECURRENT_ARCHITECTURE,
  ExportedRecurrentScratchPolicySchema,
} from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import { createProductionRuntime } from '@ald/orchestrator';
import { HASH_DOMAINS } from '@ald/types';

const { values } = parseArgs({
  options: {
    out: { type: 'string', required: true },
    db: { type: 'string', required: true },
    bundles: { type: 'string', required: true },
    training: { type: 'string', default: '40' },
    evaluation: { type: 'string', default: '12' },
  },
});

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recurrentPolicy(adapter) {
  const policy = ExportedRecurrentScratchPolicySchema.parse(
    adapter.exportPolicy(),
  );
  if (policy.version !== 2) {
    throw new Error('qualification requires carrier-state policy version 2');
  }
  return policy;
}

function originCounts(policy) {
  const counts = { initialized: 0, acquired: 0, modified: 0 };
  for (const slot of policy.carrierState.slots) counts[slot.origin] += 1;
  return counts;
}

function eventOriginCounts(runtime, runId, role) {
  const stream = role === 'baby-a' ? 'baby-a-ledger' : 'baby-b-ledger';
  const counts = { initialized: 0, acquired: 0, modified: 0, unspecified: 0 };
  for (const event of runtime.writerFor(runId).readEvents(runId, stream)) {
    const parsed = JSON.parse(event.canonicalJson);
    if (parsed.eventType !== 'term.first_emitted') continue;
    const origin = parsed.content?.formOrigin;
    if (origin === 'initialized' || origin === 'acquired' || origin === 'modified') {
      counts[origin] += 1;
    } else {
      counts.unspecified += 1;
    }
  }
  return counts;
}

const trainingTurns = positiveInteger(values.training, '--training');
const evaluationTurns = positiveInteger(values.evaluation, '--evaluation');
const outputPath = resolve(values.out);
const databasePath = resolve(values.db);
const bundleRoot = resolve(values.bundles);
const softwareCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const formCount = 8;
const carriers = [
  'fixed-token',
  'fixed-glyph',
  'generative-bitmap',
  'generative-canvas',
  'generative-tone',
];
const generative = new Set([
  'generative-bitmap',
  'generative-canvas',
  'generative-tone',
]);

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(databasePath), { recursive: true });
await mkdir(bundleRoot, { recursive: true });
registerAlternateCarriers();

const glyphBundleHash = hashGlyphBundle(
  generateGlyphBundle({ seed: 'e13-qualification-glyphs', size: formCount }),
);
const production = createProductionRuntime({
  databasePath,
  bundleRoot,
  softwareCommit,
  learnerOptions: {
    shared: {
      messageLength: 1,
      inventedFormCount: formCount,
      acquirePartnerForms: true,
      modifyAcquiredForms: true,
      recurrent: { hiddenSize: 16, ppoEpochs: 4 },
    },
  },
});

const runs = [];
try {
  for (const carrier of carriers) {
    const runId = `qualification-e13-${carrier}`;
    const config = buildRunConfig({
      runId,
      experimentId: 'E13',
      randomSeed: `qualification-e13-${carrier}-seed`,
      deploymentMode: 'prototype',
      babyA: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
      babyB: { track: 'scratch-rl', modelRef: RECURRENT_ARCHITECTURE },
      learningSignal: 'extrinsic-task',
      communicationCondition: 'normal',
      carrierMode: carrier,
      ...(carrier === 'fixed-token' || carrier === 'fixed-glyph'
        ? { symbolInventorySize: formCount, maxSymbolsPerMessage: 1 }
        : {}),
      ...(carrier === 'fixed-glyph' ? { glyphBundleHash } : {}),
      ...(carrier === 'generative-canvas' ? { maxStrokes: 8 } : {}),
      maxTurnsPerRun: trainingTurns,
      evaluationTurns,
      checkpointEventInterval: 10,
    });
    await production.runtime.createRun(config);
    const adapters = production.runtime.adaptersFor(runId);
    const initial = {
      'baby-a': clone(recurrentPolicy(adapters['baby-a'])),
      'baby-b': clone(recurrentPolicy(adapters['baby-b'])),
    };
    let afterTraining;
    const summary = await production.runtime.runToCompletion(runId, {
      onTurn: (result) => {
        if (result.phase === 'running') {
          afterTraining = {
            'baby-a': clone(recurrentPolicy(adapters['baby-a'])),
            'baby-b': clone(recurrentPolicy(adapters['baby-b'])),
          };
        }
      },
    });
    if (afterTraining === undefined) {
      throw new Error(`${carrier} produced no training checkpoint`);
    }
    const final = {
      'baby-a': recurrentPolicy(adapters['baby-a']),
      'baby-b': recurrentPolicy(adapters['baby-b']),
    };
    const policyHashesFrozen = ['baby-a', 'baby-b'].every(
      (role) =>
        hashCanonical(HASH_DOMAINS.policyCheckpoint, afterTraining[role]) ===
        hashCanonical(HASH_DOMAINS.policyCheckpoint, final[role]),
    );
    if (!policyHashesFrozen) {
      throw new Error(`${carrier} policy changed during evaluation`);
    }

    const initialIntersection = new Set(
      initial['baby-a'].carrierState.slots.map((slot) => slot.markHash),
    ).intersection(
      new Set(
        initial['baby-b'].carrierState.slots.map((slot) => slot.markHash),
      ),
    ).size;
    const origins = {
      'baby-a': originCounts(final['baby-a']),
      'baby-b': originCounts(final['baby-b']),
    };
    if (
      generative.has(carrier) &&
      (initialIntersection !== 0 ||
        Object.values(origins).some(
          (counts) => counts.acquired === 0 || counts.modified === 0,
        ))
    ) {
      throw new Error(`${carrier} did not demonstrate disjoint acquisition and modification`);
    }

    const bundleDir = production.runtime.bundleDirFor(runId);
    const verification = await production.runtime.verify(runId, bundleDir);
    if (verification.exitCode !== 0) {
      throw new Error(`${carrier} bundle failed independent verification`);
    }
    const turns = production.runtime.turnRecords(runId);
    if (
      turns.length !== trainingTurns + evaluationTurns ||
      turns.some((turn) => turn.channelEventHash === null)
    ) {
      throw new Error(`${carrier} did not complete every turn through the Gateway`);
    }
    const channelHashes = turns.map((turn) => turn.deliveredArtifactHash);
    const reuseCount = channelHashes.length - new Set(channelHashes).size;
    runs.push({
      runId,
      carrier,
      state: summary.state,
      trainingTurns,
      evaluationTurns,
      gatewayAcceptedTurns: turns.length,
      checkpoints: production.runtime.checkpoints(runId).length,
      verifierExitCode: verification.exitCode,
      initialInventoryIntersection: initialIntersection,
      finalOrigins: origins,
      emittedOrigins: {
        'baby-a': eventOriginCounts(production.runtime, runId, 'baby-a'),
        'baby-b': eventOriginCounts(production.runtime, runId, 'baby-b'),
      },
      repeatedDeliveredArtifacts: reuseCount,
      evaluationPolicyFrozen: policyHashesFrozen,
      capacity: carrierCapacity({
        carrier,
        formCount,
        marksPerMessage: 1,
        ...(carrier === 'generative-canvas' ? { maxStrokes: 8 } : {}),
      }),
      bundleDir,
    });
  }
} finally {
  production.close();
}

const report = {
  qualification: 'generative-carrier-learning-v1',
  classification: 'software-qualification-not-experiment-results',
  softwareCommit,
  executedAt: new Date().toISOString(),
  nodeVersion: process.version,
  formCount,
  trainingTurns,
  evaluationTurns,
  runs,
  checks: {
    allFiveCarriersExecuted: runs.length === carriers.length,
    allBundlesVerified: runs.every((run) => run.verifierExitCode === 0),
    allEvaluationPoliciesFrozen: runs.every(
      (run) => run.evaluationPolicyFrozen,
    ),
    generativeInventoriesInitiallyDisjoint: runs
      .filter((run) => generative.has(run.carrier))
      .every((run) => run.initialInventoryIntersection === 0),
    generativeAcquisitionAndModificationPresent: runs
      .filter((run) => generative.has(run.carrier))
      .every((run) =>
        Object.values(run.finalOrigins).every(
          (counts) => counts.acquired > 0 && counts.modified > 0,
        ),
      ),
  },
  claimBoundary:
    'This deterministic qualification demonstrates executable carrier learning, Gateway acceptance, checkpointing, evaluation freeze, and bundle verification. It is not E13 data and establishes no scientific effect.',
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
for (const run of runs) {
  console.log(
    `${run.carrier}: turns=${String(run.gatewayAcceptedTurns)} checkpoints=${String(run.checkpoints)} reuse=${String(run.repeatedDeliveredArtifacts)} verifier=${String(run.verifierExitCode)}`,
  );
}
