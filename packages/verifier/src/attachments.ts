/** Independent verification of `analysis/` bundle attachments (bundle §10). */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  canonicalJson,
  encodeHash,
  parseCanonicalJson,
  sha256Bytes,
} from '@ald/hashing';
import {
  BundleAttachmentIndexSchema,
  type RunManifest,
} from '@ald/types';

import {
  bundlePath,
  containedBundlePath,
  formatIssues,
  readCanonicalJsonFile,
  readTextFile,
  stripTrailingNewline,
  unknownFieldDetail,
} from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import type { LoadedCheckpoint } from './checkpoints.js';
import type { LoadedStreams } from './streams.js';
import { isRecord, readRecord, readString } from './values.js';

export interface AttachmentVerification {
  hashes: Set<string>;
  count: number;
}

async function listAnalysisFiles(
  root: string,
  relative = '',
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listAnalysisFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function attachmentEventMatches(
  event: Record<string, unknown>,
  descriptor: {
    path: string;
    sha256: string;
    kind: string;
    analysisVersion: string;
  },
): boolean {
  const details = readRecord(event, 'details');
  return (
    event.eventType === 'analysis-attached' &&
    details !== undefined &&
    readString(details, 'path') === descriptor.path &&
    readString(details, 'sha256') === descriptor.sha256 &&
    readString(details, 'kind') === descriptor.kind &&
    readString(details, 'analysisVersion') === descriptor.analysisVersion
  );
}

export async function verifyAttachments(
  bundleDir: string,
  manifest: RunManifest,
  streams: LoadedStreams,
  checkpoints: readonly LoadedCheckpoint[],
  anchoredThroughCheckpoint: number | null,
  accumulator: VerificationAccumulator,
): Promise<AttachmentVerification> {
  const indexPath = bundlePath(bundleDir, 'analysis', 'index.json');
  const raw = await readCanonicalJsonFile(indexPath);
  if (!raw.ok) {
    if (raw.code === 'canonical-json-invalid') {
      accumulator.fail(
        'canonicalJsonValid',
        raw.code,
        `analysis/index.json: ${raw.detail}`,
      );
    } else {
      accumulator.failStructural(raw.code, `analysis/index.json: ${raw.detail}`);
    }
    return { hashes: new Set(), count: 0 };
  }

  const parsed = BundleAttachmentIndexSchema.safeParse(raw.value);
  if (!parsed.success) {
    accumulator.failStructural(
      'analysis-index-invalid',
      `analysis/index.json: ${formatIssues(parsed.error.issues)}`,
    );
    return { hashes: new Set(), count: 0 };
  }
  const unknown = unknownFieldDetail(raw.value, parsed.data);
  if (unknown !== undefined) {
    accumulator.failStructural('analysis-index-unknown-field', unknown);
  }
  if (parsed.data.runId !== manifest.runId) {
    accumulator.failStructural(
      'analysis-index-run-mismatch',
      `analysis/index.json runId ${parsed.data.runId} does not match ${manifest.runId}`,
    );
  }

  const listedPaths = new Set<string>();
  const hashes = new Set<string>();
  const anchored =
    anchoredThroughCheckpoint === null
      ? undefined
      : checkpoints.find(
          (checkpoint) => checkpoint.sequence === anchoredThroughCheckpoint,
        );

  for (const descriptor of parsed.data.attachments) {
    if (listedPaths.has(descriptor.path)) {
      accumulator.failStructural(
        'analysis-attachment-duplicate',
        `${descriptor.path} is listed more than once`,
      );
      continue;
    }
    listedPaths.add(descriptor.path);
    hashes.add(descriptor.sha256);

    const segments = descriptor.path.split('/');
    const contained = containedBundlePath(bundleDir, ...segments);
    if (!contained.ok) {
      accumulator.failStructural(
        'analysis-attachment-outside-bundle',
        `${descriptor.path}: ${contained.detail}`,
      );
      continue;
    }
    const text = await readTextFile(contained.path);
    if (!text.ok) {
      accumulator.failStructural(
        text.code,
        `${descriptor.path}: ${text.detail}`,
      );
      continue;
    }
    const actualHash = encodeHash(sha256Bytes(Buffer.from(text.value, 'utf8')));
    if (actualHash !== descriptor.sha256) {
      accumulator.failStructural(
        'analysis-attachment-hash-mismatch',
        `${descriptor.path} hashes to ${actualHash}, index declares ${descriptor.sha256}`,
      );
    }
    try {
      const value = parseCanonicalJson<unknown>(stripTrailingNewline(text.value));
      if (canonicalJson(value) !== stripTrailingNewline(text.value)) {
        throw new Error('content is not canonical');
      }
    } catch (error) {
      accumulator.fail(
        'canonicalJsonValid',
        'analysis-attachment-canonical-json-invalid',
        `${descriptor.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const binding = descriptor.boundBy;
    if (binding === undefined) {
      accumulator.gap(
        'analysis-attachment-unbound',
        `${descriptor.path} is tamper-evident but not bound to run evidence`,
      );
      continue;
    }
    const stream = streams.get(binding.stream);
    const eventIndex = stream?.events.findIndex(
      (event) => isRecord(event) && event.entryHash === binding.entryHash,
    );
    if (
      stream === undefined ||
      eventIndex === undefined ||
      eventIndex < 0 ||
      !attachmentEventMatches(stream.events[eventIndex] ?? {}, descriptor)
    ) {
      accumulator.failStructural(
        'analysis-attachment-binding-invalid',
        `${descriptor.path} is not matched by ${binding.stream} entry ${binding.entryHash}`,
      );
      continue;
    }
    const treeName = stream.declaration.treeName;
    const committedSize =
      treeName === undefined ? 0 : (anchored?.trees.get(treeName)?.treeSize ?? 0);
    if (eventIndex + 1 > committedSize) {
      accumulator.gap(
        'analysis-attachment-unanchored',
        `${descriptor.path} binding is outside the confirmed anchored prefix`,
      );
    }
  }

  const files = await listAnalysisFiles(bundlePath(bundleDir, 'analysis'));
  for (const file of files) {
    const path = `analysis/${file}`;
    if (path !== 'analysis/index.json' && !listedPaths.has(path)) {
      accumulator.failStructural(
        'analysis-attachment-unlisted',
        `${path} exists but is absent from analysis/index.json`,
      );
    }
  }

  return { hashes, count: listedPaths.size };
}
