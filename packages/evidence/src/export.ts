/**
 * Evidence bundle export (ALD-016).
 *
 * Writes the byte-level layout fixed by `docs/evidence-bundle-format.md`
 * (LEDGER-INTEGRITY-DESIGN.md §13, SPECIFICATION.md §13.2) from the
 * authoritative SQLite store, using nothing but the reader side of the
 * Evidence Writer. Every `*.json` file is RFC 8785 canonical JSON plus a
 * single newline and every `*.jsonl` line is the exact `canonical_json`
 * column stored at commit time, so exporting the same run twice without
 * intervening writes is byte-identical.
 *
 * The exporter never writes `verification-report.json` — that file belongs to
 * the independent verifier (ALD-015/ALD-017) — and never writes proof files;
 * it only creates the `proofs/` directories the Checkpoint Service fills in.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  AUXILIARY_TREES,
  assertClaimLabelsAllowed,
  BundleAttachmentIndexSchema,
  CLAIM_BOUNDARY_STATEMENTS,
  EVENT_STREAMS,
  HASH_DOMAINS,
  MANDATORY_TREES,
  RunConfigSchema,
  RunManifestSchema,
  STREAM_HASH_DOMAIN,
  STREAM_SIGNER,
  type EventStream,
  type EvidenceReader,
  type RunConfig,
  type RunManifest,
  type ModeROnlyClaimLabel,
  type PreRegistrationBinding,
  type RunMetadataRecord,
  type Sha256Hash,
  type SignerPublicKey,
  type StreamDeclaration,
} from '@ald/types';
import {
  canonicalJson,
  domainHash,
  encodeHash,
  parseCanonicalJson,
  sha256Bytes,
} from '@ald/hashing';

import { InvalidRequestError, UnknownRunError } from './errors.js';

/** File name of each exported stream (`docs/evidence-bundle-format.md` §1). */
const STREAM_FILES: Record<EventStream, string> = {
  'baby-a-ledger': 'baby-a-ledger.jsonl',
  'baby-b-ledger': 'baby-b-ledger.jsonl',
  channel: 'channel-transcript.jsonl',
  affect: 'affect-transcript.jsonl',
  audit: 'audit-ledger.jsonl',
  turns: 'turn-records.jsonl',
  intervention: 'intervention-log.jsonl',
};

/** Streams exported for every run, empty file included. */
const ALWAYS_EXPORTED: readonly EventStream[] = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'turns',
  'intervention',
];

/** Streams exported only when they carry at least one event. */
const CONDITIONAL_STREAMS: readonly EventStream[] = ['affect', 'audit'];

export interface LearnerContractText {
  /** `RunConfig.babyA.track` / `babyB.track` this text was used for. */
  track: string;
  version: string;
  /** Exact contract text, written verbatim to `prompts/`. */
  text: string;
}

export interface ExportBundleOptions {
  /** Commit of the exporting software, recorded in the run manifest. */
  softwareCommit: string;
  /** Contract texts for the tracks named by the run configuration. */
  learnerContracts: LearnerContractText[];
  /** Canonical policy artifacts keyed by their single-segment file name. */
  policyFiles?: Readonly<Record<string, unknown>>;
  /** Optional Research-Grade claims requested by a report/export surface. */
  claimLabels?: readonly ModeROnlyClaimLabel[];
  preRegistration?: PreRegistrationBinding;
  /** Allow writing into a directory that already contains files. */
  overwrite?: boolean;
  /** Reserved: the experiment record is never synthesized by the exporter. */
  experimentRecordFallback?: never;
}

/** Read surface the exporter needs; `SqliteEvidenceWriter` satisfies it. */
export type BundleReader = EvidenceReader & {
  readRunSigners(runId: string): SignerPublicKey[];
};

export interface RunManifestInput {
  metadata: RunMetadataRecord;
  config: RunConfig;
  signers: SignerPublicKey[];
  /** Streams actually written into the bundle, in export order. */
  streams: readonly EventStream[];
  softwareCommit: string;
  learnerContracts: LearnerContractText[];
  claimLabels?: readonly ModeROnlyClaimLabel[];
  preRegistration?: PreRegistrationBinding;
}

/** `sha256:`-prefixed lowercase form; `RunConfig` allows the bare hex form. */
function strictHash(value: string, field: string): Sha256Hash {
  const normalized = value.toLowerCase();
  const withPrefix = normalized.startsWith('sha256:')
    ? normalized
    : `sha256:${normalized}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(withPrefix)) {
    throw new InvalidRequestError(`${field} is not a SHA-256 hash: ${value}`);
  }
  return withPrefix;
}

function treeNameFor(stream: EventStream): string | undefined {
  if (stream === 'baby-a-ledger' || stream === 'baby-b-ledger' || stream === 'channel') {
    return MANDATORY_TREES[stream];
  }
  if (
    stream === 'affect' ||
    stream === 'audit' ||
    stream === 'turns' ||
    stream === 'intervention'
  ) {
    return AUXILIARY_TREES[stream];
  }
  return undefined;
}

function streamDeclaration(stream: EventStream): StreamDeclaration {
  const treeName = treeNameFor(stream);
  return {
    stream,
    file: STREAM_FILES[stream],
    hashDomain: STREAM_HASH_DOMAIN[stream],
    ...(stream === 'intervention' ? {} : { signerDomain: STREAM_SIGNER[stream] }),
    ...(treeName === undefined ? {} : { treeName }),
  };
}

function contractFor(
  contracts: LearnerContractText[],
  track: string,
): LearnerContractText {
  const contract = contracts.find((candidate) => candidate.track === track);
  if (!contract) {
    throw new InvalidRequestError(
      `No learner contract text supplied for track ${track}`,
    );
  }
  return contract;
}

/**
 * Pure builder for `run-manifest.json` (`docs/evidence-bundle-format.md` §7).
 * Exposed separately so the verifier tests and the checkpoint service can
 * rebuild a manifest without touching the filesystem.
 */
export function buildRunManifest(input: RunManifestInput): RunManifest {
  const { config, metadata } = input;
  assertClaimLabelsAllowed(
    metadata.deploymentMode,
    input.claimLabels ?? [],
  );
  const manifest: RunManifest = {
    version: 1,
    runId: metadata.runId,
    runIdHash: domainHash(HASH_DOMAINS.runId, metadata.runId),
    experimentId: config.experimentId,
    deploymentMode: metadata.deploymentMode,
    claimBoundaryStatement: CLAIM_BOUNDARY_STATEMENTS[metadata.deploymentMode],
    ...(input.claimLabels === undefined || input.claimLabels.length === 0
      ? {}
      : { claimLabels: [...input.claimLabels] }),
    configurationHash: strictHash(metadata.configurationHash, 'configurationHash'),
    scenarioBundleHash: strictHash(config.scenarioBundleHash, 'scenarioBundleHash'),
    promptBundleHash: strictHash(config.promptBundleHash, 'promptBundleHash'),
    protocolGitCommit: config.protocolGitCommit,
    preRegistrationHash: strictHash(
      config.preRegistrationHash,
      'preRegistrationHash',
    ),
    ...(input.preRegistration === undefined
      ? {}
      : { preRegistration: input.preRegistration }),
    softwareCommit: input.softwareCommit,
    createdAt: metadata.createdAt,
    ...(metadata.parentRunId === null ? {} : { parentRunId: metadata.parentRunId }),
    ...(metadata.derivedFromCheckpointHash === null
      ? {}
      : {
          derivedFromCheckpointHash: strictHash(
            metadata.derivedFromCheckpointHash,
            'derivedFromCheckpointHash',
          ),
        }),
    ...(config.babyA.initialPolicyRef === undefined ||
    config.babyB.initialPolicyRef === undefined
      ? {}
      : {
          initialPolicyRefs: {
            babyA: config.babyA.initialPolicyRef,
            babyB: config.babyB.initialPolicyRef,
          },
        }),
    learnerContractVersions: {
      babyA: contractFor(input.learnerContracts, config.babyA.track).version,
      babyB: contractFor(input.learnerContracts, config.babyB.track).version,
    },
    signers: input.signers.map((signer) => ({
      domain: signer.domain,
      keyId: signer.keyId,
      publicKey: signer.publicKey,
    })),
    streams: input.streams.map(streamDeclaration),
  };

  return RunManifestSchema.parse(manifest);
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, 'utf8');
}

async function assertWritableDirectory(
  outputDir: string,
  overwrite: boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return;
  }
  if (entries.length > 0 && !overwrite) {
    throw new InvalidRequestError(
      `Export directory ${outputDir} is not empty; pass overwrite to reuse it`,
    );
  }
}

/**
 * Exports one run into `outputDir`, returning the manifest that was written.
 */
export async function exportRunBundle(
  reader: BundleReader,
  runId: string,
  outputDir: string,
  options: ExportBundleOptions,
): Promise<RunManifest> {
  const metadata = reader.readRunMetadata(runId);
  if (!metadata) {
    throw new UnknownRunError(runId);
  }
  await assertWritableDirectory(outputDir, options.overwrite === true);

  const config = RunConfigSchema.parse(JSON.parse(metadata.configurationJson));
  const events = new Map(
    EVENT_STREAMS.map((stream) => [stream, reader.readEvents(runId, stream)]),
  );
  const exported = EVENT_STREAMS.filter(
    (stream) =>
      ALWAYS_EXPORTED.includes(stream) ||
      (CONDITIONAL_STREAMS.includes(stream) &&
        (events.get(stream)?.length ?? 0) > 0),
  );

  const manifest = buildRunManifest({
    metadata,
    config,
    signers: reader.readRunSigners(runId),
    streams: exported,
    softwareCommit: options.softwareCommit,
    learnerContracts: options.learnerContracts,
    claimLabels: options.claimLabels,
    preRegistration: options.preRegistration,
  });

  for (const directory of [
    outputDir,
    join(outputDir, 'checkpoints'),
    join(outputDir, 'proofs', 'inclusion'),
    join(outputDir, 'proofs', 'consistency'),
    join(outputDir, 'anchors'),
    join(outputDir, 'configuration'),
    join(outputDir, 'prompts'),
    ...(options.policyFiles === undefined ? [] : [join(outputDir, 'policies')]),
    join(outputDir, 'analysis'),
  ]) {
    await mkdir(directory, { recursive: true });
  }

  await writeCanonical(join(outputDir, 'run-manifest.json'), manifest);

  for (const stream of exported) {
    const lines = (events.get(stream) ?? []).map((event) => event.canonicalJson);
    await writeFile(
      join(outputDir, STREAM_FILES[stream]),
      lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      'utf8',
    );
  }

  for (const checkpoint of reader.readCheckpoints(runId)) {
    await writeCanonical(
      join(
        outputDir,
        'checkpoints',
        `${String(checkpoint.checkpointSequence).padStart(6, '0')}.json`,
      ),
      checkpoint,
    );
  }

  await writeCanonical(
    join(outputDir, 'anchors', 'base-receipts.json'),
    reader.readAnchorReceipts(runId),
  );
  await writeCanonical(
    join(outputDir, 'configuration', 'run-config.json'),
    config,
  );

  for (const track of [config.babyA.track, config.babyB.track]) {
    const contract = contractFor(options.learnerContracts, track);
    await writeFile(
      join(
        outputDir,
        'prompts',
        `learner-contract.${contract.track}.v${contract.version}.md`,
      ),
      contract.text,
      'utf8',
    );
  }

  for (const [file, policy] of Object.entries(options.policyFiles ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      file.length === 0 ||
      file.includes('/') ||
      file.includes('\\') ||
      !file.endsWith('.json')
    ) {
      throw new InvalidRequestError(
        `Policy artifact name must be a single JSON file segment: ${file}`,
      );
    }
    await writeCanonical(join(outputDir, 'policies', file), policy);
  }

  const attachments = reader.readAnalysisAttachments(runId);
  for (const attachment of attachments) {
    parseCanonicalJson(attachment.canonicalJson);
    const bytes = `${attachment.canonicalJson}\n`;
    const actualHash = encodeHash(sha256Bytes(Buffer.from(bytes, 'utf8')));
    if (actualHash !== attachment.descriptor.sha256) {
      throw new InvalidRequestError(
        `Analysis attachment ${attachment.descriptor.path} hashes to ${actualHash}, stored descriptor declares ${attachment.descriptor.sha256}`,
      );
    }
    const path = join(outputDir, attachment.descriptor.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, 'utf8');
  }
  await writeCanonical(
    join(outputDir, 'analysis', 'index.json'),
    BundleAttachmentIndexSchema.parse({
      version: 1,
      runId,
      attachments: attachments.map((attachment) => attachment.descriptor),
    }),
  );

  const records = reader.readExperimentRecords(runId);
  const current = records.at(-1);
  if (current) {
    await writeCanonical(join(outputDir, 'experiment-record.json'), {
      current,
      history: records,
    });
  }

  return manifest;
}
