#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const outputPath = 'reports/research/data-claim-manifest.json';
const evidenceRoot = 'evidence';
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

function collection(path: string): { id: string; evidenceClass: string; verificationBasis: string; supportingReceipt: string | null } {
  if (path.startsWith('evidence/qualification/20260907-2228-e9a8abe/')) {
    return {
      id: 'historical-qualification-20260907',
      evidenceClass: 'historical-software-qualification',
      verificationBasis: 'historical verifier pass; current intervention-tree declaration is incompatible and the immutable export was not rewritten',
      supportingReceipt: 'reports/research/integrity-challenge-receipt.json',
    };
  }
  const mappings: Array<[string, string, string]> = [
    ['20260911-v06-97a33be-exact', 'mode-r-exact-v06', 'reports/research/mode-r-topology-receipt.json'],
    ['20260911-v07-6871f8d-exact', 'recurrent-exact-v07', 'reports/research/recurrent-baseline-receipt.json'],
    ['20260911-v08-886dd53-exact', 'carrier-exact-v08', 'reports/research/generative-carrier-learning-receipt.json'],
    ['20260911-v10-39a6e45-exact', 'controls-exact-v10', 'reports/research/study-control-lifecycle-receipt.json'],
    ['20260911-v11-b2b119c-exact', 'integrated-exact-v11', 'reports/research/integrated-software-candidate-receipt.json'],
    ['20260911-d07-resource-benchmark', 'resource-benchmark-d07', 'reports/research/seed-resource-ledger.json'],
  ];
  for (const [fragment, id, receipt] of mappings) {
    if (path.includes(fragment)) {
      return { id, evidenceClass: 'software-qualification', verificationBasis: 'production verification report plus tracked qualification receipt', supportingReceipt: receipt };
    }
  }
  const match = path.match(/evidence\/validation\/([^/]+)/u);
  return {
    id: `diagnostic-${match?.[1] ?? 'unclassified'}`,
    evidenceClass: 'failed-or-superseded-diagnostic',
    verificationBasis: 'preserved local diagnostic; excluded regardless of any bundle-level pass',
    supportingReceipt: null,
  };
}

function summarizeBundle(manifestPath: string) {
  const bundleRoot = dirname(manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const verificationPath = join(bundleRoot, 'verification-report.json');
  const verificationBytes = readFileSync(verificationPath);
  const verification = JSON.parse(verificationBytes.toString('utf8')) as {
    exitCode?: number;
    verifierVersion?: string;
    checks?: Record<string, boolean>;
  };
  const files = filesUnder(bundleRoot);
  const treeLines = files.map((path) => `${hash(readFileSync(path))}  ${relative(bundleRoot, path)}`);
  const grouping = collection(manifestPath);
  const preRegistrationHash = manifest['preRegistrationHash'];
  const recordedAnchorConfirmed = verification.checks?.['anchorTxConfirmed'] === true;
  return {
    collection: grouping.id,
    evidenceClass: grouping.evidenceClass,
    runId: manifest['runId'],
    experimentId: manifest['experimentId'],
    deploymentMode: manifest['deploymentMode'],
    softwareCommit: manifest['softwareCommit'],
    protocolGitCommit: manifest['protocolGitCommit'],
    preRegistrationHash: typeof preRegistrationHash === 'string' ? preRegistrationHash : null,
    bundlePath: bundleRoot,
    manifestSha256: hash(manifestBytes),
    verificationReportSha256: hash(verificationBytes),
    verifierVersion: verification.verifierVersion ?? null,
    verifierExitCode: verification.exitCode ?? null,
    recordedAnchorConfirmed,
    publicChainAnchorConfirmed: false,
    files: files.length,
    bytes: files.reduce((sum, path) => sum + statSync(path).size, 0),
    relativePathContentManifestSha256: hash(treeLines.join('\n')),
    researchInclusion: 'excluded',
    allowedClaimUse: grouping.evidenceClass === 'software-qualification'
      ? 'bounded-software-qualification-only'
      : grouping.evidenceClass === 'historical-software-qualification'
        ? 'historical-software-qualification-only'
        : 'failure-history-only',
    exclusionReasons: [
      'not collected under the D07 confirmatory or replication seed domain',
      'no authentic external registration binding',
      recordedAnchorConfirmed
        ? 'recorded confirmation is local/fake-chain qualification evidence, not a public-chain anchor'
        : 'no recorded anchor confirmation and no confirmed public-chain anchor',
      'not eligible for empirical hypothesis estimates',
    ],
  };
}

function buildManifest() {
  const manifestPaths = filesUnder(evidenceRoot).filter((path) => path.endsWith('/run-manifest.json'));
  const bundles = manifestPaths.map(summarizeBundle).sort((left, right) => left.bundlePath.localeCompare(right.bundlePath));
  const collections = [...new Set(bundles.map((bundle) => bundle.collection))].sort().map((id) => {
    const members = bundles.filter((bundle) => bundle.collection === id);
    const grouping = collection(members[0]?.bundlePath ?? '');
    return {
      id,
      evidenceClass: members[0]?.evidenceClass,
      bundles: members.length,
      bytes: members.reduce((sum, member) => sum + member.bytes, 0),
      allRecordedVerifierExitZero: members.every((member) => member.verifierExitCode === 0),
      recordedAnchorConfirmations: members.filter((member) => member.recordedAnchorConfirmed).length,
      confirmedPublicChainAnchors: 0,
      researchIncludedBundles: 0,
      supportingReceipt: grouping.supportingReceipt,
    };
  });
  return {
    schemaVersion: 1,
    capturedAt: '2026-09-11',
    classification: 'historical-evidence-inventory',
    researchFinding: false,
    scope: 'Every locally present exported run bundle at capture; raw events and private ledger content are represented only by hashes and counts.',
    totals: {
      bundles: bundles.length,
      collections: collections.length,
      bytes: bundles.reduce((sum, bundle) => sum + bundle.bytes, 0),
      recordedVerifierExitZero: bundles.filter((bundle) => bundle.verifierExitCode === 0).length,
      recordedAnchorConfirmations: bundles.filter((bundle) => bundle.recordedAnchorConfirmed).length,
      confirmedPublicChainAnchors: 0,
      pilotIncluded: 0,
      confirmatoryIncluded: 0,
      replicationIncluded: 0,
      researchIncluded: 0,
    },
    collections,
    bundles,
    claimRules: [
      'No listed bundle may support an empirical hypothesis estimate.',
      'Exact qualification receipts support only their explicitly bounded software claims.',
      'Historical and failed/superseded diagnostics remain visible but cannot inherit later verifier or software status.',
      'Any future pilot, confirmatory, or replication bundle requires a new manifest revision and prospective inclusion rule.',
    ],
  };
}

if (process.argv.includes('--write')) {
  const manifest = buildManifest();
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${outputPath}: ${String(manifest.totals.bundles)} bundles in ${String(manifest.totals.collections)} collections`);
} else {
  const manifest = JSON.parse(readFileSync(outputPath, 'utf8')) as ReturnType<typeof buildManifest>;
  if (manifest.schemaVersion !== 1 || manifest.researchFinding || manifest.totals.bundles !== manifest.bundles.length) {
    throw new Error('data/claim manifest has an invalid identity or total');
  }
  if (manifest.bundles.some((bundle) => bundle.researchInclusion !== 'excluded')) {
    throw new Error('historical non-study bundle is marked research-included');
  }
  if (manifest.totals.researchIncluded !== 0 || manifest.totals.pilotIncluded !== 0 || manifest.totals.confirmatoryIncluded !== 0 || manifest.totals.replicationIncluded !== 0) {
    throw new Error('historical inventory fabricates a study evidence class');
  }
  if (manifest.totals.confirmedPublicChainAnchors !== 0 || manifest.bundles.some((bundle) => bundle.publicChainAnchorConfirmed)) {
    throw new Error('local qualification receipt is mislabeled as a public-chain anchor');
  }
  const paths = new Set(manifest.bundles.map((bundle) => bundle.bundlePath));
  if (paths.size !== manifest.bundles.length) throw new Error('data/claim manifest repeats a bundle path');
  const grouped = manifest.collections.reduce((sum, entry) => sum + entry.bundles, 0);
  if (grouped !== manifest.totals.bundles) throw new Error('collection bundle counts do not reconcile');
  for (const entry of manifest.collections) {
    if (entry.supportingReceipt !== null) readFileSync(entry.supportingReceipt);
  }
  if (process.argv.includes('--live-evidence')) {
    const rebuilt = buildManifest();
    if (JSON.stringify(rebuilt) !== JSON.stringify(manifest)) {
      throw new Error('local evidence differs from the captured data/claim manifest');
    }
  }
  console.log(`data/claim manifest valid: ${String(manifest.totals.bundles)} bundles, ${String(manifest.totals.researchIncluded)} research-included`);
}
