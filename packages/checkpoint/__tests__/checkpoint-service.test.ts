import { UnknownRunError } from '@ald/evidence';
import { hashCanonical, hashRunId, omitFields, verifyHashSignature } from '@ald/hashing';
import {
  EMPTY_MERKLE_ROOT,
  merkleLeafHashes,
  merkleRoot,
  verifyConsistency,
  verifyInclusion,
} from '@ald/merkle';
import {
  CheckpointManifestSchema,
  ConsistencyProofSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  InclusionProofSchema,
  MANIFEST_SIGNATURE_FIELDS,
  type CheckpointManifest,
  type EventStream,
} from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import { EvidenceCheckpointService } from '../src/checkpoint-service.js';
import {
  CheckpointIntegrityError,
  CheckpointNotFoundError,
  CheckpointProofRangeError,
} from '../src/errors.js';
import { referenceFor } from '../src/trees.js';
import {
  RewritingEvidenceStore,
  cleanupTemporaryDirectories,
  commitTurns,
  createContext,
  hash,
  type CheckpointContext,
} from './support.js';

afterEach(cleanupTemporaryDirectories);

const EMPTY_TREE = {
  treeSize: 0,
  merkleRoot: EMPTY_MERKLE_ROOT,
  lastEntryHash: GENESIS_HASH,
};

function witnessKey(context: CheckpointContext): string {
  const witness = context.signers
    .publicKeys()
    .find((signer) => signer.domain === 'witness');
  if (witness === undefined) {
    throw new Error('the run has no witness signer');
  }
  return witness.publicKey;
}

function recomputeHash(manifest: CheckpointManifest): string {
  return hashCanonical(
    HASH_DOMAINS.checkpoint,
    omitFields(manifest, MANIFEST_SIGNATURE_FIELDS),
  );
}

describe('EvidenceCheckpointService.createCheckpoint', () => {
  it('writes checkpoint 0 for an empty run with three empty mandatory trees', async () => {
    const context = await createContext();

    const manifest = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );

    expect(manifest.checkpointSequence).toBe(0);
    expect(manifest.previousCheckpointHash).toBe(GENESIS_HASH);
    expect(manifest.babyA).toEqual(EMPTY_TREE);
    expect(manifest.babyB).toEqual(EMPTY_TREE);
    expect(manifest.channel).toEqual(EMPTY_TREE);
    expect(manifest.auxiliaryTrees).toEqual({});
    expect(manifest.runIdHash).toBe(hashRunId(context.runId));
    expect(manifest.reason).toBe('run-initialized');
    expect(manifest.witnessKeyId).toBe(
      context.signers.signer('witness').keyId,
    );
    expect(manifest.softwareCommit).toBe('git:test-commit');
    expect(CheckpointManifestSchema.parse(manifest)).toEqual(manifest);
    expect(context.writer.readCheckpoints(context.runId)).toEqual([manifest]);

    context.close();
  });

  it('binds the run configuration and prompt bundle hashes', async () => {
    const context = await createContext({ promptBundleHash: hash('7') });

    const manifest = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );

    const metadata = context.writer.readRunMetadata(context.runId);
    expect(manifest.runConfigurationHash).toBe(metadata?.configurationHash);
    expect(manifest.promptBundleHash).toBe(hash('7'));

    context.close();
  });

  it('normalizes an unprefixed configuration prompt-bundle hash', async () => {
    const bare = 'ab'.repeat(32).toUpperCase();
    const context = await createContext({ promptBundleHash: bare });

    const manifest = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );

    expect(manifest.promptBundleHash).toBe(`sha256:${'ab'.repeat(32)}`);
    expect(CheckpointManifestSchema.safeParse(manifest).success).toBe(true);

    context.close();
  });

  it('carries a witness signature and a reproducible checkpoint hash', async () => {
    const context = await createContext();
    await commitTurns(context, 3);

    const manifest = await context.service.createCheckpoint(
      context.runId,
      'policy-checkpoint',
    );

    expect(recomputeHash(manifest)).toBe(manifest.checkpointHash);
    expect(
      verifyHashSignature(
        manifest.checkpointHash,
        manifest.witnessSignature,
        witnessKey(context),
      ),
    ).toBe(true);
    expect(
      verifyHashSignature(
        recomputeHash({ ...manifest, softwareCommit: 'git:other' }),
        manifest.witnessSignature,
        witnessKey(context),
      ),
    ).toBe(false);

    context.close();
  });

  it('commits every tree the Evidence Store holds, with independently recomputed roots', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 5);

    const manifest = await context.service.createCheckpoint(
      context.runId,
      'event-interval',
    );

    expect(manifest.checkpointSequence).toBe(1);
    const streams: EventStream[] = [
      'baby-a-ledger',
      'baby-b-ledger',
      'channel',
      'turns',
    ];
    for (const stream of streams) {
      const events = context.writer.readEvents(context.runId, stream);
      expect(events).toHaveLength(5);
      const expected = {
        treeSize: 5,
        merkleRoot: merkleRoot(merkleLeafHashes(events)),
        lastEntryHash: events[4]?.entryHash,
      };
      expect(referenceFor(manifest, stream)).toEqual(expected);
    }
    expect(Object.keys(manifest.auxiliaryTrees)).toEqual(['turns']);
    expect(manifest.auxiliaryTrees.affect).toBeUndefined();
    expect(manifest.auxiliaryTrees.audit).toBeUndefined();

    context.close();
  });

  it('chains each checkpoint to the previous checkpoint hash', async () => {
    const context = await createContext();

    const first = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );
    await commitTurns(context, 2);
    const second = await context.service.createCheckpoint(
      context.runId,
      'pause',
    );
    await commitTurns(context, 2, 3);
    const third = await context.service.createCheckpoint(
      context.runId,
      'run-sealed',
    );

    expect(second.previousCheckpointHash).toBe(first.checkpointHash);
    expect(third.previousCheckpointHash).toBe(second.checkpointHash);
    expect([
      first.checkpointSequence,
      second.checkpointSequence,
      third.checkpointSequence,
    ]).toEqual([0, 1, 2]);
    expect(third.channel.treeSize).toBeGreaterThan(second.channel.treeSize);

    context.close();
  });

  it('refuses a manifest whose auxiliary trees are not the trees the store holds', async () => {
    const context = await createContext();
    await commitTurns(context, 2);
    const manifest = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );

    // An extra tree the store does not hold.
    expect(() =>
      context.service.verifyManifestTrees(context.runId, {
        ...manifest,
        auxiliaryTrees: {
          ...manifest.auxiliaryTrees,
          affect: { ...EMPTY_TREE, treeSize: 1, lastEntryHash: hash('9') },
        },
      }),
    ).toThrow(CheckpointIntegrityError);

    // A tree the store holds, missing from the manifest.
    expect(() =>
      context.service.verifyManifestTrees(context.runId, {
        ...manifest,
        auxiliaryTrees: {},
      }),
    ).toThrow(CheckpointIntegrityError);

    // A mandatory tree with a rewritten root.
    expect(() =>
      context.service.verifyManifestTrees(context.runId, {
        ...manifest,
        channel: { ...manifest.channel, merkleRoot: hash('a') },
      }),
    ).toThrow(CheckpointIntegrityError);

    expect(() =>
      context.service.verifyManifestTrees(context.runId, manifest),
    ).not.toThrow();

    context.close();
  });

  it('refuses to build a checkpoint over a rewritten or truncated prefix', async () => {
    const context = await createContext();
    await commitTurns(context, 3);
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 1, 4);

    const rewritten = new EvidenceCheckpointService({
      evidence: new RewritingEvidenceStore(context.writer, 'baby-a-ledger', (events) =>
        events.map((event, index) =>
          index === 1 ? { ...event, entryHash: hash('b') } : event,
        ),
      ),
      signers: context.signers,
      clock: context.clock,
      softwareCommit: 'git:test-commit',
    });
    await expect(
      rewritten.createCheckpoint(context.runId, 'pause'),
    ).rejects.toThrow(CheckpointIntegrityError);

    const truncated = new EvidenceCheckpointService({
      evidence: new RewritingEvidenceStore(context.writer, 'channel', (events) =>
        events.slice(0, 2),
      ),
      signers: context.signers,
      clock: context.clock,
      softwareCommit: 'git:test-commit',
    });
    await expect(
      truncated.createCheckpoint(context.runId, 'pause'),
    ).rejects.toThrow(CheckpointIntegrityError);

    // Nothing was written by either failed attempt.
    expect(context.writer.readCheckpoints(context.runId)).toHaveLength(1);
    // The honest service still checkpoints the grown trees.
    const next = await context.service.createCheckpoint(context.runId, 'pause');
    expect(next.checkpointSequence).toBe(1);

    context.close();
  });

  it('refuses a checkpoint over a stream whose sequences are not contiguous', async () => {
    const context = await createContext();
    await commitTurns(context, 3);

    const renumbered = new EvidenceCheckpointService({
      evidence: new RewritingEvidenceStore(context.writer, 'turns', (events) =>
        events.map((event) => ({ ...event, sequence: event.sequence + 1 })),
      ),
      signers: context.signers,
      clock: context.clock,
      softwareCommit: 'git:test-commit',
    });

    await expect(
      renumbered.createCheckpoint(context.runId, 'run-initialized'),
    ).rejects.toThrow(CheckpointIntegrityError);

    context.close();
  });

  it('refuses an unregistered run', async () => {
    const context = await createContext();

    await expect(
      context.service.createCheckpoint('run-missing', 'run-initialized'),
    ).rejects.toThrow(UnknownRunError);

    context.close();
  });
});

describe('EvidenceCheckpointService.createCheckpointIfChanged', () => {
  it('skips an interval trigger when no tree grew', async () => {
    const context = await createContext();
    await commitTurns(context, 2);
    const first = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );

    const skipped = await context.service.createCheckpointIfChanged(
      context.runId,
      'event-interval',
    );

    expect(skipped.created).toBe(false);
    expect(skipped.manifest).toEqual(first);
    expect(context.writer.readCheckpoints(context.runId)).toHaveLength(1);

    const timeSkipped = await context.service.createCheckpointIfChanged(
      context.runId,
      'time-interval',
    );
    expect(timeSkipped.created).toBe(false);
    expect(context.writer.readCheckpoints(context.runId)).toHaveLength(1);

    context.close();
  });

  it('creates an interval checkpoint once a tree grows', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 1);

    const created = await context.service.createCheckpointIfChanged(
      context.runId,
      'event-interval',
    );

    expect(created.created).toBe(true);
    expect(created.manifest.checkpointSequence).toBe(1);
    expect(context.writer.readCheckpoints(context.runId)).toHaveLength(2);

    context.close();
  });

  it('always creates for a lifecycle reason, even with no new events', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');

    for (const reason of [
      'pause',
      'intervention',
      'recovery',
      'policy-checkpoint',
      'run-sealed',
      'run-aborted',
    ] as const) {
      const result = await context.service.createCheckpointIfChanged(
        context.runId,
        reason,
      );
      expect(result.created).toBe(true);
      expect(result.manifest.reason).toBe(reason);
    }
    expect(context.writer.readCheckpoints(context.runId)).toHaveLength(7);

    context.close();
  });
});

describe('EvidenceCheckpointService.inclusionProof', () => {
  it('proves the first and last event of every mandatory tree', async () => {
    const context = await createContext();
    await commitTurns(context, 6);
    const manifest = await context.service.createCheckpoint(
      context.runId,
      'run-sealed',
    );

    for (const stream of ['baby-a-ledger', 'baby-b-ledger', 'channel'] as const) {
      for (const sequence of [1, 6]) {
        const proof = context.service.inclusionProof(
          context.runId,
          stream,
          sequence,
          manifest.checkpointSequence,
        );
        expect(InclusionProofSchema.parse(proof)).toEqual(proof);
        expect(proof.leafIndex).toBe(sequence - 1);
        expect(proof.treeSize).toBe(6);
        expect(proof.root).toBe(referenceFor(manifest, stream).merkleRoot);
        expect(verifyInclusion(proof)).toBe(true);
        expect(
          verifyInclusion({ ...proof, leafHash: hash('f') }),
        ).toBe(false);
      }
    }

    context.close();
  });

  it('refuses a sequence outside the committed tree and an unknown checkpoint', async () => {
    const context = await createContext();
    await commitTurns(context, 2);
    const manifest = await context.service.createCheckpoint(
      context.runId,
      'run-sealed',
    );

    expect(() =>
      context.service.inclusionProof(context.runId, 'channel', 3, 0),
    ).toThrow(CheckpointProofRangeError);
    expect(() =>
      context.service.inclusionProof(context.runId, 'affect', 1, 0),
    ).toThrow(CheckpointProofRangeError);
    expect(() =>
      context.service.inclusionProof(
        context.runId,
        'channel',
        1,
        manifest.checkpointSequence + 5,
      ),
    ).toThrow(CheckpointNotFoundError);
    expect(() =>
      context.service.inclusionProof(context.runId, 'intervention', 1, 0),
    ).toThrow(CheckpointProofRangeError);

    context.close();
  });
});

describe('EvidenceCheckpointService.consistencyProof', () => {
  it('verifies every consecutive checkpoint transition against the stored roots', async () => {
    const context = await createContext();
    const zero = await context.service.createCheckpoint(
      context.runId,
      'run-initialized',
    );
    await commitTurns(context, 3);
    const one = await context.service.createCheckpoint(context.runId, 'pause');
    await commitTurns(context, 4, 4);
    const two = await context.service.createCheckpoint(
      context.runId,
      'run-sealed',
    );

    const first = context.service.consistencyProof(
      context.runId,
      'channel',
      zero.checkpointSequence,
      one.checkpointSequence,
    );
    expect(ConsistencyProofSchema.parse(first)).toEqual(first);
    expect(first.fromSize).toBe(0);
    expect(first.toSize).toBe(3);
    expect(first.fromRoot).toBe(zero.channel.merkleRoot);
    expect(first.toRoot).toBe(one.channel.merkleRoot);
    expect(verifyConsistency(first)).toBe(true);

    const second = context.service.consistencyProof(
      context.runId,
      'channel',
      one.checkpointSequence,
      two.checkpointSequence,
    );
    expect(second.fromSize).toBe(3);
    expect(second.toSize).toBe(7);
    expect(second.fromRoot).toBe(one.channel.merkleRoot);
    expect(second.toRoot).toBe(two.channel.merkleRoot);
    expect(verifyConsistency(second)).toBe(true);
    expect(verifyConsistency({ ...second, path: [] })).toBe(false);

    const skip = context.service.consistencyProof(
      context.runId,
      'turns',
      zero.checkpointSequence,
      two.checkpointSequence,
    );
    expect(verifyConsistency(skip)).toBe(true);
    expect(skip.treeName).toBe('turns');

    context.close();
  });

  it('detects a rewritten prefix instead of re-rooting it', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 3);
    await context.service.createCheckpoint(context.runId, 'pause');
    await commitTurns(context, 3, 4);
    await context.service.createCheckpoint(context.runId, 'run-sealed');

    // Honest reads still verify.
    expect(
      verifyConsistency(
        context.service.consistencyProof(context.runId, 'channel', 1, 2),
      ),
    ).toBe(true);

    const tampered = new EvidenceCheckpointService({
      evidence: new RewritingEvidenceStore(
        context.writer,
        'channel',
        (events) =>
          events.map((event, index) =>
            index === 0 ? { ...event, entryHash: hash('c') } : event,
          ),
      ),
      signers: context.signers,
      clock: context.clock,
      softwareCommit: 'git:test-commit',
    });

    expect(() =>
      tampered.consistencyProof(context.runId, 'channel', 1, 2),
    ).toThrow(CheckpointIntegrityError);
    expect(() =>
      tampered.inclusionProof(context.runId, 'channel', 1, 2),
    ).toThrow(CheckpointIntegrityError);
    // Untouched streams still prove out through the same tampering store.
    expect(() =>
      tampered.consistencyProof(context.runId, 'baby-a-ledger', 1, 2),
    ).not.toThrow();

    context.close();
  });

  it('detects a truncated prefix', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 4);
    await context.service.createCheckpoint(context.runId, 'run-sealed');

    const truncating = new EvidenceCheckpointService({
      evidence: new RewritingEvidenceStore(context.writer, 'channel', (events) =>
        events.slice(0, -1),
      ),
      signers: context.signers,
      clock: context.clock,
      softwareCommit: 'git:test-commit',
    });

    expect(() =>
      truncating.consistencyProof(context.runId, 'channel', 0, 1),
    ).toThrow(CheckpointIntegrityError);

    context.close();
  });

  it('refuses a descending checkpoint pair', async () => {
    const context = await createContext();
    await context.service.createCheckpoint(context.runId, 'run-initialized');
    await commitTurns(context, 1);
    await context.service.createCheckpoint(context.runId, 'run-sealed');

    expect(() =>
      context.service.consistencyProof(context.runId, 'channel', 1, 0),
    ).toThrow(CheckpointProofRangeError);

    context.close();
  });
});
