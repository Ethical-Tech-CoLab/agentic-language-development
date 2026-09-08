/**
 * Weight hashing for the `frozen-llm` track (BACKLOG ALD-044 criterion 1:
 * "records the exact model and weight hashes").
 *
 * The hash is a **plain** SHA-256 over the weights file's bytes, encoded
 * `sha256:<64 lowercase hex>` — not a domain-separated ALD hash. That is
 * deliberate: a third party auditing a sealed bundle must be able to run
 * `sha256sum model.gguf`, prefix the digest with `sha256:`, and get the value
 * the run recorded, without reimplementing this repository's hash
 * construction. Everything ALD itself hashes stays domain-separated; a file
 * digest published for external reproduction does not.
 *
 * The file is streamed, never buffered: a 3B-8B GGUF is measured in gigabytes
 * and this runs on the operator's machine at construction time, once per run.
 * Nothing here downloads anything (SPEC §6.7: "no network access").
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { WeightsFileUnreadableError } from './llm-errors.js';

/** Bytes read per chunk while streaming the weights file. */
export const WEIGHTS_HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface WeightsFileDigest {
  /** `sha256:<64 hex>` over the file's bytes. */
  weightsHash: string;
  sizeBytes: number;
}

/**
 * Stream-SHA-256 the file at `path`.
 *
 * An unreadable, missing, non-regular, or empty file raises
 * `WeightsFileUnreadableError` rather than producing the digest of nothing:
 * recording the SHA-256 of an empty file as a model's weight hash would be a
 * false provenance claim.
 */
export async function hashWeightsFile(
  path: string,
): Promise<WeightsFileDigest> {
  let sizeBytes: number;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      throw new WeightsFileUnreadableError('path is not a regular file');
    }
    sizeBytes = stats.size;
  } catch (error) {
    if (error instanceof WeightsFileUnreadableError) {
      throw error;
    }
    throw new WeightsFileUnreadableError(
      `stat failed (${errorCodeOf(error)})`,
    );
  }
  if (sizeBytes === 0) {
    throw new WeightsFileUnreadableError('weights file is empty');
  }

  const hash = createHash('sha256');
  const stream = createReadStream(path, {
    highWaterMark: WEIGHTS_HASH_CHUNK_BYTES,
  });
  try {
    for await (const chunk of stream) {
      hash.update(chunk as Uint8Array);
    }
  } catch (error) {
    throw new WeightsFileUnreadableError(`read failed (${errorCodeOf(error)})`);
  }

  return { weightsHash: `sha256:${hash.digest('hex')}`, sizeBytes };
}

/**
 * The error's `code` (`ENOENT`, `EACCES`, …) or its constructor name. Never
 * the message: a filesystem message can contain an operator's directory
 * layout, and SPEC §10.1 keeps human-readable exception text out of anything a
 * Baby context can observe.
 */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return error instanceof Error ? error.name : 'unknown';
}
