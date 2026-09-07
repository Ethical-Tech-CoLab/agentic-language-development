/**
 * Crash-durable record of anchor transactions that were submitted but whose
 * terminal state is not yet in the evidence store.
 *
 * `anchor_receipts` is append-only with one row per `(chainId,
 * transactionHash)`, so the publisher inserts a row exactly once, at a
 * terminal decision — `confirmed` or `failed` only; giving up on a
 * confirmation poll is *not* terminal and writes nothing. The window between
 * "chain accepted the transaction" and "row inserted" is the only place a
 * crash could lose a transaction hash and orphan a paid transaction, so the
 * hash is written to this sidecar file first, in canonical JSON, and removed
 * only after the row exists. That makes this file the resume handle for a
 * given-up poll (SPEC §7.2 `sealing-blocked` -> retry succeeds -> `sealing`).
 *
 * The file is a plain operational sidecar, not evidence: it is never part of
 * an exported bundle and contains only public chain routing metadata (never
 * a key, never run content).
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
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

/** Mode the sidecar and its temporary file are created and kept at. */
export const PENDING_FILE_MODE = 0o600;

/** Best-effort cleanup; a missing temp file is not itself a failure. */
function discard(descriptor: number | null, temporaryPath: string): void {
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor was already closed by the successful path.
    }
  }
  try {
    unlinkSync(temporaryPath);
  } catch {
    // The temp file was never created, or the rename already consumed it.
  }
}

/**
 * Refuse a sidecar path that is a symlink.
 *
 * The sidecar is the only crash-durable record of a paid but unrecorded anchor
 * transaction (LEDGER §10), so it must be a regular file this process owns:
 * a planted symlink would redirect both the read (attacker-chosen content) and
 * the durability guarantee this module exists to provide.
 */
function assertRegularFile(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw new PendingFileInvalidError(path, { cause });
  }
  if (!stats.isFile()) {
    throw new PendingFileInvalidError(path, {
      cause: new Error('sidecar path is not a regular file (symlink refused)'),
    });
  }
}

/**
 * Replace the sidecar atomically.
 *
 * The temporary file gets a unique name and is created with `O_EXCL` at mode
 * 0600, so a pre-existing file (whose looser permissions would otherwise be
 * inherited), a planted symlink, and a second publisher sharing the same
 * sidecar path can none of them influence this write. The descriptor is
 * `fsync`ed before the rename so a crash cannot leave a renamed-but-empty
 * sidecar and orphan a paid transaction.
 */
export function writePendingSubmissions(
  path: string,
  submissions: readonly PendingAnchorSubmission[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  assertRegularFile(path);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', PENDING_FILE_MODE);
    writeSync(
      descriptor,
      `${canonicalJson({ version: 1, submissions })}\n`,
      null,
      'utf8',
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    // `mode` is masked by the process umask on creation; enforce it explicitly.
    if (process.platform !== 'win32') {
      chmodSync(temporaryPath, PENDING_FILE_MODE);
    }
    renameSync(temporaryPath, path);
  } catch (cause) {
    discard(descriptor, temporaryPath);
    throw new PendingFileInvalidError(path, { cause });
  }
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
