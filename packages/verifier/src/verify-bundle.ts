/**
 * The independent verifier (BACKLOG ALD-015) and the verification-report
 * generator (ALD-017).
 *
 * `verifyBundle` performs the twelve steps of LEDGER-INTEGRITY-DESIGN.md §14
 * against an exported evidence bundle and nothing else — no SQLite, no
 * runtime, no private keys, no network unless a {@link ChainReader} is
 * injected — and returns the SPECIFICATION.md §11.10 Verification Report,
 * which it also writes to `<bundleDir>/verification-report.json` (the
 * exporter never writes that file, docs/evidence-bundle-format.md §1, §9).
 *
 * The report is conservative by construction: a check reads `true` only when
 * the rule was evaluated everywhere it applies and held. `exitCode` is `1` on
 * any integrity failure, including an unanchored final ledger tail
 * (LEDGER §17) unless `allowUnanchored` downgrades it to a note.
 */
import { writeFile } from 'node:fs/promises';

import { canonicalJson, hashCanonical, hashRunId } from '@ald/hashing';
import {
  CLAIM_BOUNDARY_STATEMENTS,
  HASH_DOMAINS,
  RunConfigSchema,
  RunManifestSchema,
  VerificationReportSchema,
  type RunConfig,
  type RunManifest,
  type VerificationReport,
} from '@ald/types';

import { verifyAnchors, type ChainReader } from './anchors.js';
import {
  bundlePath,
  formatIssues,
  readCanonicalJsonFile,
  unknownFieldDetail,
} from './bundle-io.js';
import { VerificationAccumulator, ALLOWED_UNANCHORED_NOTE } from './checks.js';
import { verifyCheckpoints, verifyProofs } from './checkpoints.js';
import { verifyExperimentRecord } from './experiment-record.js';
import { verifyPromptBundle } from './prompts.js';
import { describeRedacted } from './redact.js';
import { loadStreams, verifyCrossBindings, type LoadedStreams } from './streams.js';
import { normalizeHash } from './values.js';

/** Version reported when a caller does not supply one. */
export const VERIFIER_VERSION = '0.1.0';

export interface VerifyBundleOptions {
  /** Recorded verbatim as `VerificationReport.verifierVersion`. */
  verifierVersion: string;
  /** Injected clock; must return an ISO-8601 timestamp with offset. */
  now: () => string;
  /** Optional independent RPC access for LEDGER §14 steps 10-11. */
  chainReader?: ChainReader | undefined;
  /** Report an unanchored tail without raising the exit code (LEDGER §1). */
  allowUnanchored?: boolean | undefined;
  /** `false` leaves `verification-report.json` untouched (default: write). */
  writeReport?: boolean | undefined;
}

export interface VerificationDetails {
  /** LEDGER §6 binding failures, one line each. */
  crossBindingFailures: string[];
  /** Verified event count per stream, keyed by stream name. */
  streamSizes: Record<string, number>;
  checkpointCount: number;
  /** Highest checkpoint sequence covered by a confirmed anchor. */
  anchoredThroughCheckpoint: number | null;
  proofFilesChecked: number;
  /** `true` when an independent RPC endpoint was consulted. */
  chainChecked: boolean;
  experimentRecordPresent: boolean;
}

export interface DetailedVerification {
  report: VerificationReport;
  details: VerificationDetails;
}

const UNKNOWN_RUN_ID = 'unknown-run';

function emptyDetails(): VerificationDetails {
  return {
    crossBindingFailures: [],
    streamSizes: {},
    checkpointCount: 0,
    anchoredThroughCheckpoint: null,
    proofFilesChecked: 0,
    chainChecked: false,
    experimentRecordPresent: false,
  };
}

/**
 * `finalVerifiedSizes` (SPEC §11.10) carries one entry per exported stream —
 * including the witness-committed unsigned `intervention` log — plus one per checkpoint tree
 * name, so a reader can compare committed tree sizes without knowing the
 * stream-to-tree mapping.
 */
function finalVerifiedSizes(streams: LoadedStreams): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const loaded of streams.values()) {
    sizes[loaded.stream] = loaded.size;
    if (loaded.declaration.treeName !== undefined) {
      sizes[loaded.declaration.treeName] = loaded.size;
    }
  }
  return sizes;
}

function buildReport(
  runId: string,
  checkedAt: string,
  accumulator: VerificationAccumulator,
  sizes: Record<string, number>,
  options: VerifyBundleOptions,
): VerificationReport {
  return VerificationReportSchema.parse({
    version: 1,
    runId,
    checkedAt,
    verifierVersion: options.verifierVersion,
    checks: accumulator.checks(),
    gaps: accumulator.gaps,
    forks: accumulator.forks,
    finalVerifiedSizes: sizes,
    exitCode: accumulator.exitCode(),
  });
}

/**
 * Writes the report next to the bundle it describes. A completed verification
 * is never discarded because the destination is unwritable (a read-only mount,
 * a published bundle owned by someone else): the failure is returned so the
 * caller can record it as a gap and still return the report (LEDGER §14 item
 * 12 requires a machine-readable report).
 */
async function persist(
  bundleDir: string,
  report: VerificationReport,
  options: VerifyBundleOptions,
): Promise<string | undefined> {
  if (options.writeReport === false) {
    return undefined;
  }
  try {
    await writeFile(
      bundlePath(bundleDir, 'verification-report.json'),
      `${canonicalJson(report)}\n`,
      'utf8',
    );
    return undefined;
  } catch (error) {
    return describeRedacted(error);
  }
}

/**
 * Persists the report and, when the write fails, rebuilds it with a
 * `report-write-failed` gap so the returned artifact says so. The gap is
 * informational: an unwritable directory is not an integrity failure of the
 * bundle, so a good bundle on a read-only mount still exits 0.
 */
async function persistOrNote(
  bundleDir: string,
  report: VerificationReport,
  runId: string,
  checkedAt: string,
  accumulator: VerificationAccumulator,
  sizes: Record<string, number>,
  options: VerifyBundleOptions,
): Promise<VerificationReport> {
  const failure = await persist(bundleDir, report, options);
  if (failure === undefined) {
    return report;
  }
  accumulator.gap(
    'report-write-failed',
    `verification-report.json could not be written: ${failure}`,
  );
  return buildReport(runId, checkedAt, accumulator, sizes, options);
}

/**
 * Compares one manifest field with its authoritative copy in the hash-bound
 * run configuration (bundle format §7: the manifest "binds the run"; the
 * exporter copies these fields verbatim from the `RunConfig`, so any
 * disagreement is proof of post-export tampering).
 */
function bindManifestField(
  accumulator: VerificationAccumulator,
  field: string,
  manifestValue: string | undefined,
  configValue: string | undefined,
  { hash = false }: { hash?: boolean } = {},
): void {
  const left = hash ? normalizeHash(manifestValue) : manifestValue;
  const right = hash ? normalizeHash(configValue) : configValue;
  if (left !== right) {
    accumulator.failStructural(
      'manifest-configuration-mismatch',
      `run-manifest.json ${field} ${String(manifestValue)} does not match configuration/run-config.json ${String(configValue)}`,
    );
  }
}

export interface ManifestAndConfiguration {
  manifest: RunManifest;
  /** `undefined` when `configuration/run-config.json` is unusable. */
  config?: RunConfig | undefined;
}

/** Step 1 of LEDGER §14 for the two files that bind the whole bundle. */
async function verifyManifestAndConfiguration(
  bundleDir: string,
  accumulator: VerificationAccumulator,
): Promise<ManifestAndConfiguration | undefined> {
  const raw = await readCanonicalJsonFile(bundlePath(bundleDir, 'run-manifest.json'));
  if (!raw.ok) {
    if (raw.code === 'canonical-json-invalid') {
      accumulator.fail('canonicalJsonValid', raw.code, `run-manifest.json: ${raw.detail}`);
    } else {
      accumulator.failStructural(raw.code, `run-manifest.json: ${raw.detail}`);
    }
    return undefined;
  }

  const parsed = RunManifestSchema.safeParse(raw.value);
  if (!parsed.success) {
    accumulator.failStructural(
      'schema-invalid',
      `run-manifest.json: ${formatIssues(parsed.error.issues)}`,
    );
    return undefined;
  }
  const manifest = parsed.data;

  // `run-manifest.json` is the document that binds the run (bundle format §7)
  // and is committed by no hash, so unbound content riding inside it is
  // rejected structurally rather than silently stripped by the schema.
  const manifestUnknownFields = unknownFieldDetail(raw.value, manifest);
  if (manifestUnknownFields !== undefined) {
    accumulator.failStructural(
      'manifest-unknown-field',
      `run-manifest.json: ${manifestUnknownFields}`,
    );
  }

  if (manifest.runIdHash !== hashRunId(manifest.runId)) {
    accumulator.failStructural(
      'run-id-hash-mismatch',
      `run-manifest.json: runIdHash ${manifest.runIdHash} is not the hash of runId ${manifest.runId}`,
    );
  }
  if (
    manifest.claimBoundaryStatement !==
    CLAIM_BOUNDARY_STATEMENTS[manifest.deploymentMode]
  ) {
    accumulator.failStructural(
      'claim-boundary-mismatch',
      `run-manifest.json: claimBoundaryStatement is not the verbatim SPEC §5.1/§5.2 sentence for ${manifest.deploymentMode}`,
    );
  }

  const configRaw = await readCanonicalJsonFile(
    bundlePath(bundleDir, 'configuration', 'run-config.json'),
  );
  if (!configRaw.ok) {
    if (configRaw.code === 'canonical-json-invalid') {
      accumulator.fail(
        'canonicalJsonValid',
        configRaw.code,
        `configuration/run-config.json: ${configRaw.detail}`,
      );
    } else {
      accumulator.failStructural(
        configRaw.code,
        `configuration/run-config.json: ${configRaw.detail}`,
      );
    }
    return { manifest };
  }

  const config = RunConfigSchema.safeParse(configRaw.value);
  if (!config.success) {
    accumulator.failStructural(
      'schema-invalid',
      `configuration/run-config.json: ${formatIssues(config.error.issues)}`,
    );
    return { manifest };
  }

  // Bundle format §7: `configurationHash` MUST equal the hash of
  // `configuration/run-config.json` — the file's own canonical bytes, not the
  // schema's projection of them, which would silently drop injected keys.
  const configurationHash = hashCanonical(HASH_DOMAINS.runConfig, configRaw.value);
  if (configurationHash !== normalizeHash(manifest.configurationHash)) {
    accumulator.failStructural(
      'configuration-hash-mismatch',
      `configuration/run-config.json hashes to ${configurationHash}, run-manifest.json declares ${manifest.configurationHash}`,
    );
  }
  const unknownFields = unknownFieldDetail(configRaw.value, config.data);
  if (unknownFields !== undefined) {
    accumulator.failStructural(
      'configuration-unknown-field',
      `configuration/run-config.json: ${unknownFields}`,
    );
  }
  if (config.data.runId !== manifest.runId) {
    accumulator.failStructural(
      'configuration-run-mismatch',
      `configuration/run-config.json runId ${config.data.runId} does not match the run manifest`,
    );
  }
  if (config.data.experimentId !== manifest.experimentId) {
    accumulator.failStructural(
      'configuration-run-mismatch',
      `configuration/run-config.json experimentId ${config.data.experimentId} does not match the run manifest`,
    );
  }
  if (config.data.deploymentMode !== manifest.deploymentMode) {
    accumulator.failStructural(
      'configuration-run-mismatch',
      `configuration/run-config.json deploymentMode ${config.data.deploymentMode} does not match the run manifest`,
    );
  }

  // The remaining provenance and lineage fields the exporter copies from the
  // configuration (packages/evidence/src/export.ts `buildRunManifest`).
  // SPEC §7.4 requires parent lineage to agree between the child RunConfig and
  // its run manifest; SPEC §15.1 makes protocolGitCommit/preRegistrationHash
  // the pre-registration binding. `learnerContractVersions` has no second copy
  // in the bundle and so cannot be cross-checked here.
  bindManifestField(
    accumulator,
    'promptBundleHash',
    manifest.promptBundleHash,
    config.data.promptBundleHash,
    { hash: true },
  );
  bindManifestField(
    accumulator,
    'scenarioBundleHash',
    manifest.scenarioBundleHash,
    config.data.scenarioBundleHash,
    { hash: true },
  );
  bindManifestField(
    accumulator,
    'preRegistrationHash',
    manifest.preRegistrationHash,
    config.data.preRegistrationHash,
    { hash: true },
  );
  bindManifestField(
    accumulator,
    'protocolGitCommit',
    manifest.protocolGitCommit,
    config.data.protocolGitCommit,
  );
  bindManifestField(
    accumulator,
    'parentRunId',
    manifest.parentRunId,
    config.data.parentRunId,
  );
  bindManifestField(
    accumulator,
    'derivedFromCheckpointHash',
    manifest.derivedFromCheckpointHash,
    config.data.derivedFromCheckpointHash,
    { hash: true },
  );

  return { manifest, config: config.data };
}

/**
 * LEDGER §17 "unanchored final ledger tail": every event beyond the sizes
 * committed by the last confirmed-anchored checkpoint, including the
 * witness-committed unsigned intervention stream.
 */
function reportUnanchoredTail(
  streams: LoadedStreams,
  committedSizes: Map<string, number>,
  accumulator: VerificationAccumulator,
  allowUnanchored: boolean,
): void {
  const suffix = allowUnanchored ? ` ${ALLOWED_UNANCHORED_NOTE}` : '';
  let reported = false;

  for (const loaded of streams.values()) {
    const treeName = loaded.declaration.treeName;
    if (treeName === undefined) {
      continue;
    }
    const committed = committedSizes.get(treeName) ?? 0;
    const tail = loaded.size - committed;
    if (tail > 0) {
      reported = true;
      accumulator.gap(
        'unanchored-tail',
        `${loaded.stream}: ${String(tail)} events${suffix}`,
      );
    }
  }

  if (reported) {
    accumulator.markUnanchoredTail(allowUnanchored);
  }
}

/** Full verification with the extra counters the CLI and tests report. */
export async function verifyBundleDetailed(
  bundleDir: string,
  options: VerifyBundleOptions,
): Promise<DetailedVerification> {
  const accumulator = new VerificationAccumulator();
  const allowUnanchored = options.allowUnanchored === true;
  const checkedAt = options.now();

  const bound = await verifyManifestAndConfiguration(bundleDir, accumulator);
  if (bound === undefined) {
    accumulator.markAllUnverified();
    const report = buildReport(UNKNOWN_RUN_ID, checkedAt, accumulator, {}, options);
    return {
      report: await persistOrNote(
        bundleDir,
        report,
        UNKNOWN_RUN_ID,
        checkedAt,
        accumulator,
        {},
        options,
      ),
      details: emptyDetails(),
    };
  }
  const { manifest, config } = bound;

  const streams = await loadStreams(bundleDir, manifest, accumulator);

  const crossBindingFailures = verifyCrossBindings(streams, {
    ledgerLagTurns: config?.ledgerLagTurns,
  });
  for (const failure of crossBindingFailures) {
    accumulator.failStructural('cross-binding', failure);
  }

  const checkpoints = await verifyCheckpoints(
    bundleDir,
    manifest,
    streams,
    accumulator,
  );
  const proofFilesChecked = await verifyProofs(
    bundleDir,
    checkpoints,
    streams,
    accumulator,
  );

  if (config !== undefined) {
    await verifyPromptBundle(bundleDir, manifest, config, checkpoints, accumulator);
  }

  const anchors = await verifyAnchors({
    bundleDir,
    checkpoints,
    accumulator,
    chainReader: options.chainReader,
    config,
    allowUnanchored,
  });

  const anchoredCheckpoint =
    anchors.anchoredThroughCheckpoint === null
      ? undefined
      : checkpoints.find(
          (checkpoint) => checkpoint.sequence === anchors.anchoredThroughCheckpoint,
        );
  const committedSizes = new Map<string, number>();
  for (const [treeName, tree] of anchoredCheckpoint?.trees ?? []) {
    committedSizes.set(treeName, tree.treeSize);
  }
  reportUnanchoredTail(streams, committedSizes, accumulator, allowUnanchored);

  const experimentRecord = await verifyExperimentRecord(
    bundleDir,
    manifest,
    { checkpoints, receipts: anchors.receipts, config },
    accumulator,
  );

  const sizes = finalVerifiedSizes(streams);
  const report = buildReport(
    manifest.runId,
    checkedAt,
    accumulator,
    sizes,
    options,
  );

  return {
    report: await persistOrNote(
      bundleDir,
      report,
      manifest.runId,
      checkedAt,
      accumulator,
      sizes,
      options,
    ),
    details: {
      crossBindingFailures,
      streamSizes: Object.fromEntries(
        [...streams.values()].map((loaded) => [loaded.stream, loaded.size]),
      ),
      checkpointCount: checkpoints.length,
      anchoredThroughCheckpoint: anchors.anchoredThroughCheckpoint,
      proofFilesChecked,
      chainChecked: anchors.chainChecked,
      experimentRecordPresent: experimentRecord.present,
    },
  };
}

/** SPEC §11.10 report for one exported bundle; `exitCode` 1 on any failure. */
export async function verifyBundle(
  bundleDir: string,
  options: VerifyBundleOptions,
): Promise<VerificationReport> {
  const { report } = await verifyBundleDetailed(bundleDir, options);
  return report;
}
