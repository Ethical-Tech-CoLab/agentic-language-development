/**
 * Guards the curated public API and the two invariants the whole package
 * exists to protect: the on-chain payload encoding (LEDGER §12) and the
 * canonical, crash-durable pending-submission sidecar.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, decodeHash } from '@ald/hashing';
import { afterAll, describe, expect, it } from 'vitest';

import * as anchor from '../src/index.js';
import * as testing from '../src/testing.js';
import {
  ANCHOR_CHAIN_IDS,
  ANCHOR_INPUT_DATA_LENGTH,
  PendingFileInvalidError,
  addPendingSubmission,
  anchorInputData,
  findPendingSubmission,
  readPendingSubmissions,
  removePendingSubmission,
} from '../src/index.js';
import type { PendingAnchorSubmission } from '../src/index.js';
import { cleanupTemporaryDirectories, temporaryDirectory } from './support.js';

const EXPECTED_EXPORTS = [
  'ANCHOR_CHAIN_IDS',
  'ANCHOR_INPUT_DATA_LENGTH',
  'ANCHOR_KEY_FILE_MODE',
  'AnchorError',
  'AnchorKeyFileError',
  'AnchorNetworkMismatchError',
  'AnchorPayloadMismatchError',
  'AnchorSubmissionFailedError',
  'BaseAnchorPublisher',
  'DEFAULT_FAKE_FROM_ADDRESS',
  'DEFAULT_INITIAL_BACKOFF_MS',
  'DEFAULT_MAX_BACKOFF_MS',
  'DEFAULT_RETRY_ATTEMPTS',
  'FORBIDDEN_KEY_FILE_MODE_BITS',
  'FakeChainTransport',
  'InvalidFinalityPolicyError',
  'MAINNET_ANCHORING_ENV_VAR',
  'MainnetAnchoringDisabledError',
  'PendingAnchorFileSchema',
  'PendingAnchorSubmissionSchema',
  'PendingFileInvalidError',
  'SAFE_TAG_CONFIRMATION_PROXY',
  'TransientChainError',
  'UnknownAnchorCheckpointError',
  'UnknownAnchorRunError',
  'ViemChainTransport',
  'addPendingSubmission',
  'anchorInputData',
  'expectedChainId',
  'findPendingSubmission',
  'generateAnchorKey',
  'isAnchorError',
  'loadAnchorKeyFile',
  'readPendingSubmissions',
  'removePendingSubmission',
  'requiredConfirmations',
  'verifyAnchorReceipt',
  'writeAnchorKeyFile',
  'writePendingSubmissions',
];

afterAll(async () => {
  await cleanupTemporaryDirectories();
});

describe('public API surface', () => {
  it('exports exactly the curated runtime symbols', () => {
    expect(Object.keys(anchor).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it('keeps the test double in its own entry point', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'DEFAULT_FAKE_FROM_ADDRESS',
      'FakeChainTransport',
    ]);
  });

  it('pins the Base chain ids', () => {
    expect(ANCHOR_CHAIN_IDS).toEqual({
      'base-sepolia': 84532,
      'base-mainnet': 8453,
    });
  });
});

describe('anchorInputData (LEDGER §12)', () => {
  it('is the raw digest and nothing else', () => {
    const hash = `sha256:${'ab'.repeat(32)}`;
    const encoded = anchorInputData(hash);

    expect(encoded).toBe(`0x${'ab'.repeat(32)}`);
    expect(encoded).toHaveLength(ANCHOR_INPUT_DATA_LENGTH);
    expect(Buffer.from(encoded.slice(2), 'hex')).toEqual(decodeHash(hash));
  });

  it('refuses anything that is not a sha256 digest', () => {
    expect(() => anchorInputData('0xdeadbeef')).toThrow(TypeError);
    expect(() => anchorInputData(`sha256:${'zz'.repeat(32)}`)).toThrow(
      TypeError,
    );
  });
});

describe('pending submission sidecar', () => {
  const submission: PendingAnchorSubmission = {
    version: 1,
    runId: 'run-anchor-001',
    checkpointSequence: 0,
    checkpointHash: `sha256:${'cd'.repeat(32)}`,
    network: 'base-sepolia',
    chainId: 84532,
    transactionHash: `0x${'11'.repeat(32)}`,
    from: `0x${'22'.repeat(20)}`,
    to: `0x${'33'.repeat(20)}`,
    inputData: `0x${'cd'.repeat(32)}`,
    finalityPolicy: '1-confirmation',
    rpcEndpointLabel: 'fake-base-sepolia',
    submittedAt: '2026-01-01T00:00:00.000Z',
  };

  it('writes canonical JSON, dedupes, finds, and removes', async () => {
    const path = join(await temporaryDirectory(), 'pending.json');

    expect(readPendingSubmissions(path)).toEqual([]);
    addPendingSubmission(path, submission);
    addPendingSubmission(path, submission);

    expect(readPendingSubmissions(path)).toEqual([submission]);
    expect(readFileSync(path, 'utf8')).toBe(
      `${canonicalJson({ version: 1, submissions: [submission] })}\n`,
    );
    expect(
      findPendingSubmission(
        readPendingSubmissions(path),
        84532,
        submission.checkpointHash,
      ),
    ).toEqual(submission);

    removePendingSubmission(path, 84532, submission.transactionHash);
    expect(readPendingSubmissions(path)).toEqual([]);
  });

  it('refuses a corrupted sidecar rather than silently losing a tx hash', async () => {
    const path = join(await temporaryDirectory(), 'pending.json');
    writeFileSync(path, '{"version":1}', 'utf8');

    expect(() => readPendingSubmissions(path)).toThrow(PendingFileInvalidError);
  });
});
