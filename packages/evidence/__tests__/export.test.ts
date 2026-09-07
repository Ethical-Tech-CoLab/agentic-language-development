import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { canonicalJson, domainHash, hashCanonical } from '@ald/hashing';
import {
  CLAIM_BOUNDARY_STATEMENTS,
  HASH_DOMAINS,
  RunManifestSchema,
  type AnchorReceipt,
  type CheckpointManifest,
  type ExperimentRecord,
} from '@ald/types';
import { afterEach, describe, expect, it } from 'vitest';

import { InvalidRequestError } from '../src/errors.js';
import { exportRunBundle, type LearnerContractText } from '../src/export.js';
import {
  cleanupTemporaryDirectories,
  createWriter,
  hash,
  intentionDraft,
  interpretationDraft,
  proposal,
  runConfig,
  temporaryDirectory,
  type TestWriter,
} from './fixtures/support.js';

afterEach(cleanupTemporaryDirectories);

const RUN_ID = 'run-test-001';

const learnerContracts: LearnerContractText[] = [
  { track: 'no-learning', version: '1.0.0', text: '# no-learning contract\n' },
  { track: 'frozen-llm', version: '2.1.0', text: '# frozen-llm contract\n' },
];

const exportOptions = { softwareCommit: 'software-commit-1', learnerContracts };

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === '' ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

async function populate(): Promise<TestWriter> {
  const config = runConfig({
    babyB: {
      track: 'frozen-llm',
      modelRef: 'frozen-model',
      trainingIsolation: 'independent',
    },
  });
  const context = await createWriter({ config });

  const turn = await context.writer.commitTurn({
    runId: RUN_ID,
    turn: 1,
    sender: 'baby-a',
    recipient: 'baby-b',
    carrier: 'fixed-token',
    communicationCondition: 'normal',
    proposal,
    intentionDraft: intentionDraft(),
    deliveredArtifact: proposal.publicArtifact,
  });
  await context.writer.appendLedgerEvent({
    runId: RUN_ID,
    babyId: 'B',
    turn: 1,
    draft: interpretationDraft(),
    channelEventHash: turn.channelEvent.entryHash,
  });
  await context.writer.appendTurnRecord({
    runId: RUN_ID,
    turn: 1,
    phase: 'running',
    roles: { sender: 'baby-a', receiver: 'baby-b' },
    communicationCondition: 'normal',
    scenarioRef: 'scenario-01',
    scenarioStateHash: hash('1'),
    observationHashes: { babyA: hash('2'), babyB: hash('3') },
    babyProposalHash: turn.channelEvent.babyProposalHash ?? null,
    deliveredArtifactHash: turn.channelEvent.publicArtifactHash,
    channelEventHash: turn.channelEvent.entryHash,
    actionHash: hash('7'),
    outcomeHash: hash('8'),
    outcome: { success: true, reward: 1 },
  });
  await context.writer.appendInterventionEvent({
    runId: RUN_ID,
    eventType: 'human-view',
    actorId: 'researcher-1',
    reasonCode: 'dashboard-read',
  });

  const tree = { treeSize: 1, merkleRoot: hash('1'), lastEntryHash: hash('2') };
  const unsigned = {
    version: 1 as const,
    runIdHash: domainHash(HASH_DOMAINS.runId, RUN_ID),
    checkpointSequence: 0,
    previousCheckpointHash: `sha256:${'0'.repeat(64)}`,
    babyA: tree,
    babyB: tree,
    channel: tree,
    auxiliaryTrees: {},
    runConfigurationHash: hash('3'),
    promptBundleHash: hash('4'),
    softwareCommit: 'software-commit-1',
    createdAt: new Date(0).toISOString(),
    witnessKeyId: 'nursery-witness-v1',
    reason: 'run-initialized' as const,
  };
  const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
  const manifest: CheckpointManifest = {
    ...unsigned,
    checkpointHash,
    witnessSignature: await context.signers.signer('witness').sign(checkpointHash),
  };
  context.writer.insertCheckpointManifest(manifest);

  const receipt: AnchorReceipt = {
    version: 1,
    runId: RUN_ID,
    checkpointSequence: 0,
    checkpointHash,
    network: 'base-sepolia',
    chainId: 84532,
    transactionHash: `0x${'a'.repeat(64)}`,
    from: `0x${'b'.repeat(40)}`,
    to: `0x${'c'.repeat(40)}`,
    inputData: `0x${'d'.repeat(64)}`,
    blockNumber: 7,
    blockHash: `0x${'e'.repeat(64)}`,
    status: 'confirmed',
    confirmations: 1,
    finalityPolicy: '1-confirmation',
    rpcEndpointLabel: 'test-rpc',
    recordedAt: new Date(0).toISOString(),
  };
  context.writer.insertAnchorReceipt(receipt);

  const record: ExperimentRecord = {
    version: 1,
    recordVersion: 1,
    runId: RUN_ID,
    experimentId: 'E00',
    deploymentMode: 'prototype',
    learnerContractVersion: '1.0.0',
    runConfigRef: hash('a'),
    protocolGitCommit: 'e2b1c0d4f5a6978877665544332211aabbccddee',
    preRegistrationHash: hash('c'),
    disposition: 'valid',
    checkpointManifestRef: checkpointHash,
    anchorTxRef: receipt.transactionHash,
    verifierReportRef: 'verification-report.json',
    claimBoundaryStatement: CLAIM_BOUNDARY_STATEMENTS.prototype,
    deviations: [],
  };
  context.writer.appendExperimentRecord(record);
  context.writer.appendExperimentRecord({ ...record, recordVersion: 2 });

  return context;
}

describe('exportRunBundle', () => {
  it('writes the documented layout and a schema-valid manifest', async () => {
    const context = await populate();
    const directory = await temporaryDirectory();

    const manifest = await exportRunBundle(
      context.writer,
      RUN_ID,
      directory,
      exportOptions,
    );

    expect(RunManifestSchema.parse(manifest)).toEqual(manifest);
    expect(await listFiles(directory)).toEqual([
      'anchors/base-receipts.json',
      'baby-a-ledger.jsonl',
      'baby-b-ledger.jsonl',
      'channel-transcript.jsonl',
      'checkpoints/000000.json',
      'configuration/run-config.json',
      'experiment-record.json',
      'intervention-log.jsonl',
      'prompts/learner-contract.frozen-llm.v2.1.0.md',
      'prompts/learner-contract.no-learning.v1.0.0.md',
      'run-manifest.json',
      'turn-records.jsonl',
    ]);
    expect((await stat(join(directory, 'proofs', 'inclusion'))).isDirectory()).toBe(
      true,
    );
    expect((await stat(join(directory, 'proofs', 'consistency'))).isDirectory()).toBe(
      true,
    );

    const written = JSON.parse(
      await readFile(join(directory, 'run-manifest.json'), 'utf8'),
    );
    expect(RunManifestSchema.parse(written)).toEqual(manifest);
    expect(manifest.claimBoundaryStatement).toBe(CLAIM_BOUNDARY_STATEMENTS.prototype);
    expect(manifest.runIdHash).toBe(domainHash(HASH_DOMAINS.runId, RUN_ID));
    expect(manifest.configurationHash).toBe(
      context.writer.readRunMetadata(RUN_ID)?.configurationHash,
    );
    expect(manifest.softwareCommit).toBe('software-commit-1');
    expect(manifest.learnerContractVersions).toEqual({
      babyA: '1.0.0',
      babyB: '2.1.0',
    });
    expect(manifest.signers).toHaveLength(6);
    expect(manifest.streams).toEqual([
      {
        stream: 'baby-a-ledger',
        file: 'baby-a-ledger.jsonl',
        hashDomain: 'dtsf-baby-ledger-entry-v1',
        signerDomain: 'baby-a-ledger',
        treeName: 'babyA',
      },
      {
        stream: 'baby-b-ledger',
        file: 'baby-b-ledger.jsonl',
        hashDomain: 'dtsf-baby-ledger-entry-v1',
        signerDomain: 'baby-b-ledger',
        treeName: 'babyB',
      },
      {
        stream: 'channel',
        file: 'channel-transcript.jsonl',
        hashDomain: 'dtsf-channel-event-v1',
        signerDomain: 'channel',
        treeName: 'channel',
      },
      {
        stream: 'turns',
        file: 'turn-records.jsonl',
        hashDomain: 'dtsf-turn-record-v1',
        signerDomain: 'witness',
        treeName: 'turns',
      },
      {
        stream: 'intervention',
        file: 'intervention-log.jsonl',
        hashDomain: 'dtsf-intervention-event-v1',
      },
    ]);

    context.close();
  });

  it('writes JSONL lines that match the stored canonical events', async () => {
    const context = await populate();
    const directory = await temporaryDirectory();
    await exportRunBundle(context.writer, RUN_ID, directory, exportOptions);

    for (const [stream, file] of [
      ['baby-a-ledger', 'baby-a-ledger.jsonl'],
      ['baby-b-ledger', 'baby-b-ledger.jsonl'],
      ['channel', 'channel-transcript.jsonl'],
      ['turns', 'turn-records.jsonl'],
      ['intervention', 'intervention-log.jsonl'],
    ] as const) {
      const content = await readFile(join(directory, file), 'utf8');
      const lines = content === '' ? [] : content.slice(0, -1).split('\n');
      const events = context.writer.readEvents(RUN_ID, stream);
      expect(lines).toEqual(events.map((event) => event.canonicalJson));
      for (const [index, line] of lines.entries()) {
        const parsed: unknown = JSON.parse(line);
        expect(canonicalJson(parsed)).toBe(line);
        expect((parsed as { sequence: number }).sequence).toBe(index + 1);
      }
      expect(content.endsWith('\n') || content === '').toBe(true);
    }

    const config = JSON.parse(
      await readFile(join(directory, 'configuration', 'run-config.json'), 'utf8'),
    );
    expect(canonicalJson(config)).toBe(
      context.writer.readRunMetadata(RUN_ID)?.configurationJson,
    );

    const experiment = JSON.parse(
      await readFile(join(directory, 'experiment-record.json'), 'utf8'),
    );
    expect(experiment.history).toHaveLength(2);
    expect(experiment.current.recordVersion).toBe(2);

    const anchors = JSON.parse(
      await readFile(join(directory, 'anchors', 'base-receipts.json'), 'utf8'),
    );
    expect(anchors).toEqual(context.writer.readAnchorReceipts(RUN_ID));

    expect(
      await readFile(
        join(directory, 'prompts', 'learner-contract.frozen-llm.v2.1.0.md'),
        'utf8',
      ),
    ).toBe('# frozen-llm contract\n');

    context.close();
  });

  it('produces byte-identical bundles for two exports of the same run', async () => {
    const context = await populate();
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();

    await exportRunBundle(context.writer, RUN_ID, first, exportOptions);
    await exportRunBundle(context.writer, RUN_ID, second, exportOptions);

    const files = await listFiles(first);
    expect(files).toEqual(await listFiles(second));
    for (const file of files) {
      const left = await readFile(join(first, file));
      const right = await readFile(join(second, file));
      expect(left.equals(right)).toBe(true);
    }
    expect(files).not.toContain('verification-report.json');
    expect(relative(first, join(first, 'run-manifest.json'))).toBe(
      'run-manifest.json',
    );

    context.close();
  });

  it('omits the affect and audit files until those streams have events', async () => {
    const context = await populate();
    const withoutAuxiliary = await temporaryDirectory();
    await exportRunBundle(context.writer, RUN_ID, withoutAuxiliary, exportOptions);
    expect(await listFiles(withoutAuxiliary)).not.toContain('affect-transcript.jsonl');
    expect(await listFiles(withoutAuxiliary)).not.toContain('audit-ledger.jsonl');

    await context.writer.appendAffectEvent({
      runId: RUN_ID,
      turn: 1,
      windowId: 'window-01',
      sender: 'baby-a',
      displayId: 'A1',
      affectMode: 'declared',
      deliveredAt: new Date(0).toISOString(),
    });
    await context.writer.appendAuditLedgerEntry({
      runId: RUN_ID,
      babyId: 'A',
      sourceEntryHash: hash('1'),
      interpreterVersion: 'interpreter-v1',
      content: { term: 'S01', hypothesis: 'target', evidence: 'turn 1' },
    });

    const withAuxiliary = await temporaryDirectory();
    const manifest = await exportRunBundle(
      context.writer,
      RUN_ID,
      withAuxiliary,
      exportOptions,
    );
    const files = await listFiles(withAuxiliary);
    expect(files).toContain('affect-transcript.jsonl');
    expect(files).toContain('audit-ledger.jsonl');
    expect(manifest.streams.map((declaration) => declaration.stream)).toEqual([
      'baby-a-ledger',
      'baby-b-ledger',
      'channel',
      'affect',
      'audit',
      'turns',
      'intervention',
    ]);
    expect(
      manifest.streams.find((declaration) => declaration.stream === 'audit'),
    ).toEqual({
      stream: 'audit',
      file: 'audit-ledger.jsonl',
      hashDomain: 'dtsf-audit-ledger-entry-v1',
      signerDomain: 'audit',
      treeName: 'audit',
    });

    context.close();
  });

  it('refuses a non-empty directory unless overwrite is set', async () => {
    const context = await populate();
    const directory = await temporaryDirectory();
    await exportRunBundle(context.writer, RUN_ID, directory, exportOptions);

    await expect(
      exportRunBundle(context.writer, RUN_ID, directory, exportOptions),
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      exportRunBundle(context.writer, RUN_ID, directory, {
        ...exportOptions,
        overwrite: true,
      }),
    ).resolves.toBeDefined();

    context.close();
  });

  it('requires a contract text for every configured track', async () => {
    const context = await populate();
    const directory = await temporaryDirectory();

    await expect(
      exportRunBundle(context.writer, RUN_ID, directory, {
        softwareCommit: 'software-commit-1',
        learnerContracts: [learnerContracts[0]!],
      }),
    ).rejects.toThrow(InvalidRequestError);

    context.close();
  });
});
