/**
 * Mutations the verifier used to accept: manifest-controlled signature
 * checks, hash rebuilds over schema projections instead of the file's own
 * bytes, unbound manifest/experiment-record fields, unverified `prompts/`,
 * uncontained bundle-relative paths, and anchors that the run configuration
 * never declared (LEDGER-INTEGRITY-DESIGN.md §14, §17;
 * docs/evidence-bundle-format.md §1, §3, §6, §7, §8).
 *
 * One case per new check, each a single edit of an otherwise valid bundle.
 */
import { chmod, cp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashCanonical } from '@ald/hashing';
import { HASH_DOMAINS, type CheckpointManifest } from '@ald/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SAFE_TAG_CONFIRMATION_PROXY,
  requiredConfirmations,
  verifyBundle,
  verifyBundleDetailed,
  type ChainReader,
} from '@ald/verifier';

import {
  buildFixtureBundle,
  FIXTURE_ANCHOR_TX,
  FIXTURE_CONTRACT,
  type BuiltBundle,
} from './fixtures/build-bundle.js';
import {
  checkpointFile,
  copyBundle,
  mutateJsonFile,
  mutateJsonl,
  mutateManifest,
  readJsonFile,
  rewriteCheckpoints,
  streamDeclarationOf,
  writeJsonFile,
} from './helpers.js';

const OPTIONS = {
  verifierVersion: 'test-verifier-1',
  now: () => '2026-09-01T12:00:00.000Z',
  writeReport: false as const,
};

const OTHER_HASH = `sha256:${'ee'.repeat(32)}`;
const OTHER_TX = `0x${'ff'.repeat(32)}`;

let fixture: BuiltBundle;

beforeAll(async () => {
  fixture = await buildFixtureBundle();
}, 60_000);

afterAll(async () => {
  await fixture.cleanup();
});

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

function gapsMatching(gaps: readonly string[], needle: string): string[] {
  return gaps.filter((gap) => gap.includes(needle));
}

async function mutateReceipts(
  dir: string,
  mutate: (receipts: Record<string, unknown>[]) => void,
): Promise<void> {
  await mutateJsonFile<Record<string, unknown>[]>(
    join(dir, 'anchors', 'base-receipts.json'),
    mutate,
  );
}

/**
 * Re-points the anchor receipt and the experiment record at a re-signed
 * checkpoint series, so a test that rewrites a checkpoint isolates the rule it
 * is about instead of also tripping the anchor and record bindings.
 */
async function repointAnchor(
  dir: string,
  rewritten: readonly CheckpointManifest[],
): Promise<void> {
  const final = rewritten[rewritten.length - 1];
  const mid = rewritten[1];
  if (final === undefined || mid === undefined) {
    throw new Error('fixture must rewrite at least three checkpoints');
  }
  await mutateReceipts(dir, (receipts) => {
    const receipt = receipts[0];
    if (receipt !== undefined) {
      receipt['checkpointHash'] = final.checkpointHash;
      receipt['checkpointSequence'] = final.checkpointSequence;
      receipt['inputData'] = `0x${final.checkpointHash.slice('sha256:'.length)}`;
    }
  });
  await mutateJsonFile<{
    current: Record<string, unknown>;
    history: Record<string, unknown>[];
  }>(join(dir, 'experiment-record.json'), (file) => {
    const first = file.history[0];
    const last = file.history[file.history.length - 1];
    if (first !== undefined) {
      first['checkpointManifestRef'] = mid.checkpointHash;
    }
    if (last !== undefined) {
      last['checkpointManifestRef'] = final.checkpointHash;
    }
    file.current = last ?? {};
  });
}

async function mutateExperimentRecord(
  dir: string,
  mutate: (record: Record<string, unknown>) => void,
): Promise<void> {
  await mutateJsonFile<{
    current: Record<string, unknown>;
    history: Record<string, unknown>[];
  }>(join(dir, 'experiment-record.json'), (file) => {
    for (const record of file.history) {
      mutate(record);
    }
    file.current = file.history[file.history.length - 1] ?? {};
  });
}

describe('manifest-controlled signature checks (LEDGER §14 step 5)', () => {
  it('fails writerSignaturesValid when a signed stream declares no signer domain', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          delete streamDeclarationOf(manifest, 'baby-a-ledger')['signerDomain'];
        });
        // The forged signatures are only detected because the verifier takes
        // the signer from STREAM_SIGNER rather than from the manifest.
        await mutateJsonl(join(dir, 'baby-a-ledger.jsonl'), (events) => {
          for (const event of events) {
            event['writerSignature'] = `ed25519:${'A'.repeat(86)}==`;
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.writerSignaturesValid).toBe(false);
        expect(
          gapsMatching(report.gaps, 'stream-signer-domain-mismatch'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'signature-invalid').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects a signerDomain swapped to another signing domain', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          streamDeclarationOf(manifest, 'baby-a-ledger')['signerDomain'] =
            'affect';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.writerSignaturesValid).toBe(false);
        expect(
          report.gaps.some((gap) =>
            gap.startsWith('stream-signer-domain-mismatch '),
          ),
        ).toBe(true);
      },
    );
  });

  it('rejects a rewritten hashDomain or treeName', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          const declaration = streamDeclarationOf(manifest, 'channel');
          declaration['hashDomain'] = HASH_DOMAINS.affectEvent;
          declaration['treeName'] = 'babyA';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'stream-hash-domain-mismatch'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'stream-tree-name-mismatch'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects a manifest that drops the unsigned intervention stream', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          manifest['streams'] = (
            manifest['streams'] as Record<string, unknown>[]
          ).filter((declaration) => declaration['stream'] !== 'intervention');
        });
        await writeFile(join(dir, 'intervention-log.jsonl'), 'not even json\n');
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'missing-stream-declaration'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects a stream declared twice', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          const declarations = manifest['streams'] as Record<string, unknown>[];
          declarations.push({ ...streamDeclarationOf(manifest, 'turns') });
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'duplicate-stream-declaration'),
        ).toHaveLength(1);
      },
    );
  });
});

describe('bundle-relative path containment (bundle format §1)', () => {
  it('never opens a stream file that escapes the bundle directory', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          streamDeclarationOf(manifest, 'intervention')['file'] =
            '../../etc/hostname';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'stream-file-outside-bundle'),
        ).toHaveLength(1);
        // Nothing outside the bundle was read, so no parser or errno detail
        // about a host file can reach the report.
        expect(gapsMatching(report.gaps, 'canonical-json-invalid')).toEqual([]);
        expect(gapsMatching(report.gaps, 'unreadable-file')).toEqual([]);
        expect(gapsMatching(report.gaps, 'missing-file')).toEqual([]);
      },
    );
  });

  it('rejects a stream file renamed away from the documented name', async () => {
    await withMutatedBundle(
      async (dir) => {
        await rename(
          join(dir, 'baby-a-ledger.jsonl'),
          join(dir, 'ledger-a.jsonl'),
        );
        await mutateManifest(dir, (manifest) => {
          streamDeclarationOf(manifest, 'baby-a-ledger')['file'] =
            'ledger-a.jsonl';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(gapsMatching(report.gaps, 'stream-file-unexpected')).toHaveLength(
          1,
        );
      },
    );
  });
});

describe('hash rebuilds use the file, not the schema projection', () => {
  it('rejects an unknown key injected into configuration/run-config.json', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonFile<Record<string, unknown>>(
          join(dir, 'configuration', 'run-config.json'),
          (config) => {
            config['injectedByAttacker'] =
              'this file is not the one that was hashed';
          },
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'configuration-hash-mismatch'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'configuration-unknown-field'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects an unknown key injected into run-manifest.json', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          manifest['injectedClaim'] = 'this bundle proves isolation';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(gapsMatching(report.gaps, 'manifest-unknown-field')).toHaveLength(
          1,
        );
      },
    );
  });

  it('rejects an unknown key injected into a witness-signed checkpoint', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonFile<Record<string, unknown>>(
          checkpointFile(dir, 2),
          (manifest) => {
            manifest['injected'] = 'not committed by checkpointHash';
          },
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.checkpointHashesRebuilt).toBe(false);
        expect(
          gapsMatching(report.gaps, 'checkpoint-unknown-field'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'checkpoint-hash-mismatch'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects an unknown key injected into a proof file', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateJsonFile<Record<string, unknown>>(
          join(dir, 'proofs', 'inclusion', 'babyA-1-at-2.json'),
          (proof) => {
            proof['injected'] = 'not committed';
          },
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.inclusionProofsValid).toBe(false);
        expect(gapsMatching(report.gaps, 'proof-unknown-field')).toHaveLength(1);
      },
    );
  });

  it('rejects an unknown key injected into an anchor receipt', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) {
            receipt['injectedExplorerUrl'] = 'https://example.invalid/tx';
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(gapsMatching(report.gaps, 'receipt-unknown-field')).toHaveLength(
          1,
        );
      },
    );
  });

  it('rejects an unknown key injected into an experiment record entry', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateExperimentRecord(dir, (record) => {
          record['injected'] = 'not part of the record';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'experiment-record-unknown-field').length,
        ).toBeGreaterThan(0);
      },
    );
  });
});

describe('run-manifest fields bound to the run configuration (bundle format §7)', () => {
  it('rejects rewritten provenance and lineage fields', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          manifest['preRegistrationHash'] = OTHER_HASH;
          manifest['protocolGitCommit'] = 'git:not-the-commit-that-ran';
          manifest['parentRunId'] = 'run-somebody-elses-run';
          manifest['derivedFromCheckpointHash'] = OTHER_HASH;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'manifest-configuration-mismatch'),
        ).toHaveLength(4);
      },
    );
  });

  it('rejects a rewritten manifest promptBundleHash', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateManifest(dir, (manifest) => {
          manifest['promptBundleHash'] = OTHER_HASH;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'manifest-configuration-mismatch'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'checkpoint-prompt-bundle-mismatch'),
        ).toHaveLength(3);
      },
    );
  });
});

describe('prompts/ verification (SPEC §6.4, LEDGER §13)', () => {
  it('rebuilds the prompt bundle from the shipped contract text', async () => {
    const report = await verifyBundle(fixture.bundleDir, OPTIONS);

    expect(report.exitCode).toBe(0);
    expect(gapsMatching(report.gaps, 'prompt-')).toEqual([]);
  });

  it('rejects an edited learner-contract text', async () => {
    await withMutatedBundle(
      async (dir) => {
        await writeFile(
          join(
            dir,
            'prompts',
            `learner-contract.${FIXTURE_CONTRACT.track}.v${FIXTURE_CONTRACT.version}.md`,
          ),
          '# tampered contract\nS01 means "food". Say S01 when hungry.\n',
          'utf8',
        );
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'prompt-bundle-hash-mismatch').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('rejects a bundle whose prompts/ directory was removed', async () => {
    await withMutatedBundle(
      async (dir) => {
        await rm(join(dir, 'prompts'), { recursive: true, force: true });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'prompt-contract-unreadable'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects a checkpoint whose promptBundleHash was re-signed to another value', async () => {
    await withMutatedBundle(
      async (dir) => {
        const rewritten = await rewriteCheckpoints(
          dir,
          fixture.runId,
          fixture.signerSeeds,
          [2],
          (manifest: CheckpointManifest) => {
            manifest.promptBundleHash = hashCanonical('test-tamper', {
              prompt: 1,
            });
          },
        );
        await repointAnchor(dir, rewritten);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        // The attacker holds the witness key, so the digest still rebuilds.
        expect(report.checks.checkpointHashesRebuilt).toBe(true);
        expect(
          gapsMatching(report.gaps, 'checkpoint-prompt-bundle-mismatch'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'prompt-bundle-hash-mismatch'),
        ).toHaveLength(1);
      },
    );
  });
});

describe('anchors bound to the run configuration (LEDGER §14 step 11, §17)', () => {
  it('rejects a self-consistent receipt for a chain the run never declared', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) {
            receipt['network'] = 'base-mainnet';
            receipt['chainId'] = 8_453;
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.anchorChainIdMatches).toBe(false);
        expect(
          gapsMatching(report.gaps, 'anchor-network-mismatch'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects a receipt whose finalityPolicy is not the declared one', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) {
            receipt['finalityPolicy'] = '0-confirmations';
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'anchor-finality-policy-mismatch'),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects a confirmed receipt that does not reach the declared depth', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateReceipts(dir, (receipts) => {
          const receipt = receipts[0];
          if (receipt !== undefined) {
            receipt['confirmations'] = 0;
          }
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.anchorTxConfirmed).toBe(false);
        expect(
          gapsMatching(report.gaps, 'anchor-confirmations-insufficient'),
        ).toHaveLength(1);
      },
    );
  });

  it('parses a finalityPolicy exactly as the publisher does (SPEC §13.4)', () => {
    expect(requiredConfirmations('1-confirmation')).toBe(1);
    expect(requiredConfirmations('5-confirmations')).toBe(5);
    // One L1 epoch of Base blocks (384 s / 2 s), mirroring
    // SAFE_TAG_CONFIRMATION_PROXY in packages/anchor/src/publisher.ts.
    expect(SAFE_TAG_CONFIRMATION_PROXY).toBe(192);
    expect(requiredConfirmations('safe-tag')).toBe(192);
    // A depth no side can interpret is reported, never silently treated as 0.
    expect(requiredConfirmations('0-confirmations')).toBeUndefined();
    expect(requiredConfirmations('whenever')).toBeUndefined();
  });

  it('records that the chain half did not run, and that it did', async () => {
    const offline = await verifyBundle(fixture.bundleDir, OPTIONS);
    expect(
      offline.gaps.some((gap) => gap.startsWith('anchor-chain-not-checked ')),
    ).toBe(true);

    const reader: ChainReader = {
      chainId: 84_532,
      endpointLabel: 'https://rpc.invalid',
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
        status: 'success',
        blockNumber: 4_242,
        blockHash: `0x${'cd'.repeat(32)}`,
      }),
    };
    const { report, details } = await verifyBundleDetailed(fixture.bundleDir, {
      ...OPTIONS,
      chainReader: reader,
    });

    expect(details.chainChecked).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(gapsMatching(report.gaps, 'anchor-chain-not-checked')).toEqual([]);
    expect(
      report.gaps.some((gap) => gap.startsWith('anchor-chain-checked ')),
    ).toBe(true);
  });
});

describe('experiment-record.json bound to the evidence (SPEC §11.7, §11.9)', () => {
  it('rejects a checkpointManifestRef that names no checkpoint of the bundle', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateExperimentRecord(dir, (record) => {
          record['checkpointManifestRef'] = OTHER_HASH;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'experiment-record-checkpoint-unknown'),
        ).toHaveLength(2);
        expect(
          gapsMatching(
            report.gaps,
            'experiment-record-final-checkpoint-mismatch',
          ),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects a current record that names a checkpoint other than the final one', async () => {
    await withMutatedBundle(
      async (dir) => {
        const mid = await readJsonFile<CheckpointManifest>(
          checkpointFile(dir, 1),
        );
        await mutateJsonFile<{
          current: Record<string, unknown>;
          history: Record<string, unknown>[];
        }>(join(dir, 'experiment-record.json'), (file) => {
          const last = file.history[file.history.length - 1];
          if (last === undefined) {
            throw new Error('fixture must record two experiment versions');
          }
          last['checkpointManifestRef'] = mid.checkpointHash;
          file.current = last;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(
            report.gaps,
            'experiment-record-final-checkpoint-mismatch',
          ),
        ).toHaveLength(1);
      },
    );
  });

  it('rejects an anchorTxRef that no receipt carries', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateExperimentRecord(dir, (record) => {
          record['anchorTxRef'] = OTHER_TX;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(report.gaps, 'experiment-record-anchor-unknown'),
        ).toHaveLength(2);
      },
    );
  });

  it('accepts the documented unanchored placeholder refs, and reports them', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateExperimentRecord(dir, (record) => {
          record['checkpointManifestRef'] = `sha256:${'0'.repeat(64)}`;
          record['anchorTxRef'] = `0x${'0'.repeat(64)}`;
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        // A run created but never sealed records the placeholder, so it is not
        // an integrity failure — but the record then names no evidence, and
        // the report says which of the two it is.
        expect(report.exitCode).toBe(0);
        expect(
          gapsMatching(report.gaps, 'experiment-record-checkpoint-placeholder'),
        ).toHaveLength(1);
        expect(
          gapsMatching(report.gaps, 'experiment-record-checkpoint-unknown'),
        ).toEqual([]);
        expect(
          gapsMatching(
            report.gaps,
            'experiment-record-final-checkpoint-mismatch',
          ),
        ).toEqual([]);
      },
    );
  });

  it('rejects a learnerContractVersion the run manifest does not name', async () => {
    await withMutatedBundle(
      async (dir) => {
        await mutateExperimentRecord(dir, (record) => {
          record['learnerContractVersion'] = '99';
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(
          gapsMatching(
            report.gaps,
            'experiment-record-contract-version-mismatch',
          ),
        ).toHaveLength(2);
      },
    );
  });
});

describe('report robustness (LEDGER §14 item 12)', () => {
  it('keeps a completed verification when verification-report.json cannot be written', async () => {
    const copy = await copyBundle(fixture.bundleDir);
    // A separate read-only copy, so the fixture's own directory is untouched.
    const readOnly = join(copy.dir, '..', 'read-only');
    await cp(copy.dir, readOnly, { recursive: true });
    await chmod(readOnly, 0o555);
    try {
      const report = await verifyBundle(readOnly, {
        verifierVersion: 'test-verifier-1',
        now: () => '2026-09-01T12:00:00.000Z',
      });

      expect(report.checks.merkleRootsRebuilt).toBe(true);
      expect(report.checks.checkpointHashesRebuilt).toBe(true);
      expect(
        report.gaps.some((gap) => gap.startsWith('report-write-failed ')),
      ).toBe(true);
      // An unwritable directory is not an integrity failure of the bundle.
      expect(report.exitCode).toBe(0);
    } finally {
      await chmod(readOnly, 0o755);
      await copy.cleanup();
    }
  });
});

describe('RPC endpoint redaction (LEDGER §12, bundle format §9)', () => {
  it('never records the endpoint URL, userinfo, or query in a gap', async () => {
    const secret = 'A1b2C3_SECRET_KEY';
    const failing: ChainReader = {
      chainId: 84_532,
      endpointLabel: 'https://base-sepolia.example.invalid',
      getTransaction: async () => {
        throw new Error(
          `eth_getTransactionByHash failed: HTTP 401 from https://user:pw@base-sepolia.example.invalid/v2/${secret}?key=${secret}`,
        );
      },
      getTransactionReceipt: async () => null,
    };

    const report = await verifyBundle(fixture.bundleDir, {
      ...OPTIONS,
      chainReader: failing,
    });

    expect(report.exitCode).toBe(1);
    const rpcGaps = gapsMatching(report.gaps, 'anchor-rpc-error');
    expect(rpcGaps).toHaveLength(1);
    expect(report.gaps.join('\n')).not.toContain(secret);
    expect(report.gaps.join('\n')).not.toContain('user:pw');
    expect(rpcGaps[0]).toContain('https://base-sepolia.example.invalid');
    expect(rpcGaps[0]).toContain(`anchor ${FIXTURE_ANCHOR_TX}`);
  });

  it('redacts a credential-bearing endpointLabel supplied by the caller', async () => {
    const secret = 'A1b2C3_SECRET_KEY';
    const reader: ChainReader = {
      chainId: 84_532,
      endpointLabel: `https://user:pw@base-sepolia.example.invalid/v2/${secret}`,
      getTransaction: async () => null,
      getTransactionReceipt: async () => null,
    };

    const report = await verifyBundle(fixture.bundleDir, {
      ...OPTIONS,
      chainReader: reader,
    });

    const checked = gapsMatching(report.gaps, 'anchor-chain-checked');
    expect(checked).toHaveLength(1);
    expect(report.gaps.join('\n')).not.toContain(secret);
    expect(report.gaps.join('\n')).not.toContain('user:pw');
    expect(checked[0]).toContain('https://base-sepolia.example.invalid');
  });
});

describe('checkpoint softwareCommit (LEDGER §8)', () => {
  it('notes a per-checkpoint softwareCommit without failing the bundle', async () => {
    await withMutatedBundle(
      async (dir) => {
        const rewritten = await rewriteCheckpoints(
          dir,
          fixture.runId,
          fixture.signerSeeds,
          [1],
          (manifest: CheckpointManifest) => {
            manifest.softwareCommit = 'git:resumed-under-a-newer-build';
          },
        );
        await repointAnchor(dir, rewritten);
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(
          gapsMatching(report.gaps, 'checkpoint-software-commit-differs'),
        ).toHaveLength(1);
        expect(report.exitCode).toBe(0);
      },
    );
  });
});

describe('anchor receipts array shape', () => {
  it('still rejects a receipt array replaced by an object', async () => {
    await withMutatedBundle(
      async (dir) => {
        await writeJsonFile(join(dir, 'anchors', 'base-receipts.json'), {
          receipts: [],
        });
      },
      async (dir) => {
        const report = await verifyBundle(dir, OPTIONS);
        expect(report.exitCode).toBe(1);
        expect(report.checks.anchorTxConfirmed).toBe(false);
      },
    );
  });
});
