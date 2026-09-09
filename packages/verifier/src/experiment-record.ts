/**
 * `experiment-record.json` verification (SPECIFICATION.md §11.9, §13.2,
 * §15.1): the append-only versioned record of what the run claims, bound to
 * the run configuration and carrying the verbatim claim-boundary sentence of
 * SPEC §5.1/§5.2.
 *
 * SPEC §11.7 makes every run manifest reachable from an `ExperimentRecord`
 * via `checkpointManifestRef` ("final checkpoint hash") and §11.9 defines
 * `anchorTxRef` as the Base transaction hash, so both are bound to artifacts
 * the verifier has already loaded. The orchestrator legitimately records
 * placeholders — {@link GENESIS_HASH} for a pre-registration or unsealed run
 * and the all-zero {@link UNANCHORED_TX_REF} when no anchor exists — so the
 * rule accepts those and nothing else.
 *
 * The file is optional in a bundle (the exporter writes it only when the run
 * has at least one record), so absence is not a failure; a present file that
 * does not satisfy the rules is.
 */
import {
  CLAIM_BOUNDARY_STATEMENTS,
  ExperimentRecordFileSchema,
  ExperimentRecordSchema,
  GENESIS_HASH,
  type AnchorReceipt,
  type RunConfig,
  type RunManifest,
} from '@ald/types';
import { canonicalJson } from '@ald/hashing';

import {
  bundlePath,
  formatIssues,
  readCanonicalJsonFile,
  unknownFieldDetail,
} from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import type { LoadedCheckpoint } from './checkpoints.js';
import { normalizeHash } from './values.js';

/**
 * All-zero transaction reference an unanchored run records
 * (`UNANCHORED_TX_REF`, packages/orchestrator/src/nursery-runtime.ts).
 */
export const UNANCHORED_TX_REF = `0x${'0'.repeat(64)}`;

export interface ExperimentRecordVerification {
  present: boolean;
  historyLength: number;
}

export interface ExperimentRecordBindings {
  checkpoints: readonly LoadedCheckpoint[];
  receipts: readonly AnchorReceipt[];
  /** Hash-bound run configuration, when the bundle carries a usable one. */
  config?: RunConfig | undefined;
  attachmentHashes: ReadonlySet<string>;
}

function sameTx(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Forms of `ExperimentRecord.learnerContractVersion` (SPEC §11.9) consistent
 * with `RunManifest.learnerContractVersions`.
 *
 * The manifest records a bare version per Baby
 * (packages/evidence/src/export.ts), while the runtime writes the composite
 * `<track>.v<version>` (packages/orchestrator/src/nursery-runtime.ts), so both
 * encodings of the same contract are accepted and nothing else is.
 */
export function acceptedLearnerContractVersions(
  manifest: RunManifest,
  config: RunConfig | undefined,
): string[] {
  const babyA = manifest.learnerContractVersions.babyA;
  const babyB = manifest.learnerContractVersions.babyB;
  const accepted = [babyA, babyB];
  if (config !== undefined) {
    accepted.push(
      `${config.babyA.track}.v${babyA}`,
      `${config.babyB.track}.v${babyB}`,
    );
  }
  return accepted;
}

export async function verifyExperimentRecord(
  bundleDir: string,
  manifest: RunManifest,
  bindings: ExperimentRecordBindings,
  accumulator: VerificationAccumulator,
): Promise<ExperimentRecordVerification> {
  const raw = await readCanonicalJsonFile(
    bundlePath(bundleDir, 'experiment-record.json'),
  );
  if (!raw.ok) {
    if (raw.code === 'missing-file') {
      return { present: false, historyLength: 0 };
    }
    if (raw.code === 'canonical-json-invalid') {
      accumulator.fail(
        'canonicalJsonValid',
        raw.code,
        `experiment-record.json: ${raw.detail}`,
      );
    } else {
      accumulator.failStructural(raw.code, `experiment-record.json: ${raw.detail}`);
    }
    return { present: true, historyLength: 0 };
  }

  const file = ExperimentRecordFileSchema.safeParse(raw.value);
  if (!file.success) {
    accumulator.failStructural(
      'schema-invalid',
      `experiment-record.json: ${formatIssues(file.error.issues)}`,
    );
    return { present: true, historyLength: 0 };
  }

  const history = file.data.history;
  const finalCheckpoint = bindings.checkpoints.at(-1);
  const checkpointHashes = new Set(
    bindings.checkpoints.map((checkpoint) =>
      normalizeHash(checkpoint.manifest.checkpointHash),
    ),
  );
  const contractVersions = acceptedLearnerContractVersions(
    manifest,
    bindings.config,
  );

  history.forEach((entry, index) => {
    const at = `experiment-record.json history[${String(index)}]`;
    const parsed = ExperimentRecordSchema.safeParse(entry);
    if (!parsed.success) {
      accumulator.failStructural(
        'experiment-record-invalid',
        `${at}: ${formatIssues(parsed.error.issues)}`,
      );
      return;
    }
    const record = parsed.data;
    const unknownFields = unknownFieldDetail(entry, record);
    if (unknownFields !== undefined) {
      accumulator.failStructural(
        'experiment-record-unknown-field',
        `${at}: ${unknownFields}`,
      );
    }
    if (record.recordVersion !== index + 1) {
      accumulator.failStructural(
        'experiment-record-version-gap',
        `${at}: expected recordVersion ${String(index + 1)}, found ${String(record.recordVersion)}`,
      );
    }
    if (record.runId !== manifest.runId) {
      accumulator.failStructural(
        'experiment-record-run-mismatch',
        `${at}: runId ${record.runId} does not match the run manifest`,
      );
    }
    if (record.experimentId !== manifest.experimentId) {
      accumulator.failStructural(
        'experiment-record-run-mismatch',
        `${at}: experimentId ${record.experimentId} does not match the run manifest`,
      );
    }
    if (normalizeHash(record.runConfigRef) !== normalizeHash(manifest.configurationHash)) {
      accumulator.failStructural(
        'experiment-record-configuration-mismatch',
        `${at}: runConfigRef ${record.runConfigRef} does not match the run configuration hash`,
      );
    }
    if (
      record.claimBoundaryStatement !==
      CLAIM_BOUNDARY_STATEMENTS[record.deploymentMode]
    ) {
      accumulator.failStructural(
        'experiment-record-claim-boundary-mismatch',
        `${at}: claimBoundaryStatement is not the verbatim SPEC §5.1/§5.2 sentence for ${record.deploymentMode}`,
      );
    }
    if (!contractVersions.includes(record.learnerContractVersion)) {
      accumulator.failStructural(
        'experiment-record-contract-version-mismatch',
        `${at}: learnerContractVersion ${record.learnerContractVersion} is not one of the run manifest's ${contractVersions.join(', ')}`,
      );
    }

    // SPEC §11.7/§11.9: a history entry may name any checkpoint of the run;
    // the current record names the final one (checked below).
    const ref = normalizeHash(record.checkpointManifestRef);
    if (ref !== GENESIS_HASH && (ref === undefined || !checkpointHashes.has(ref))) {
      accumulator.failStructural(
        'experiment-record-checkpoint-unknown',
        `${at}: checkpointManifestRef ${record.checkpointManifestRef} is not a checkpoint of this bundle`,
      );
    }
    if (
      !sameTx(record.anchorTxRef, UNANCHORED_TX_REF) &&
      !bindings.receipts.some((receipt) =>
        sameTx(receipt.transactionHash, record.anchorTxRef),
      )
    ) {
      accumulator.failStructural(
        'experiment-record-anchor-unknown',
        `${at}: anchorTxRef ${record.anchorTxRef} is not a transaction in anchors/base-receipts.json`,
      );
    }
    for (const hash of record.analysisAttachmentRefs ?? []) {
      if (!bindings.attachmentHashes.has(hash)) {
        accumulator.failStructural(
          'experiment-record-attachment-unknown',
          `${at}: analysisAttachmentRefs contains ${hash}, which is absent from analysis/index.json`,
        );
      }
    }
  });

  const last = history.at(-1);
  if (last !== undefined && canonicalJson(file.data.current) !== canonicalJson(last)) {
    accumulator.failStructural(
      'experiment-record-current-mismatch',
      'experiment-record.json: current is not the last history entry',
    );
  }

  const current = ExperimentRecordSchema.safeParse(file.data.current);
  if (current.success) {
    const currentAttachments = new Set(
      current.data.analysisAttachmentRefs ?? [],
    );
    for (const hash of bindings.attachmentHashes) {
      if (!currentAttachments.has(hash)) {
        accumulator.failStructural(
          'experiment-record-attachment-missing',
          `experiment-record.json current does not link attachment ${hash}`,
        );
      }
    }
    const ref = normalizeHash(current.data.checkpointManifestRef);
    const expected =
      finalCheckpoint === undefined
        ? undefined
        : normalizeHash(finalCheckpoint.manifest.checkpointHash);
    if (ref === GENESIS_HASH) {
      // A run created but never sealed, and an aborted run with no checkpoint
      // of its own, legitimately record the placeholder
      // (packages/orchestrator/src/nursery-runtime.ts), so this is not a
      // failure — but the record then names no evidence at all, and SPEC §15.1
      // makes the record and this report jointly authoritative, so the report
      // has to say so rather than stay silent.
      accumulator.gap(
        'experiment-record-checkpoint-placeholder',
        `experiment-record.json current: checkpointManifestRef is the genesis placeholder, so the record names no checkpoint of this bundle (final checkpoint is ${String(expected)})`,
      );
    } else if (expected === undefined || ref !== expected) {
      accumulator.failStructural(
        'experiment-record-final-checkpoint-mismatch',
        `experiment-record.json current: checkpointManifestRef ${current.data.checkpointManifestRef} is not the final checkpoint hash ${String(expected)}`,
      );
    }
  }

  return { present: true, historyLength: history.length };
}
