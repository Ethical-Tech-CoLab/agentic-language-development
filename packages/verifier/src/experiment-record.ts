/**
 * `experiment-record.json` verification (SPECIFICATION.md §11.9, §13.2,
 * §15.1): the append-only versioned record of what the run claims, bound to
 * the run configuration and carrying the verbatim claim-boundary sentence of
 * SPEC §5.1/§5.2.
 *
 * The file is optional in a bundle (the exporter writes it only when the run
 * has at least one record), so absence is not a failure; a present file that
 * does not satisfy the rules is.
 */
import {
  CLAIM_BOUNDARY_STATEMENTS,
  ExperimentRecordFileSchema,
  ExperimentRecordSchema,
  type RunManifest,
} from '@ald/types';
import { canonicalJson } from '@ald/hashing';

import { bundlePath, formatIssues, readCanonicalJsonFile } from './bundle-io.js';
import type { VerificationAccumulator } from './checks.js';
import { normalizeHash } from './values.js';

export interface ExperimentRecordVerification {
  present: boolean;
  historyLength: number;
}

export async function verifyExperimentRecord(
  bundleDir: string,
  manifest: RunManifest,
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
  });

  const last = history.at(-1);
  if (last !== undefined && canonicalJson(file.data.current) !== canonicalJson(last)) {
    accumulator.failStructural(
      'experiment-record-current-mismatch',
      'experiment-record.json: current is not the last history entry',
    );
  }

  return { present: true, historyLength: history.length };
}
