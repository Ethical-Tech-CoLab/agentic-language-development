/**
 * Crash-durable record of anchor transactions that were submitted but whose
 * terminal state is not yet in the evidence store.
 *
 * `anchor_receipts` is append-only with one row per `(chainId,
 * transactionHash)`, so the publisher inserts a row exactly once, at a
 * terminal decision (confirmed / failed / gave-up). The window between
 * "chain accepted the transaction" and "row inserted" is the only place a
 * crash could lose a transaction hash and orphan a paid transaction, so the
 * hash is written to this sidecar file first, in canonical JSON, and removed
 * only after the row exists.
 *
 * The file is a plain operational sidecar, not evidence: it is never part of
 * an exported bundle and contains only public chain routing metadata (never
 * a key, never run content).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { canonicalJson } from '@ald/hashing';
import { z } from 'zod';

import { PendingFileInvalidError } from './errors.js';

export const PendingAnchorSubmissionSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  checkpointSequence: z.number().int().nonnegative(),
  checkpointHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  network: z.enum(['base-sepolia', 'base-mainnet']),
  chainId: z.number().int().positive(),
  transactionHash: z.string().regex(/^0x[a-f0-9]{64}$/iu),
  from: z.string().regex(/^0x[a-f0-9]{40}$/iu),
  to: z.string().regex(/^0x[a-f0-9]{40}$/iu),
  inputData: z.string().regex(/^0x[a-f0-9]*$/iu),
  finalityPolicy: z.string().min(1),
  rpcEndpointLabel: z.string().min(1),
  submittedAt: z.string().min(1),
});

export const PendingAnchorFileSchema = z.object({
  version: z.literal(1),
  submissions: z.array(PendingAnchorSubmissionSchema),
});

export type PendingAnchorSubmission = z.infer<
  typeof PendingAnchorSubmissionSchema
>;

function samePending(
  left: PendingAnchorSubmission,
  chainId: number,
  transactionHash: string,
): boolean {
  return (
    left.chainId === chainId &&
    left.transactionHash.toLowerCase() === transactionHash.toLowerCase()
  );
}

/** Read the sidecar; a missing file is an empty list, not an error. */
export function readPendingSubmissions(
  path: string,
): PendingAnchorSubmission[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new PendingFileInvalidError(path, { cause });
  }

  try {
    return PendingAnchorFileSchema.parse(JSON.parse(text)).submissions;
  } catch (cause) {
    throw new PendingFileInvalidError(path, { cause });
  }
}

/** Replace the sidecar atomically (write sibling temp file, then rename). */
export function writePendingSubmissions(
  path: string,
  submissions: readonly PendingAnchorSubmission[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(
    temporaryPath,
    `${canonicalJson({ version: 1, submissions })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  renameSync(temporaryPath, path);
}

/** Idempotent by `(chainId, transactionHash)`. */
export function addPendingSubmission(
  path: string,
  submission: PendingAnchorSubmission,
): void {
  const existing = readPendingSubmissions(path).filter(
    (entry) =>
      !samePending(entry, submission.chainId, submission.transactionHash),
  );
  writePendingSubmissions(path, [...existing, submission]);
}

export function removePendingSubmission(
  path: string,
  chainId: number,
  transactionHash: string,
): void {
  const remaining = readPendingSubmissions(path).filter(
    (entry) => !samePending(entry, chainId, transactionHash),
  );
  writePendingSubmissions(path, remaining);
}

export function findPendingSubmission(
  submissions: readonly PendingAnchorSubmission[],
  chainId: number,
  checkpointHash: string,
): PendingAnchorSubmission | undefined {
  return submissions.find(
    (entry) =>
      entry.chainId === chainId && entry.checkpointHash === checkpointHash,
  );
}
