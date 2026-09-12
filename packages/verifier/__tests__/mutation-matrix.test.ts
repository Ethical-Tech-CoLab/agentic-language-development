/**
 * The LEDGER-INTEGRITY-DESIGN.md §17 acceptance matrix: the verifier is not
 * complete until it rejects every one of these mutations of an otherwise
 * valid bundle, with the failure located in the right check.
 */
import { join } from 'node:path';

import { hashCanonical } from '@ald/hashing';
import { merkleLeafHashes, merkleRoot } from '@ald/merkle';
import { SIGNER_KEY_IDS, type CheckpointManifest } from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  UNANCHORED_TX_REF,
  verifyBundle,
  verifyBundleDetailed,
  type ChainReader,
} from '@ald/verifier';

import {
  buildFixtureBundle,
  FIXTURE_ANCHOR_TX,
  type BuiltBundle,
} from './fixtures/build-bundle.js';
import {
  appendSignedLedgerEvent,
  checkpointFile,
  copyBundle,
  foreignSignature,
  mutateJsonl,
  readJsonFile,
  readJsonl,
  rewriteCheckpoints,
  writeJsonFile,
} from './helpers.js';

const OPTIONS = {
  verifierVersion: 'test-verifier-1',
  now: () => '2026-09-01T12:00:00.000Z',
  writeReport: false as const,
};

let fixture: BuiltBundle;

beforeAll(async () => {
  fixture = await buildFixtureBundle();
}, 60_000);

afterAll(async () => {
  await fixture.cleanup();
});

/** Runs `mutate` against a private copy of the fixture bundle. */
async function withMutatedBundle<T>(
  mutate: (bundleDir: string) => Promise<void>,
  assert: (bundleDir: string) => Promise<T>,
): Promise<T> {
  const copy = await copyBundle(fixture.bundleDir);
  try {
    await mutate(copy.dir);
    return await assert(copy.dir);
  } finally {
    await copy.cleanup();
  }
}

function babyALedger(bundleDir: string): string {
  return join(bundleDir, 'baby-a-ledger.jsonl');
}

function gapsMatching(gaps: readonly string[], needle: string): string[] {
  return gaps.filter((gap) => gap.includes(needle));
}

describe('chain mutations (LEDGER §17)', () => {
  it('rejects modified event content', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonl(babyALedger(dir), (events) => {
          const event = events[2];
          if (event === undefined) {
            throw new Error('fixture must have a third ledger event');
          }
          event['content'] = { artifactRef: 'proposal:tampered' };
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.entryHashesRebuilt).toBe(false);
        expect(gapsMatching(report.gaps, 'entry-hash-mismatch')).toHaveLength(1);
      },
    );
  });

  it('rejects a changed sequence number', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonl(babyALedger(dir), (events) => {
          const event = events[5];
          if (event === undefined) {
            throw new Error('fixture must have a sixth ledger event');
          }
          event['sequence'] = 99;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.sequencesStrictlyIncreasing).toBe(false);
        expect(gapsMatching(report.gaps, 'sequence-gap').length).toBeGreaterThan(0);
      },
    );
  });

  it('rejects a deleted middle entry', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonl(babyALedger(dir), (events) => {
          events.splice(4, 1);
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.sequencesStrictlyIncreasing).toBe(false);
        expect(report.checks.previousEntryLinksValid).toBe(false);
      },
    );
  });

  it('rejects an inserted entry', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonl(babyALedger(dir), (events) => {
          const event = events[4];
          if (event === undefined) {
            throw new Error('fixture must have a fifth ledger event');
          }
          events.splice(5, 0, {
            ...event,
            content: { artifactRef: 'proposal:inserted' },
          });
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.forks.length).toBeGreaterThan(0);
        expect(
          gapsMatching(report.gaps, 'duplicate-sequence').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects reordered entries', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonl(babyALedger(dir), (events) => {
          const third = events[2];
          const fourth = events[3];
          if (third === undefined || fourth === undefined) {
            throw new Error('fixture must have four ledger events');
          }
          events[2] = fourth;
          events[3] = third;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.previousEntryLinksValid).toBe(false);
        expect(report.checks.sequencesStrictlyIncreasing).toBe(false);
      },
    );
  });

  it('rejects an incorrect previous-entry hash', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonl(babyALedger(dir), (events) => {
          const event = events[6];
          if (event === undefined) {
            throw new Error('fixture must have a seventh ledger event');
          }
          event['previousEntryHash'] = `sha256:${'0'.repeat(64)}`;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.previousEntryLinksValid).toBe(false);
        expect(
          gapsMatching(report.gaps, 'previous-hash-mismatch').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects an invalid writer signature', async () => {
    await withMutatedBundle(
      async (dir) => {
        const events = await readJsonl(babyALedger(dir));
        const event = events[3];
        if (event === undefined) {
          throw new Error('fixture must have a fourth ledger event');
        }
        const signature = await foreignSignature(String(event['entryHash']));
        await mutateJsonl(babyALedger(dir), (all) => {
          const target = all[3];
          if (target !== undefined) {
            target['writerSignature'] = signature;
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.writerSignaturesValid).toBe(false);
        expect(report.checks.entryHashesRebuilt).toBe(true);
        expect(
          gapsMatching(report.gaps, 'signature-invalid').length,
        ).toBeGreaterThan(0);
      },
    );
  });
});

describe('checkpoint and Merkle mutations (LEDGER §17)', () => {
  it('rejects a Merkle root edited without re-hashing the manifest', async () => {
    await withMutatedBundle(
      async (dir) => {
        const path = checkpointFile(dir, 2);
        const manifest = await readJsonFile<CheckpointManifest>(path);
        manifest.babyA.merkleRoot = hashCanonical('test-tamper', { root: 1 });
        await writeJsonFile(path, manifest);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.checkpointHashesRebuilt).toBe(false);
        expect(
          gapsMatching(report.gaps, 'checkpoint-hash-mismatch').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects a Merkle root that was re-hashed and re-signed with the real witness key', async () => {
    await withMutatedBundle(
      async (dir) => {
        await rewriteCheckpoints(
          dir,
          fixture.runId,
          fixture.signerSeeds,
          [2],
          (manifest) => {
            manifest.babyA.merkleRoot = hashCanonical('test-tamper', { root: 2 });
          },
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.merkleRootsRebuilt).toBe(false);
        // The attacker holding the witness key produces a self-consistent,
        // correctly signed manifest: only the rebuild from the events detects it.
        expect(report.checks.checkpointHashesRebuilt).toBe(true);
        expect(report.checks.witnessSignaturesValid).toBe(true);
        expect(
          gapsMatching(report.gaps, 'merkle-root-mismatch').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects a false inclusion proof', async () => {
    await withMutatedBundle(
      async (dir) => {
        const path = join(dir, 'proofs', 'inclusion', 'babyA-1-at-2.json');
        const proof = await readJsonFile<{ path: string[] }>(path);
        proof.path[0] = hashCanonical('test-tamper', { sibling: 1 });
        await writeJsonFile(path, proof);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.inclusionProofsValid).toBe(false);
        expect(
          gapsMatching(report.gaps, 'inclusion-proof-invalid').length,
        ).toBe(1);
      },
    );
  });

  it('rejects an inconsistent checkpoint prefix', async () => {
    await withMutatedBundle(
      async (dir) => {
        const events = await readJsonl(babyALedger(dir));
        const shorterPrefix = merkleRoot(
          merkleLeafHashes(
            events.slice(0, 4).map((event) => ({
              sequence: Number(event['sequence']),
              entryHash: String(event['entryHash']),
            })),
          ),
        );
        await rewriteCheckpoints(
          dir,
          fixture.runId,
          fixture.signerSeeds,
          [1],
          (manifest) => {
            manifest.babyA.merkleRoot = shorterPrefix;
          },
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.consistencyProofsValid).toBe(false);
        expect(report.checks.merkleRootsRebuilt).toBe(false);
        expect(
          gapsMatching(report.gaps, 'consistency-proof-root-mismatch').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects an auxiliary tree that the run manifest does not declare', async () => {
    await withMutatedBundle(
      async (dir) => {
        await rewriteCheckpoints(
          dir,
          fixture.runId,
          fixture.signerSeeds,
          [2],
          (manifest) => {
            manifest.auxiliaryTrees['rogue'] = {
              treeSize: 1,
              merkleRoot: hashCanonical('test-tamper', { rogue: 1 }),
              lastEntryHash: hashCanonical('test-tamper', { rogue: 2 }),
            };
          },
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.merkleRootsRebuilt).toBe(false);
        expect(
          gapsMatching(report.gaps, 'undeclared-auxiliary-tree').length,
        ).toBe(1);
      },
    );
  });

  it('rejects a witness signature made by another key', async () => {
    await withMutatedBundle(
      async (dir) => {
        const path = checkpointFile(dir, 1);
        const manifest = await readJsonFile<CheckpointManifest>(path);
        const foreign = await foreignSignature(manifest.checkpointHash);
        manifest.witnessSignature = foreign;
        manifest.witnessKeyId = SIGNER_KEY_IDS.witness;
        await writeJsonFile(path, manifest);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.witnessSignaturesValid).toBe(false);
      },
    );
  });
});

describe('binding and configuration mutations (LEDGER §17)', () => {
  it('rejects a modified run configuration', async () => {
    await withMutatedBundle(
      async (dir) => {
        const path = join(dir, 'configuration', 'run-config.json');
        const config = await readJsonFile<Record<string, unknown>>(path);
        config['maxTurnsPerRun'] = Number(config['maxTurnsPerRun']) + 1;
        await writeJsonFile(path, config);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'configuration-hash-mismatch').length,
        ).toBe(1);
      },
    );
  });

  it('rejects a run manifest whose claim-boundary sentence was rewritten', async () => {
    await withMutatedBundle(
      async (dir) => {
        const path = join(dir, 'run-manifest.json');
        const manifest = await readJsonFile<Record<string, unknown>>(path);
        manifest['claimBoundaryStatement'] =
          'This run supports a channel-isolation claim.';
        await writeJsonFile(path, manifest);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(gapsMatching(report.gaps, 'claim-boundary-mismatch').length).toBe(1);
      },
    );
  });
});

describe('anchor mutations (LEDGER §17)', () => {
  async function mutateReceipts(
    dir: string,
    mutate: (receipts: Record<string, unknown>[]) => void,
  ): Promise<void> {
    const path = join(dir, 'anchors', 'base-receipts.json');
    const receipts = await readJsonFile<Record<string, unknown>[]>(path);
    mutate(receipts);
    await writeJsonFile(path, receipts);
  }

  it('rejects an anchor transaction on the wrong chain', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) {
            receipt['chainId'] = 1;
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.anchorChainIdMatches).toBe(false);
        // Both the receipt's own network/chainId consistency and the binding
        // to run-config.json's anchorNetwork fire.
        expect(
          gapsMatching(report.gaps, 'anchor-chain-id-mismatch').length,
        ).toBe(2);
      },
    );
  });

  it('rejects a simulated receipt relabeled as public-chain evidence', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) receipt['anchorClass'] = 'public-chain';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(gapsMatching(report.gaps, 'anchor-class-mismatch').length).toBe(1);
      },
    );
  });

  it('rejects a failed anchor transaction', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) {
            receipt['status'] = 'failed';
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.anchorTxConfirmed).toBe(false);
        expect(gapsMatching(report.gaps, 'anchor-not-confirmed').length).toBe(1);
      },
    );
  });

  it('rejects an anchor transaction the chain does not know', async () => {
    const missingReader: ChainReader = {
      chainId: 84_532,
      getTransaction: async () => null,
      getTransactionReceipt: async () => null,
    };

    const report = await verifyBundle(fixture.bundleDir, {
      ...OPTIONS,
      chainReader: missingReader,
    });

    expect(report.exitCode).toBe(1);
    expect(report.checks.anchorTxConfirmed).toBe(false);
    expect(gapsMatching(report.gaps, 'anchor-tx-missing').length).toBe(1);
    expect(
      gapsMatching(report.gaps, `anchor ${FIXTURE_ANCHOR_TX}`).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a reverted anchor transaction', async () => {
    const revertedReader: ChainReader = {
      chainId: 84_532,
      getTransaction: async () => {
        const final = await readJsonFile<CheckpointManifest>(
          checkpointFile(fixture.bundleDir, 2),
        );
        return {
          to: `0x${'22'.repeat(20)}`,
          input: `0x${final.checkpointHash.slice('sha256:'.length)}`,
          blockNumber: 4_242,
          blockHash: `0x${'cd'.repeat(32)}`,
        };
      },
      getTransactionReceipt: async () => ({
        status: 'reverted',
        blockNumber: 4_242,
        blockHash: `0x${'cd'.repeat(32)}`,
      }),
    };

    const report = await verifyBundle(fixture.bundleDir, {
      ...OPTIONS,
      chainReader: revertedReader,
    });

    expect(report.exitCode).toBe(1);
    expect(report.checks.anchorTxConfirmed).toBe(false);
    expect(gapsMatching(report.gaps, 'anchor-tx-reverted').length).toBe(1);
  });
});

describe('unanchored final ledger tail (LEDGER §17)', () => {
  async function appendTail(dir: string): Promise<void> {
    await appendSignedLedgerEvent(
      dir,
      'baby-a-ledger.jsonl',
      'baby-a-ledger',
      fixture.runId,
      fixture.signerSeeds,
      (previous) => {
        const next = { ...previous };
        delete next['entryHash'];
        delete next['writerSignature'];
        delete next['channelEventHash'];
        next['sequence'] = Number(previous['sequence']) + 1;
        next['turn'] = Number(previous['turn']) + 1;
        next['eventType'] = 'intention.recorded';
        next['content'] = { artifactRef: 'proposal:tail' };
        next['blindingNonce'] = 'nonce-tail';
        next['previousEntryHash'] = previous['entryHash'];
        next['recordedAt'] = '2026-08-24T22:00:00.000Z';
        return next;
      },
    );
  }

  it('fails when events extend past the last confirmed anchor', async () => {
    await withMutatedBundle(appendTail, async (dir) => {
      const { report, details } = await verifyBundleDetailed(dir, OPTIONS);

      expect(report.exitCode).toBe(1);
      expect(report.checks.unanchoredTailReported).toBe(true);
      expect(report.checks.entryHashesRebuilt).toBe(true);
      expect(report.checks.writerSignaturesValid).toBe(true);
      expect(report.gaps).toContain('unanchored-tail baby-a-ledger: 1 events');
      expect(details.anchoredThroughCheckpoint).toBe(2);
    });
  });

  it('reports the tail as a note under allowUnanchored', async () => {
    await withMutatedBundle(appendTail, async (dir) => {
      const report = await verifyBundle(dir, {
        ...OPTIONS,
        allowUnanchored: true,
      });

      expect(report.exitCode).toBe(0);
      expect(report.checks.unanchoredTailReported).toBe(true);
      expect(
        report.gaps.some(
          (gap) =>
            gap.startsWith('unanchored-tail baby-a-ledger: 1 events') &&
            gap.endsWith('(allowed by --allow-unanchored; local integrity only)'),
        ),
      ).toBe(true);
    });
  });

  it('fails when the anchor receipt is removed, and passes with allowUnanchored', async () => {
    await withMutatedBundle(
      async (dir) => {
        await writeJsonFile(join(dir, 'anchors', 'base-receipts.json'), []);
        // A genuinely unanchored run records the all-zero placeholder
        // (UNANCHORED_TX_REF), so the experiment record is made consistent
        // with the removed receipt; a dangling anchorTxRef is its own case.
        const path = join(dir, 'experiment-record.json');
        const file = await readJsonFile<{
          current: Record<string, unknown>;
          history: Record<string, unknown>[];
        }>(path);
        for (const record of file.history) {
          record['anchorTxRef'] = UNANCHORED_TX_REF;
        }
        file.current = file.history[file.history.length - 1] ?? {};
        await writeJsonFile(path, file);
      },
      async (dir) => {
        const strict = await verifyBundle(dir, OPTIONS);
        expect(strict.exitCode).toBe(1);
        expect(strict.checks.anchorTxConfirmed).toBe(false);
        expect(strict.checks.unanchoredTailReported).toBe(true);

        const lenient = await verifyBundle(dir, {
          ...OPTIONS,
          allowUnanchored: true,
        });
        expect(lenient.exitCode).toBe(0);
        expect(
          gapsMatching(lenient.gaps, 'anchor-final-checkpoint-unanchored').length,
        ).toBe(1);
      },
    );
  });
});
