/**
 * Builds a real, signed evidence bundle for the verifier tests.
 *
 * The bundle is produced the way the runtime produces one: events are
 * committed through `SqliteEvidenceWriter` with per-run Ed25519 signers, the
 * checkpoint manifests are hashed and witness-signed per
 * docs/evidence-bundle-format.md §6, an anchor receipt binds the final
 * checkpoint digest, and `exportRunBundle` writes the documented layout. Only
 * the proof files are written here, because the exporter never writes them.
 *
 * The result is the "unchanged bundle" of LEDGER-INTEGRITY-DESIGN.md §17: it
 * must verify with `exitCode: 0` and no `allowUnanchored`. Every mutation test
 * copies it and breaks exactly one thing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemorySignerRegistry,
  canonicalJson,
  hashCanonical,
  hashRunId,
} from '@ald/hashing';
import {
  SqliteEvidenceWriter,
  exportRunBundle,
  openEvidenceDatabase,
} from '@ald/evidence';
import { buildRunConfig } from '@ald/lifecycle';
import {
  EMPTY_MERKLE_ROOT,
  buildConsistencyProofRecord,
  buildInclusionProofRecord,
  merkleLeafHashes,
  merkleRoot,
} from '@ald/merkle';
import {
  CLAIM_BOUNDARY_STATEMENTS,
  GENESIS_HASH,
  HASH_DOMAINS,
  SIGNER_KEY_IDS,
  babyIdForRole,
  otherRole,
  type BabyRole,
  type CheckpointManifest,
  type CheckpointReason,
  type EventStream,
  type ExperimentRecord,
  type RunConfig,
  type TreeReference,
} from '@ald/types';

/** Deterministic clock so the fixture is byte-stable across runs. */
class StepClock {
  private step = 0;

  constructor(private readonly startMs = Date.UTC(2026, 7, 24, 21, 0, 0)) {}

  now(): string {
    const value = new Date(this.startMs + this.step * 1_000).toISOString();
    this.step += 1;
    return value;
  }
}

/** Checkpoint tree name → stream, matching MANDATORY_TREES/AUXILIARY_TREES. */
export const FIXTURE_TREES: readonly [string, EventStream][] = [
  ['babyA', 'baby-a-ledger'],
  ['babyB', 'baby-b-ledger'],
  ['channel', 'channel'],
  ['turns', 'turns'],
];

export const FIXTURE_TURNS = 12;

/**
 * Learner contract the fixture run references. `exportRunBundle` writes
 * `text` verbatim to `prompts/learner-contract.<track>.v<version>.md`
 * (packages/evidence/src/export.ts), and `promptBundleHash` over
 * `{ <track>: <text> }` is what the runtime binds into the run configuration
 * (packages/orchestrator/src/nursery-runtime.ts `#bindHash`,
 * packages/learners/src/contracts.ts `promptBundleHash`), so the bundle is
 * self-consistent for the verifier's prompts/ rebuild.
 */
export const FIXTURE_CONTRACT = {
  track: 'no-learning',
  version: '1',
  text: '# no-learning learner contract (fixture)\n',
} as const;

/** `hashCanonical(promptBundle, { <track>: <text> })` for the fixture. */
export const FIXTURE_PROMPT_BUNDLE_HASH = hashCanonical(
  HASH_DOMAINS.promptBundle,
  { [FIXTURE_CONTRACT.track]: FIXTURE_CONTRACT.text },
);
export const FIXTURE_ANCHOR_TX = `0x${'ab'.repeat(32)}`;
export const FIXTURE_ANCHOR_TO = `0x${'22'.repeat(20)}`;
export const FIXTURE_CHAIN_ID = 84_532;
export const FIXTURE_BLOCK_NUMBER = 4_242;
export const FIXTURE_BLOCK_HASH = `0x${'cd'.repeat(32)}`;

export interface BuiltBundle {
  /** Directory containing the exported bundle. */
  bundleDir: string;
  /** Parent temp directory (holds the SQLite store too). */
  workDir: string;
  runId: string;
  configurationHash: string;
  checkpoints: CheckpointManifest[];
  /** Hex Ed25519 seeds, so a test can re-sign a mutated artifact. */
  signerSeeds: Record<string, string>;
  config: RunConfig;
  cleanup(): Promise<void>;
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, 'utf8');
}

function treeReference(
  writer: SqliteEvidenceWriter,
  runId: string,
  stream: EventStream,
): TreeReference {
  const events = writer.readEvents(runId, stream);
  const leafHashes = merkleLeafHashes(
    events.map((event) => ({
      sequence: event.sequence,
      entryHash: event.entryHash,
    })),
  );
  return {
    treeSize: events.length,
    merkleRoot: events.length === 0 ? EMPTY_MERKLE_ROOT : merkleRoot(leafHashes),
    lastEntryHash: events.at(-1)?.entryHash ?? GENESIS_HASH,
  };
}

export function treeReferenceOf(
  checkpoint: CheckpointManifest,
  treeName: string,
): TreeReference | undefined {
  if (treeName === 'babyA') {
    return checkpoint.babyA;
  }
  if (treeName === 'babyB') {
    return checkpoint.babyB;
  }
  if (treeName === 'channel') {
    return checkpoint.channel;
  }
  return checkpoint.auxiliaryTrees[treeName];
}

function proofSequences(treeSize: number): number[] {
  return [...new Set([1, Math.max(1, Math.ceil(treeSize / 2)), treeSize])]
    .filter((sequence) => sequence >= 1 && sequence <= treeSize)
    .sort((left, right) => left - right);
}

/** Builds the fixture bundle in a fresh temp directory. */
export async function buildFixtureBundle(): Promise<BuiltBundle> {
  const workDir = await mkdtemp(join(tmpdir(), 'ald-verifier-fixture-'));
  const bundleDir = join(workDir, 'bundle');
  const runId = 'run-e00-verifier-fixture';
  const clock = new StepClock();
  const signers = InMemorySignerRegistry.generate(runId);
  const database = openEvidenceDatabase(join(workDir, 'evidence.sqlite'));
  const writer = new SqliteEvidenceWriter({
    database,
    signers,
    clock,
    softwareCommit: 'git:fixture',
  });

  const config = buildRunConfig({
    runId,
    experimentId: 'E00',
    randomSeed: 'seed-e00-fixture',
    deploymentMode: 'prototype',
    babyA: { track: 'no-learning' },
    babyB: { track: 'no-learning' },
    learningSignal: 'none',
    promptBundleHash: FIXTURE_PROMPT_BUNDLE_HASH,
  });
  const { configurationHash } = writer.registerRun(config);
  const runIdHash = hashRunId(runId);
  const checkpoints: CheckpointManifest[] = [];

  const createCheckpoint = async (
    reason: CheckpointReason,
  ): Promise<CheckpointManifest> => {
    const turns = treeReference(writer, runId, 'turns');
    const unsigned = {
      version: 1 as const,
      runIdHash,
      checkpointSequence: checkpoints.length,
      previousCheckpointHash:
        checkpoints.at(-1)?.checkpointHash ?? GENESIS_HASH,
      babyA: treeReference(writer, runId, 'baby-a-ledger'),
      babyB: treeReference(writer, runId, 'baby-b-ledger'),
      channel: treeReference(writer, runId, 'channel'),
      auxiliaryTrees: turns.treeSize === 0 ? {} : { turns },
      runConfigurationHash: configurationHash,
      promptBundleHash: config.promptBundleHash,
      softwareCommit: 'git:fixture',
      createdAt: clock.now(),
      witnessKeyId: SIGNER_KEY_IDS.witness,
      reason,
    };
    const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
    const manifest: CheckpointManifest = {
      ...unsigned,
      checkpointHash,
      witnessSignature: await signers.signer('witness').sign(checkpointHash),
    };
    writer.insertCheckpointManifest(manifest);
    checkpoints.push(manifest);
    return manifest;
  };

  await createCheckpoint('run-initialized');

  for (let turn = 1; turn <= FIXTURE_TURNS; turn += 1) {
    const sender: BabyRole = turn % 2 === 1 ? 'baby-a' : 'baby-b';
    const recipient = otherRole(sender);
    const publicArtifact = { symbols: ['S01'] };

    const committed = await writer.commitTurn({
      runId,
      turn,
      sender,
      recipient,
      carrier: 'fixed-token',
      communicationCondition: 'normal',
      proposal: { kind: 'emit_symbols', publicArtifact },
      intentionDraft: {
        eventType: 'intention.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:S01',
        content: { artifactRef: `proposal:${String(turn)}` },
        blindingNonce: `nonce-sender-${String(turn)}`,
        evidenceRefs: [],
      },
      deliveredArtifact: publicArtifact,
    });

    await writer.appendLedgerEvent({
      runId,
      babyId: babyIdForRole(recipient),
      turn,
      draft: {
        eventType: 'interpretation.recorded',
        contentSchema: 'agent-native-ledger',
        subjectId: 'symbol:S01',
        content: { artifactRef: `delivery:${String(turn)}` },
        blindingNonce: `nonce-receiver-${String(turn)}`,
        evidenceRefs: [],
      },
      channelEventHash: committed.channelEvent.entryHash,
    });

    await writer.appendTurnRecord({
      runId,
      turn,
      phase: 'running',
      roles: { sender, receiver: recipient },
      communicationCondition: 'normal',
      scenarioRef: `scenario-${String(turn)}`,
      scenarioStateHash: hashCanonical(HASH_DOMAINS.scenarioState, { turn }),
      observationHashes: {
        babyA: hashCanonical(HASH_DOMAINS.observation, { turn, role: 'baby-a' }),
        babyB: hashCanonical(HASH_DOMAINS.observation, { turn, role: 'baby-b' }),
      },
      babyProposalHash: committed.channelEvent.babyProposalHash ?? null,
      deliveredArtifactHash: committed.channelEvent.publicArtifactHash,
      channelEventHash: committed.channelEvent.entryHash,
      actionHash: hashCanonical(HASH_DOMAINS.action, { turn }),
      outcomeHash: hashCanonical(HASH_DOMAINS.outcome, { turn }),
      outcome: { success: turn % 3 !== 0, reward: turn % 3 === 0 ? 0 : 1 },
    });

    if (turn === 3) {
      await writer.appendInterventionEvent({
        runId,
        eventType: 'annotate',
        actorId: 'researcher:fixture',
        reasonCode: 'fixture-annotation',
        details: { note: 'fixture bundle annotation' },
      });
    }

    if (turn === FIXTURE_TURNS / 2 || turn === FIXTURE_TURNS) {
      await createCheckpoint('event-interval');
    }
  }

  const finalCheckpoint = checkpoints[checkpoints.length - 1];
  if (finalCheckpoint === undefined) {
    throw new Error('fixture must produce at least one checkpoint');
  }

  writer.insertAnchorReceipt({
    version: 1,
    runId,
    checkpointSequence: finalCheckpoint.checkpointSequence,
    checkpointHash: finalCheckpoint.checkpointHash,
    network: 'base-sepolia',
    chainId: FIXTURE_CHAIN_ID,
    transactionHash: FIXTURE_ANCHOR_TX,
    from: `0x${'11'.repeat(20)}`,
    to: FIXTURE_ANCHOR_TO,
    inputData: `0x${finalCheckpoint.checkpointHash.slice('sha256:'.length)}`,
    blockNumber: FIXTURE_BLOCK_NUMBER,
    blockHash: FIXTURE_BLOCK_HASH,
    status: 'confirmed',
    confirmations: 3,
    finalityPolicy: config.finalityPolicy,
    rpcEndpointLabel: 'fixture-rpc',
    recordedAt: clock.now(),
  });

  const baseRecord: Omit<ExperimentRecord, 'recordVersion' | 'disposition' | 'checkpointManifestRef'> = {
    version: 1,
    runId,
    experimentId: 'E00',
    deploymentMode: 'prototype',
    learnerContractVersion: '1',
    runConfigRef: configurationHash,
    protocolGitCommit: config.protocolGitCommit,
    preRegistrationHash: config.preRegistrationHash,
    anchorTxRef: FIXTURE_ANCHOR_TX,
    verifierReportRef: 'verification-report.json',
    claimBoundaryStatement: CLAIM_BOUNDARY_STATEMENTS.prototype,
    deviations: [],
  };
  const midCheckpoint = checkpoints[1] ?? finalCheckpoint;
  writer.appendExperimentRecord({
    ...baseRecord,
    recordVersion: 1,
    disposition: 'invalid',
    checkpointManifestRef: midCheckpoint.checkpointHash,
  });
  writer.appendExperimentRecord({
    ...baseRecord,
    recordVersion: 2,
    disposition: 'valid',
    checkpointManifestRef: finalCheckpoint.checkpointHash,
  });

  await exportRunBundle(writer, runId, bundleDir, {
    softwareCommit: 'git:fixture',
    learnerContracts: [{ ...FIXTURE_CONTRACT }],
    overwrite: true,
  });

  await mkdir(join(bundleDir, 'proofs', 'inclusion'), { recursive: true });
  await mkdir(join(bundleDir, 'proofs', 'consistency'), { recursive: true });

  for (const checkpoint of checkpoints) {
    for (const [treeName, stream] of FIXTURE_TREES) {
      const reference = treeReferenceOf(checkpoint, treeName);
      if (reference === undefined || reference.treeSize === 0) {
        continue;
      }
      const events = writer
        .readEvents(runId, stream)
        .slice(0, reference.treeSize);
      const leafHashes = merkleLeafHashes(
        events.map((event) => ({
          sequence: event.sequence,
          entryHash: event.entryHash,
        })),
      );
      for (const sequence of proofSequences(reference.treeSize)) {
        const event = events[sequence - 1];
        if (event === undefined) {
          continue;
        }
        const record = buildInclusionProofRecord({
          stream,
          treeName,
          checkpointSequence: checkpoint.checkpointSequence,
          sequence,
          entryHash: event.entryHash,
          leafHashes,
        });
        await writeCanonical(
          join(
            bundleDir,
            'proofs',
            'inclusion',
            `${treeName}-${String(sequence)}-at-${String(checkpoint.checkpointSequence)}.json`,
          ),
          record,
        );
      }
    }
  }

  for (let index = 1; index < checkpoints.length; index += 1) {
    const from = checkpoints[index - 1];
    const to = checkpoints[index];
    if (from === undefined || to === undefined) {
      continue;
    }
    for (const [treeName, stream] of FIXTURE_TREES) {
      const toReference = treeReferenceOf(to, treeName);
      // Bundle format §6: a tree absent from the earlier manifest is the
      // empty tree, so the proof spans fromSize 0 (regression: turns-0-1).
      const fromReference =
        treeReferenceOf(from, treeName) ??
        (toReference === undefined
          ? undefined
          : { treeSize: 0, merkleRoot: EMPTY_MERKLE_ROOT, lastEntryHash: GENESIS_HASH });
      if (fromReference === undefined || toReference === undefined) {
        continue;
      }
      const events = writer
        .readEvents(runId, stream)
        .slice(0, toReference.treeSize);
      const leafHashes = merkleLeafHashes(
        events.map((event) => ({
          sequence: event.sequence,
          entryHash: event.entryHash,
        })),
      );
      const record = buildConsistencyProofRecord({
        stream,
        treeName,
        fromCheckpointSequence: from.checkpointSequence,
        toCheckpointSequence: to.checkpointSequence,
        fromSize: fromReference.treeSize,
        leafHashes,
      });
      await writeCanonical(
        join(
          bundleDir,
          'proofs',
          'consistency',
          `${treeName}-${String(from.checkpointSequence)}-${String(to.checkpointSequence)}.json`,
        ),
        record,
      );
    }
  }

  database.close();

  return {
    bundleDir,
    workDir,
    runId,
    configurationHash,
    checkpoints,
    signerSeeds: signers.exportSeeds(),
    config,
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}
