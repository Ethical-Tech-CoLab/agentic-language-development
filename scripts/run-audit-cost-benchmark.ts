#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join, relative } from 'node:path';

import { verifyBundleDetailed } from '../packages/verifier/src/index.js';

const protocolPath = 'protocols/audit-cost-utility.v1.json';
const receiptPath = 'reports/research/audit-cost-utility-receipt.json';
const inventoryPath = 'reports/research/data-claim-manifest.json';
const integrityReceiptPath = 'reports/research/integrity-challenge-receipt.json';
const rustAuditor = '.artifacts/cargo-target/release/ald-integrity-auditor';
const typescriptVerifier = 'packages/verifier/bin/ald-verify.js';
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

interface ProtocolBundle {
  runId: string;
  path: string;
  capturedTreeSha256: string;
}

interface Protocol {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  inputCommit: string;
  inputVersion: string;
  bundles: ProtocolBundle[];
  timing: {
    warmupIterationsPerBundleAndVerifier: number;
    measuredIterationsPerBundleAndVerifier: number;
    ordinaryHashMeasuredIterationsPerBundle: number;
  };
  utility: {
    sourceReceipt: string;
    prespecifiedMutationCases: string[];
    implementations: string[];
  };
}

interface TimingSummary {
  samples: number;
  medianMs: number;
  p95Ms: number;
  minimumMs: number;
  maximumMs: number;
}

interface StorageSummary {
  events: number;
  turns: number;
  payloadLowerBoundBytes: number;
  ordinaryLogProxyBytes: number;
  signedStreamBytes: number;
  integrityCoreBytes: number;
  policyStateBytes: number;
  experimentMetadataBytes: number;
  analysisBytes: number;
  otherVerifierInputBytes: number;
  verifierInputBundleBytes: number;
  verificationReportBytes: number;
  capturedDirectoryBytes: number;
  signedToOrdinaryRatio: number;
  verifierInputToOrdinaryRatio: number;
}

interface BenchmarkBundleRow {
  runId: string;
  bundlePath: string;
  capturedTreeSha256: string;
  verifierInputTreeSha256: string;
  storage: StorageSummary;
  timings: Record<string, TimingSummary>;
  coverage: {
    typescriptProductionVerifier: {
      streamEvents: number;
      checkpoints: number;
      proofFilesChecked: number;
      experimentRecordPresent: boolean;
      chainChecked: boolean;
    };
    rustIndependentAuditor: {
      streamEvents: number;
      checkpoints: number;
      attachments: number;
      proofFilesChecked: number;
      chainChecked: boolean;
    };
  };
  disposition: string;
}

interface RustReport {
  integrityPass: boolean;
  anchored: boolean;
  eventCount: number;
  checkpointCount: number;
  attachmentCount: number;
}

interface BenchmarkReceipt {
  schemaVersion: number;
  classification: string;
  researchFinding: boolean;
  protocolSha256: string;
  bundles: BenchmarkBundleRow[];
  utility: {
    challenges: number;
    observedRejections: number;
  };
  publicChainAnchor: {
    status: string;
    transactions: number;
  };
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function summarize(samples: number[]): TimingSummary {
  if (samples.length === 0) throw new Error('cannot summarize an empty timing sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const medianIndex = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[medianIndex - 1] ?? 0) + (sorted[medianIndex] ?? 0)) / 2
    : (sorted[medianIndex] ?? 0);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
  return {
    samples: sorted.length,
    medianMs: round(median),
    p95Ms: round(p95),
    minimumMs: round(sorted[0] ?? 0),
    maximumMs: round(sorted.at(-1) ?? 0),
  };
}

function timed(action: () => void): number {
  const start = process.hrtime.bigint();
  action();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function verifierInputFiles(bundlePath: string): string[] {
  return filesUnder(bundlePath).filter((path) => relative(bundlePath, path) !== 'verification-report.json');
}

function hashInputTree(bundlePath: string): string {
  const digest = createHash('sha256');
  for (const path of verifierInputFiles(bundlePath)) {
    digest.update(relative(bundlePath, path));
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function classifyInput(relativePath: string): Exclude<keyof StorageSummary, 'events' | 'turns' | 'payloadLowerBoundBytes' | 'ordinaryLogProxyBytes' | 'signedStreamBytes' | 'verifierInputBundleBytes' | 'verificationReportBytes' | 'capturedDirectoryBytes' | 'signedToOrdinaryRatio' | 'verifierInputToOrdinaryRatio'> {
  if (relativePath === 'run-manifest.json' || relativePath.startsWith('checkpoints/') || relativePath.startsWith('proofs/') || relativePath.startsWith('anchors/')) return 'integrityCoreBytes';
  if (relativePath.startsWith('policies/')) return 'policyStateBytes';
  if (relativePath === 'experiment-record.json' || relativePath.startsWith('configuration/') || relativePath.startsWith('prompts/')) return 'experimentMetadataBytes';
  if (relativePath.startsWith('analysis/')) return 'analysisBytes';
  return 'otherVerifierInputBytes';
}

function storageFor(bundlePath: string): StorageSummary {
  const manifest = JSON.parse(readFileSync(join(bundlePath, 'run-manifest.json'), 'utf8')) as {
    streams: Array<{ file: string; stream: string }>;
  };
  const streamFiles = new Set(manifest.streams.map((stream) => stream.file));
  let events = 0;
  let turns = 0;
  let payloadLowerBoundBytes = 0;
  let ordinaryLogProxyBytes = 0;
  let signedStreamBytes = 0;
  for (const stream of manifest.streams) {
    const path = join(bundlePath, stream.file);
    signedStreamBytes += statSync(path).size;
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    events += lines.length;
    if (stream.stream === 'turns') turns = lines.length;
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      payloadLowerBoundBytes += Buffer.byteLength(`${JSON.stringify(event['content'])}\n`);
      const proxy: Record<string, unknown> = {
        stream: stream.stream,
        sequence: event['sequence'],
      };
      if (event['turn'] !== undefined) proxy['turn'] = event['turn'];
      proxy['eventType'] = event['eventType'];
      proxy['content'] = event['content'];
      ordinaryLogProxyBytes += Buffer.byteLength(`${JSON.stringify(proxy)}\n`);
    }
  }

  const categoryBytes = {
    integrityCoreBytes: 0,
    policyStateBytes: 0,
    experimentMetadataBytes: 0,
    analysisBytes: 0,
    otherVerifierInputBytes: 0,
  };
  let verifierInputBundleBytes = 0;
  for (const path of verifierInputFiles(bundlePath)) {
    const file = relative(bundlePath, path);
    const bytes = statSync(path).size;
    verifierInputBundleBytes += bytes;
    if (!streamFiles.has(file)) categoryBytes[classifyInput(file)] += bytes;
  }
  const verificationReport = join(bundlePath, 'verification-report.json');
  const verificationReportBytes = statSync(verificationReport).size;
  const capturedDirectoryBytes = verifierInputBundleBytes + verificationReportBytes;
  const categorized = signedStreamBytes + Object.values(categoryBytes).reduce((sum, value) => sum + value, 0);
  if (categorized !== verifierInputBundleBytes) throw new Error(`storage categories do not reconcile for ${bundlePath}`);

  return {
    events,
    turns,
    payloadLowerBoundBytes,
    ordinaryLogProxyBytes,
    signedStreamBytes,
    ...categoryBytes,
    verifierInputBundleBytes,
    verificationReportBytes,
    capturedDirectoryBytes,
    signedToOrdinaryRatio: round(signedStreamBytes / ordinaryLogProxyBytes, 6),
    verifierInputToOrdinaryRatio: round(verifierInputBundleBytes / ordinaryLogProxyBytes, 6),
  };
}

function runTypeScript(bundlePath: string): void {
  const output = execFileSync(process.execPath, [
    typescriptVerifier,
    bundlePath,
    '--allow-unanchored',
    '--json',
    '--no-report',
    '--verifier-version',
    'audit-cost-v1',
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const report = JSON.parse(output) as { exitCode?: number; gaps?: string[] };
  if (report.exitCode !== 0 || !report.gaps?.some((gap) => gap.includes('unanchored-tail'))) {
    throw new Error(`TypeScript verifier did not return the expected bounded local pass for ${bundlePath}`);
  }
}

function runRust(bundlePath: string): RustReport {
  const output = execFileSync(rustAuditor, [bundlePath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const report = JSON.parse(output) as RustReport;
  if (report.integrityPass !== true || report.anchored !== false) {
    throw new Error(`Rust auditor did not return the expected unanchored local pass for ${bundlePath}`);
  }
  return report;
}

function aggregateStorage(rows: StorageSummary[]): StorageSummary {
  const sums = rows.reduce((result, row) => {
    for (const [key, value] of Object.entries(row)) {
      if (!key.endsWith('Ratio')) result[key] = (result[key] ?? 0) + value;
    }
    return result;
  }, {} as Record<string, number>);
  return {
    ...(sums as unknown as Omit<StorageSummary, 'signedToOrdinaryRatio' | 'verifierInputToOrdinaryRatio'>),
    signedToOrdinaryRatio: round((sums['signedStreamBytes'] ?? 0) / (sums['ordinaryLogProxyBytes'] ?? 1), 6),
    verifierInputToOrdinaryRatio: round((sums['verifierInputBundleBytes'] ?? 0) / (sums['ordinaryLogProxyBytes'] ?? 1), 6),
  };
}

function validateReceipt(receipt: BenchmarkReceipt, protocol: Protocol, protocolSha256: string): void {
  if (receipt.schemaVersion !== 1 || receipt.classification !== 'software-qualification-benchmark' || receipt.researchFinding !== false) throw new Error('invalid receipt identity');
  if (receipt.protocolSha256 !== protocolSha256) throw new Error('protocol hash mismatch');
  if (receipt.publicChainAnchor.status !== 'not-measured' || receipt.publicChainAnchor.transactions !== 0) throw new Error('public-chain boundary is misstated');
  if (receipt.utility.observedRejections !== protocol.utility.prespecifiedMutationCases.length * protocol.utility.implementations.length) throw new Error('utility rejection count does not reconcile');
  if (receipt.utility.challenges !== protocol.utility.prespecifiedMutationCases.length * protocol.utility.implementations.length) throw new Error('utility challenge count does not reconcile');
  if (!Array.isArray(receipt.bundles) || receipt.bundles.length !== protocol.bundles.length) throw new Error('bundle count mismatch');
  for (const bundle of receipt.bundles) {
    const storage = bundle.storage;
    const categories = storage.signedStreamBytes + storage.integrityCoreBytes + storage.policyStateBytes + storage.experimentMetadataBytes + storage.analysisBytes + storage.otherVerifierInputBytes;
    if (categories !== storage.verifierInputBundleBytes) throw new Error(`stored categories do not reconcile for ${String(bundle.runId)}`);
    if (storage.verifierInputBundleBytes + storage.verificationReportBytes !== storage.capturedDirectoryBytes) throw new Error(`captured byte total does not reconcile for ${String(bundle.runId)}`);
    for (const timing of Object.values(bundle.timings as Record<string, TimingSummary>)) {
      if (timing.samples <= 0 || timing.minimumMs > timing.medianMs || timing.medianMs > timing.maximumMs || timing.p95Ms > timing.maximumMs) throw new Error(`invalid timing order for ${String(bundle.runId)}`);
    }
    if (bundle.coverage.typescriptProductionVerifier.proofFilesChecked <= 0 || bundle.coverage.rustIndependentAuditor.proofFilesChecked !== 0) throw new Error(`verifier coverage distinction is missing for ${String(bundle.runId)}`);
  }
}

const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes.toString('utf8')) as Protocol;
const protocolSha256 = hash(protocolBytes);

if (!process.argv.includes('--write')) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as BenchmarkReceipt;
  validateReceipt(receipt, protocol, protocolSha256);
  console.log(`audit-cost receipt valid: ${String(receipt.bundles.length)} bundles, ${String(receipt.utility.observedRejections)}/${String(receipt.utility.challenges)} recorded mutation rejections, public anchor not measured`);
  process.exit(0);
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
  bundles: Array<{ runId: string; bundlePath: string; relativePathContentManifestSha256: string }>;
};
const integrityReceiptBytes = readFileSync(integrityReceiptPath);
const integrityReceipt = JSON.parse(integrityReceiptBytes.toString('utf8')) as {
  freshExportChallenge: { mutationsRejectedByBoth: string[] };
  implementations: string[];
};
for (const expected of protocol.utility.prespecifiedMutationCases) {
  if (!integrityReceipt.freshExportChallenge.mutationsRejectedByBoth.includes(expected)) throw new Error(`integrity receipt lacks mutation ${expected}`);
}
for (const expected of protocol.utility.implementations) {
  if (!integrityReceipt.implementations.includes(expected)) throw new Error(`integrity receipt lacks implementation ${expected}`);
}

const rows = [];
for (const bundle of protocol.bundles) {
  const captured = inventory.bundles.find((entry) => entry.runId === bundle.runId && entry.bundlePath === bundle.path);
  if (captured?.relativePathContentManifestSha256 !== bundle.capturedTreeSha256) throw new Error(`inventory identity mismatch for ${bundle.runId}`);
  const before = hashInputTree(bundle.path);
  const typescriptCoverage = await verifyBundleDetailed(bundle.path, {
    verifierVersion: 'audit-cost-v1-coverage',
    now: () => '2026-09-11T00:00:00.000Z',
    writeReport: false,
    allowUnanchored: true,
  });
  if (typescriptCoverage.report.exitCode !== 0) throw new Error(`TypeScript coverage pass failed for ${bundle.runId}`);
  const rustCoverage = runRust(bundle.path);
  for (let index = 0; index < protocol.timing.warmupIterationsPerBundleAndVerifier; index += 1) {
    hashInputTree(bundle.path);
    runTypeScript(bundle.path);
    runRust(bundle.path);
  }
  const ordinaryHashSamples = Array.from({ length: protocol.timing.ordinaryHashMeasuredIterationsPerBundle }, () => timed(() => { hashInputTree(bundle.path); }));
  const typescriptSamples = Array.from({ length: protocol.timing.measuredIterationsPerBundleAndVerifier }, () => timed(() => { runTypeScript(bundle.path); }));
  const rustSamples = Array.from({ length: protocol.timing.measuredIterationsPerBundleAndVerifier }, () => timed(() => { runRust(bundle.path); }));
  const after = hashInputTree(bundle.path);
  if (before !== after) throw new Error(`benchmark mutated verifier inputs for ${bundle.runId}`);
  rows.push({
    runId: bundle.runId,
    bundlePath: bundle.path,
    capturedTreeSha256: bundle.capturedTreeSha256,
    verifierInputTreeSha256: before,
    storage: storageFor(bundle.path),
    timings: {
      ordinaryWholeInputSha256: summarize(ordinaryHashSamples),
      typescriptProductionVerifier: summarize(typescriptSamples),
      rustIndependentAuditor: summarize(rustSamples),
    },
    coverage: {
      typescriptProductionVerifier: {
        streamEvents: Object.values(typescriptCoverage.details.streamSizes).reduce((sum, value) => sum + value, 0),
        checkpoints: typescriptCoverage.details.checkpointCount,
        proofFilesChecked: typescriptCoverage.details.proofFilesChecked,
        experimentRecordPresent: typescriptCoverage.details.experimentRecordPresent,
        chainChecked: typescriptCoverage.details.chainChecked,
      },
      rustIndependentAuditor: {
        streamEvents: rustCoverage.eventCount,
        checkpoints: rustCoverage.checkpointCount,
        attachments: rustCoverage.attachmentCount,
        proofFilesChecked: 0,
        chainChecked: false,
      },
    },
    disposition: 'accepted-local-unanchored-by-both-verifiers',
  });
}

const receipt = {
  schemaVersion: 1,
  classification: 'software-qualification-benchmark',
  researchFinding: false,
  capturedAt: '2026-09-11',
  protocolSha256,
  inputCandidate: {
    commit: protocol.inputCommit,
    version: protocol.inputVersion,
    typescriptVerifierEntryPointSha256: hash(readFileSync(typescriptVerifier)),
    typescriptVerifierDistTreeSha256: hashInputTree('packages/verifier/dist'),
    rustAuditorSha256: hash(readFileSync(rustAuditor)),
  },
  host: {
    platform: platform(),
    release: release(),
    architecture: process.arch,
    logicalCpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    node: process.version,
  },
  method: {
    processStartupIncludedForBothVerifiers: true,
    filesystemCacheControlled: false,
    parallelism: 'serial',
    timingInterpretation: 'descriptive-single-host-only',
  },
  bundles: rows,
  aggregateStorage: aggregateStorage(rows.map((row) => row.storage)),
  utility: {
    sourceReceipt: protocol.utility.sourceReceipt,
    sourceReceiptSha256: hash(integrityReceiptBytes),
    mutationCases: protocol.utility.prespecifiedMutationCases,
    implementations: protocol.utility.implementations,
    challenges: protocol.utility.prespecifiedMutationCases.length * protocol.utility.implementations.length,
    observedRejections: protocol.utility.prespecifiedMutationCases.length * protocol.utility.implementations.length,
    unchangedExportAcceptedByBoth: true,
    interpretation: 'one deterministic fixture per mutation and implementation; not a detector-sensitivity estimate',
  },
  publicChainAnchor: {
    status: 'not-measured',
    transactions: 0,
    latencyMs: null,
    fee: null,
    reason: 'The qualification bundles are unanchored, no RPC was supplied, and no public transaction was authorized.',
  },
  limitations: [
    'All bundles are software qualifications excluded from empirical hypothesis estimates.',
    'The ordinary-log proxy is a deterministic storage model, not a separately implemented logging system.',
    'Hash timing assumes a trusted prior digest and does not validate signatures, sequence, lineage, receipts, or semantic truth.',
    'Verifier timing is descriptive for one host and includes process startup; filesystem cache state was not controlled.',
    'Full-bundle storage includes policy snapshots and research metadata, so the ratio over ordinary logs is not cryptographic overhead alone.',
    'No RPC lookup, public-chain confirmation, transaction latency, or transaction fee was measured.',
  ],
};
validateReceipt(receipt, protocol, protocolSha256);
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`wrote ${receiptPath}: ${String(rows.length)} bundles, ${String(receipt.utility.observedRejections)}/${String(receipt.utility.challenges)} recorded mutation rejections`);
